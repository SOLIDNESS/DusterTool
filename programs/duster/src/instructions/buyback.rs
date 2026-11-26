//! Buyback: odbior oplat z poola, podzial i odkup DUSTER dla stakujacych.
//!
//! Instrukcje moze wywolac kazdy (placi tylko oplate sieciowa), ale nie czesciej
//! niz co `buyback_interval`. Nikt nie decyduje o podziale: jest zapisany w
//! konfiguracji i wykonywany w calosci przez program.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, spl_token::native_mint, Token, TokenAccount};

use crate::cp_amm;
use crate::errors::DusterError;
use crate::math::{bps_of, unreleased_at};
use crate::state::*;

#[derive(Accounts)]
pub struct Buyback<'info> {
    /// Dowolny portfel; placi oplate sieciowa.
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.duster_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, address = config.stake_vault)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.fee_wsol)]
    pub fee_wsol: Box<Account<'info, TokenAccount>>,
    /// Konto wSOL nalezace do portfela treasury.
    #[account(mut, token::mint = native_mint::ID, token::authority = config.treasury)]
    pub treasury_wsol: Box<Account<'info, TokenAccount>>,

    /// CHECK: staly adres wladzy pooli cp-amm.
    #[account(address = cp_amm::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: pool z konfiguracji.
    #[account(mut, address = config.pool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: pozycja LP z konfiguracji.
    #[account(mut, address = config.position)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: konto z NFT pozycji; cp-amm sprawdza, ze program jest wlascicielem albo delegatem.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: skarbiec tokena A poola, sprawdzany przez cp-amm.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: skarbiec tokena B poola, sprawdzany przez cp-amm.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: mint DUSTER z konfiguracji.
    #[account(address = config.duster_mint)]
    pub duster_mint: UncheckedAccount<'info>,
    /// CHECK: mint wSOL.
    #[account(address = native_mint::ID)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: konto zdarzen cp-amm, sprawdzane przez cp-amm.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: program cp-amm.
    #[account(address = cp_amm::ID)]
    pub cp_amm_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct BuybackExecuted {
    pub claimed_lamports: u64,
    pub treasury_lamports: u64,
    pub spent_lamports: u64,
    pub duster_bought: u64,
    pub pending_staker_lamports: u64,
    pub timestamp: i64,
}

pub fn buyback(ctx: Context<Buyback>, min_duster_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let c = &ctx.accounts.config;
        require!(!c.paused, DusterError::Paused);
        require!(
            now >= c.last_buyback.saturating_add(c.buyback_interval),
            DusterError::BuybackTooEarly
        );
    }

    let mint = ctx.accounts.config.duster_mint;
    let bump = [ctx.accounts.config.bump];
    let seeds: &[&[u8]] = &[CONFIG_SEED, mint.as_ref(), &bump];
    let signer: &[&[&[u8]]] = &[seeds];

    // 1. Odbior oplat z pozycji LP. Pool zbiera oplaty tylko w SOL, ale gdyby
    //    kiedykolwiek pojawily sie w DUSTER, trafia do skarbca stakingu jako nagroda.
    let wsol_before = ctx.accounts.fee_wsol.amount;
    let vault_before = ctx.accounts.stake_vault.amount;
    cp_amm::claim_position_fee(
        cp_amm::ClaimPositionFee {
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_account: ctx.accounts.stake_vault.to_account_info(),
            token_b_account: ctx.accounts.fee_wsol.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            token_a_mint: ctx.accounts.duster_mint.to_account_info(),
            token_b_mint: ctx.accounts.wsol_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            signer: ctx.accounts.config.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.cp_amm_program.to_account_info(),
        },
        signer,
    )?;
    ctx.accounts.fee_wsol.reload()?;
    ctx.accounts.stake_vault.reload()?;
    let claimed = ctx.accounts.fee_wsol.amount.saturating_sub(wsol_before);
    let mut bought = ctx.accounts.stake_vault.amount.saturating_sub(vault_before);

    // 2. Podzial: czesc stakujacych czeka na odkup, reszta idzie od razu do treasury.
    let staker_part = bps_of(claimed, ctx.accounts.config.staker_share_bps);
    let treasury_part = claimed - staker_part;
    if treasury_part > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.fee_wsol.to_account_info(),
                    to: ctx.accounts.treasury_wsol.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            treasury_part,
        )?;
    }
    let pending = ctx
        .accounts
        .config
        .pending_staker_lamports
        .checked_add(staker_part)
        .ok_or(DusterError::MathOverflow)?;

    // 3. Odkup. Dopoki nikt nie stakuje, SOL czeka. Limit na jeden buyback
    //    rozklada wieksze kwoty na kolejne godziny i ogranicza wplyw na cene.
    let spend = if ctx.accounts.config.total_shares > 0 {
        pending.min(ctx.accounts.config.max_buyback_lamports)
    } else {
        0
    };
    if spend >= MIN_SWAP_LAMPORTS {
        let before = ctx.accounts.stake_vault.amount;
        cp_amm::swap(
            cp_amm::Swap {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                input_token_account: ctx.accounts.fee_wsol.to_account_info(),
                output_token_account: ctx.accounts.stake_vault.to_account_info(),
                token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                token_a_mint: ctx.accounts.duster_mint.to_account_info(),
                token_b_mint: ctx.accounts.wsol_mint.to_account_info(),
                payer: ctx.accounts.config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.cp_amm_program.to_account_info(),
            },
            spend,
            min_duster_out,
            signer,
        )?;
        ctx.accounts.stake_vault.reload()?;
        let out = ctx.accounts.stake_vault.amount.saturating_sub(before);
        require!(out >= min_duster_out, DusterError::SlippageExceeded);
        bought = bought.checked_add(out).ok_or(DusterError::MathOverflow)?;
    }
    let spent = if spend >= MIN_SWAP_LAMPORTS { spend } else { 0 };

    // 4. Nowa nagroda dolacza do strumienia i uwalnia sie przez `release_duration`.
    let c = &mut ctx.accounts.config;
    if bought > 0 {
        let still_locked = unreleased_at(c.unreleased, c.stream_updated, c.stream_end, now);
        c.unreleased = still_locked.checked_add(bought).ok_or(DusterError::MathOverflow)?;
        c.stream_updated = now;
        c.stream_end = now.saturating_add(c.release_duration);
        c.total_assets = c.total_assets.checked_add(bought).ok_or(DusterError::MathOverflow)?;
    }
    c.pending_staker_lamports = pending - spent;
    c.last_buyback = now;
    c.total_fees_claimed_lamports = c.total_fees_claimed_lamports.saturating_add(claimed);
    c.total_treasury_lamports = c.total_treasury_lamports.saturating_add(treasury_part);
    c.total_buyback_lamports = c.total_buyback_lamports.saturating_add(spent);
    c.total_buyback_duster = c.total_buyback_duster.saturating_add(bought);

    emit!(BuybackExecuted {
        claimed_lamports: claimed,
        treasury_lamports: treasury_part,
        spent_lamports: spent,
        duster_bought: bought,
        pending_staker_lamports: c.pending_staker_lamports,
        timestamp: now,
    });
    Ok(())
}
