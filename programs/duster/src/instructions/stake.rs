//! Staking bez blokady i bez okresu oczekiwania. Nagrody dopisuja sie same:
//! rosnie wartosc udzialu, wiec stakujacy niczego nie potwierdza ani nie odbiera.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};

use crate::errors::DusterError;
use crate::math::{assets_for_shares, effective_assets, shares_for_deposit, unreleased_at};
use crate::state::*;

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.duster_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStake::INIT_SPACE,
        seeds = [USER_STAKE_SEED, config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(mut, token::mint = config.duster_mint, token::authority = user)]
    pub user_duster: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.stake_vault)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Staked {
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_shares: u64,
    pub total_assets: u64,
}

pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.config;
    require!(!c.paused, DusterError::Paused);
    require!(amount >= c.min_stake, DusterError::BelowMinimum);

    let locked = unreleased_at(c.unreleased, c.stream_updated, c.stream_end, now);
    let effective = effective_assets(c.total_assets, locked);
    let shares = shares_for_deposit(amount, c.total_shares, effective).ok_or(DusterError::MathOverflow)?;
    require!(shares > 0, DusterError::ZeroShares);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.user_duster.to_account_info(),
                to: ctx.accounts.stake_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    let c = &mut ctx.accounts.config;
    c.total_shares = c.total_shares.checked_add(shares).ok_or(DusterError::MathOverflow)?;
    c.total_assets = c.total_assets.checked_add(amount).ok_or(DusterError::MathOverflow)?;

    let s = &mut ctx.accounts.user_stake;
    s.owner = ctx.accounts.user.key();
    s.bump = ctx.bumps.user_stake;
    s.shares = s.shares.checked_add(shares).ok_or(DusterError::MathOverflow)?;
    s.deposited = s.deposited.saturating_add(amount);

    emit!(Staked {
        user: s.owner,
        amount,
        shares,
        total_shares: c.total_shares,
        total_assets: c.total_assets,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.duster_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [USER_STAKE_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump,
        constraint = user_stake.owner == user.key() @ DusterError::InsufficientShares
    )]
    pub user_stake: Box<Account<'info, UserStake>>,
    #[account(mut, token::mint = config.duster_mint, token::authority = user)]
    pub user_duster: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = config.stake_vault)]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_shares: u64,
    pub total_assets: u64,
}

/// `shares == u64::MAX` oznacza wyplate calosci. Wyplata dziala takze przy
/// wstrzymanym programie: srodkow stakujacych nie da sie zablokowac.
pub fn unstake(ctx: Context<Unstake>, shares: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.config;
    let owned = ctx.accounts.user_stake.shares;
    let shares = if shares == u64::MAX { owned } else { shares };
    require!(shares > 0 && shares <= owned, DusterError::InsufficientShares);

    let locked = unreleased_at(c.unreleased, c.stream_updated, c.stream_end, now);
    let effective = effective_assets(c.total_assets, locked);
    let amount = assets_for_shares(shares, c.total_shares, effective).ok_or(DusterError::MathOverflow)?;

    // Zostawienie w puli pylu psuloby kurs udzialu dla kolejnych wplat.
    let remaining = owned - shares;
    if remaining > 0 {
        let remaining_value = assets_for_shares(remaining, c.total_shares, effective).ok_or(DusterError::MathOverflow)?;
        require!(remaining_value >= c.min_stake, DusterError::RemainderBelowMinimum);
    }

    let mint = c.duster_mint;
    let bump = [c.bump];
    let seeds: &[&[u8]] = &[CONFIG_SEED, mint.as_ref(), &bump];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.user_duster.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }

    let c = &mut ctx.accounts.config;
    c.total_shares -= shares;
    c.total_assets = c.total_assets.checked_sub(amount).ok_or(DusterError::MathOverflow)?;

    let s = &mut ctx.accounts.user_stake;
    s.shares = remaining;
    s.deposited = s.deposited.saturating_sub(amount);

    emit!(Unstaked {
        user: s.owner,
        amount,
        shares,
        total_shares: c.total_shares,
        total_assets: c.total_assets,
    });

    // Puste konto stakingu zamykamy, zeby depozyt wrocil do uzytkownika.
    if remaining == 0 {
        ctx.accounts.user_stake.close(ctx.accounts.user.to_account_info())?;
    }
    Ok(())
}
