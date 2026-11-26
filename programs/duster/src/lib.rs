//! Duster: wymiana martwych tokenow na DUSTER, buyback z oplat poola i staking.

use anchor_lang::prelude::*;

pub mod cp_amm;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("5bNbw7Rcx58ybEa6cAZ9W1xa21jXztHhERrqpqM3nXHf");

#[program]
pub mod duster {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitParams) -> Result<()> {
        instructions::admin::initialize(ctx, params)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: UpdateParams) -> Result<()> {
        instructions::admin::update_config(ctx, params)
    }

    pub fn begin_convert(ctx: Context<BeginConvert>) -> Result<()> {
        instructions::convert::begin_convert(ctx)
    }

    pub fn finish_convert(ctx: Context<FinishConvert>, min_rate: u64) -> Result<()> {
        instructions::convert::finish_convert(ctx, min_rate)
    }

    pub fn buyback(ctx: Context<Buyback>, min_duster_out: u64) -> Result<()> {
        instructions::buyback::buyback(ctx, min_duster_out)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::stake(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, shares: u64) -> Result<()> {
        instructions::stake::unstake(ctx, shares)
    }
}
