use anchor_lang::prelude::*;
use anchor_spl::token::{spl_token::native_mint, Mint, Token, TokenAccount};

use crate::cp_amm;
use crate::errors::DusterError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitParams {
    pub treasury: Pubkey,
    pub rent_fee_bps: u16,
    pub staker_share_bps: u16,
    pub buyback_interval: i64,
    pub release_duration: i64,
    pub max_buyback_lamports: u64,
    pub min_stake: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED, duster_mint.key().as_ref()],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    pub duster_mint: Box<Account<'info, Mint>>,
    #[account(address = native_mint::ID)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: sprawdzane w kodzie: konto poola cp-amm z para DUSTER/wSOL.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: adres pozycji LP zapisywany w konfiguracji; poprawnosc sprawdza cp-amm przy odbiorze oplat.
    pub position: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [STAKE_VAULT_SEED, config.key().as_ref()],
        bump,
        token::mint = duster_mint,
        token::authority = config
    )]
    pub stake_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [FEE_WSOL_SEED, config.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = config
    )]
    pub fee_wsol: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [SWAP_WSOL_SEED, config.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = config
    )]
    pub swap_wsol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

fn check_params(
    rent_fee_bps: u16,
    staker_share_bps: u16,
    buyback_interval: i64,
    release_duration: i64,
    max_buyback_lamports: u64,
    min_stake: u64,
) -> Result<()> {
    require!(rent_fee_bps <= MAX_RENT_FEE_BPS, DusterError::InvalidParameter);
    require!(staker_share_bps <= MAX_BPS, DusterError::InvalidParameter);
    require!(
        (MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&buyback_interval),
        DusterError::InvalidParameter
    );
    require!(
        (MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&release_duration),
        DusterError::InvalidParameter
    );
    require!(max_buyback_lamports > 0, DusterError::InvalidParameter);
    require!(min_stake > 0, DusterError::InvalidParameter);
    Ok(())
}

pub fn initialize(ctx: Context<Initialize>, p: InitParams) -> Result<()> {
    check_params(
        p.rent_fee_bps,
        p.staker_share_bps,
        p.buyback_interval,
        p.release_duration,
        p.max_buyback_lamports,
        p.min_stake,
    )?;
    require!(
        cp_amm::check_pool(
            &ctx.accounts.pool.to_account_info(),
            &ctx.accounts.duster_mint.key(),
            &native_mint::ID
        ),
        DusterError::InvalidPool
    );

    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.treasury = p.treasury;
    c.duster_mint = ctx.accounts.duster_mint.key();
    c.pool = ctx.accounts.pool.key();
    c.position = ctx.accounts.position.key();
    c.stake_vault = ctx.accounts.stake_vault.key();
    c.fee_wsol = ctx.accounts.fee_wsol.key();
    c.swap_wsol = ctx.accounts.swap_wsol.key();
    c.rent_fee_bps = p.rent_fee_bps;
    c.staker_share_bps = p.staker_share_bps;
    c.buyback_interval = p.buyback_interval;
    c.release_duration = p.release_duration;
    c.max_buyback_lamports = p.max_buyback_lamports;
    c.min_stake = p.min_stake;
    c.paused = false;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct UpdateParams {
    pub new_admin: Option<Pubkey>,
    pub treasury: Option<Pubkey>,
    pub position: Option<Pubkey>,
    pub rent_fee_bps: Option<u16>,
    pub staker_share_bps: Option<u16>,
    pub buyback_interval: Option<i64>,
    pub release_duration: Option<i64>,
    pub max_buyback_lamports: Option<u64>,
    pub min_stake: Option<u64>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.duster_mint.as_ref()],
        bump = config.bump,
        has_one = admin
    )]
    pub config: Box<Account<'info, Config>>,
}

pub fn update_config(ctx: Context<UpdateConfig>, p: UpdateParams) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = p.new_admin {
        c.admin = v;
    }
    if let Some(v) = p.treasury {
        c.treasury = v;
    }
    if let Some(v) = p.position {
        c.position = v;
    }
    if let Some(v) = p.rent_fee_bps {
        c.rent_fee_bps = v;
    }
    if let Some(v) = p.staker_share_bps {
        c.staker_share_bps = v;
    }
    if let Some(v) = p.buyback_interval {
        c.buyback_interval = v;
    }
    if let Some(v) = p.release_duration {
        c.release_duration = v;
    }
    if let Some(v) = p.max_buyback_lamports {
        c.max_buyback_lamports = v;
    }
    if let Some(v) = p.min_stake {
        c.min_stake = v;
    }
    if let Some(v) = p.paused {
        c.paused = v;
    }
    check_params(
        c.rent_fee_bps,
        c.staker_share_bps,
        c.buyback_interval,
        c.release_duration,
        c.max_buyback_lamports,
        c.min_stake,
    )
}
