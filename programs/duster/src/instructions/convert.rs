//! Wymiana martwych tokenow na DUSTER.
//!
//! Transakcja uzytkownika ma postac:
//!   begin_convert -> [sprzedaze na pump.fun, spalenia, zamkniecia kont] -> finish_convert
//!
//! `begin_convert` zapamietuje saldo SOL uzytkownika i sume depozytow na kontach,
//! ktore beda zamykane. `finish_convert` mierzy, o ile saldo wzroslo. Z tego
//! przyrostu czesc odpowiadajaca depozytom zostaje u uzytkownika (minus fee),
//! a reszta, czyli faktyczny przychod ze sprzedazy, jest zamieniana na DUSTER
//! na naszym poolu. Program nie musi wiedziec, gdzie tokeny zostaly sprzedane.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_lang::system_program;
use anchor_lang::Discriminator;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, spl_token::native_mint, Token, TokenAccount};

use crate::cp_amm;
use crate::errors::DusterError;
use crate::math::bps_of;
use crate::state::*;

const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Przelicznik kursu minimalnego: jednostki DUSTER za 1 SOL.
const RATE_SCALE: u128 = 1_000_000_000;

#[derive(Accounts)]
pub struct BeginConvert<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED, config.duster_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = user,
        space = 8 + ConvertSession::INIT_SPACE,
        seeds = [SESSION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub session: Box<Account<'info, ConvertSession>>,
    /// CHECK: sysvar instrukcji, adres sprawdzany.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: konta tokenow uzytkownika, ktore beda zamkniete w tej transakcji.
}

pub fn begin_convert(ctx: Context<BeginConvert>) -> Result<()> {
    require!(!ctx.accounts.config.paused, DusterError::Paused);
    let user = ctx.accounts.user.key();

    // W dalszej czesci tej samej transakcji musi byc finish_convert tego uzytkownika.
    // Bez tego konto sesji zostaloby otwarte i zablokowalo kolejne wymiany.
    let ix_sysvar = ctx.accounts.instructions.to_account_info();
    let mut index = load_current_index_checked(&ix_sysvar)? as usize + 1;
    let mut found = false;
    while let Ok(ix) = load_instruction_at_checked(index, &ix_sysvar) {
        if ix.program_id == crate::ID
            && ix.data.starts_with(crate::instruction::FinishConvert::DISCRIMINATOR)
            && ix.accounts.first().map(|a| a.pubkey) == Some(user)
        {
            found = true;
            break;
        }
        index += 1;
    }
    require!(found, DusterError::MissingFinish);

    let mut rent: u64 = 0;
    let accounts = ctx.remaining_accounts;
    for (i, acc) in accounts.iter().enumerate() {
        require!(
            acc.owner == &token::ID || acc.owner == &TOKEN_2022_ID,
            DusterError::InvalidTokenAccount
        );
        {
            let data = acc.try_borrow_data()?;
            // Uklad konta tokenow: mint (32 bajty), wlasciciel (32 bajty), ...
            require!(
                data.len() >= 64 && data[32..64] == user.to_bytes(),
                DusterError::InvalidTokenAccount
            );
        }
        require!(
            accounts[..i].iter().all(|other| other.key != acc.key),
            DusterError::DuplicateTokenAccount
        );
        rent = rent.checked_add(acc.lamports()).ok_or(DusterError::MathOverflow)?;
    }

    let s = &mut ctx.accounts.session;
    s.user = user;
    // Saldo juz po oplaceniu depozytu konta sesji; ten depozyt wraca dopiero po finish_convert.
    s.start_lamports = ctx.accounts.user.lamports();
    s.rent_lamports = rent;
    s.accounts = u16::try_from(accounts.len()).map_err(|_| DusterError::MathOverflow)?;
    s.bump = ctx.bumps.session;
    Ok(())
}

#[derive(Accounts)]
pub struct FinishConvert<'info> {
    // Uwaga: `user` musi pozostac pierwszym kontem, begin_convert na tym polega.
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED, config.duster_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        close = user,
        seeds = [SESSION_SEED, config.key().as_ref(), user.key().as_ref()],
        bump = session.bump,
        has_one = user
    )]
    pub session: Box<Account<'info, ConvertSession>>,
    /// CHECK: zwykly portfel z konfiguracji, odbiera fee od rentu.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// Konto wSOL programu: tedy przychod ze sprzedazy wchodzi do poola.
    /// Uzytkownik nie potrzebuje wlasnego konta wSOL.
    #[account(mut, address = config.swap_wsol)]
    pub swap_wsol: Box<Account<'info, TokenAccount>>,
    /// CHECK: konto DUSTER uzytkownika; sprawdzane w kodzie i zakladane tutaj, jesli go nie ma.
    /// Mozna je pominac, gdy transakcja tylko zamyka konta i nie ma przychodu do zamiany.
    #[account(mut)]
    pub user_duster: Option<UncheckedAccount<'info>>,

    /// CHECK: staly adres wladzy pooli cp-amm.
    #[account(address = cp_amm::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: pool z konfiguracji.
    #[account(mut, address = config.pool)]
    pub pool: UncheckedAccount<'info>,
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Converted {
    pub user: Pubkey,
    pub accounts_closed: u16,
    pub rent_lamports: u64,
    pub rent_fee_lamports: u64,
    pub sale_lamports: u64,
    pub duster_out: u64,
}

/// Saldo konta tokenow po sprawdzeniu, ze to konto DUSTER nalezace do uzytkownika.
fn duster_balance(account: &AccountInfo, user: &Pubkey, mint: &Pubkey) -> Result<u64> {
    require!(account.owner == &token::ID, DusterError::InvalidTokenAccount);
    let data = account.try_borrow_data()?;
    // Uklad konta tokenow: mint (32 bajty), wlasciciel (32 bajty), saldo (8 bajtow), ...
    require!(
        data.len() == TokenAccount::LEN && data[..32] == mint.to_bytes() && data[32..64] == user.to_bytes(),
        DusterError::InvalidTokenAccount
    );
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(amount))
}

/// `min_rate`: najmniejsza akceptowana liczba jednostek DUSTER za 1 SOL przychodu.
/// Kwota SOL jest znana dopiero w trakcie transakcji, wiec zabezpieczenie przed
/// poslizgiem podajemy jako kurs, a nie jako kwote.
pub fn finish_convert(ctx: Context<FinishConvert>, min_rate: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, DusterError::Paused);

    let gross = ctx
        .accounts
        .user
        .lamports()
        .saturating_sub(ctx.accounts.session.start_lamports);
    let rent_part = gross.min(ctx.accounts.session.rent_lamports);
    let sale = gross - rent_part;
    let fee = bps_of(rent_part, ctx.accounts.config.rent_fee_bps);

    if fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    let mut duster_out = 0u64;
    let mut swapped = 0u64;
    if sale >= MIN_SWAP_LAMPORTS {
        let Some(user_duster) = ctx.accounts.user_duster.as_ref() else {
            return err!(DusterError::MissingSwapAccounts);
        };
        let user_key = ctx.accounts.user.key();
        let mint_key = ctx.accounts.duster_mint.key();

        // Pierwsza wymiana: zakladamy uzytkownikowi konto DUSTER (program ATA sam sprawdza adres).
        if user_duster.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: ctx.accounts.user.to_account_info(),
                    associated_token: user_duster.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.duster_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }
        let before = duster_balance(user_duster, &user_key, &mint_key)?;

        // SOL -> wSOL na koncie programu; swap zabiera stamtad dokladnie te sama kwote.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.swap_wsol.to_account_info(),
                },
            ),
            sale,
        )?;
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: ctx.accounts.swap_wsol.to_account_info(),
            },
        ))?;

        let min_out = u64::try_from(sale as u128 * min_rate as u128 / RATE_SCALE)
            .map_err(|_| DusterError::MathOverflow)?;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, mint_key.as_ref(), &bump];
        cp_amm::swap(
            cp_amm::Swap {
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                input_token_account: ctx.accounts.swap_wsol.to_account_info(),
                output_token_account: user_duster.to_account_info(),
                token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                token_a_mint: ctx.accounts.duster_mint.to_account_info(),
                token_b_mint: ctx.accounts.wsol_mint.to_account_info(),
                payer: ctx.accounts.config.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.cp_amm_program.to_account_info(),
            },
            sale,
            min_out,
            &[seeds],
        )?;
        duster_out = duster_balance(user_duster, &user_key, &mint_key)?.saturating_sub(before);
        // cp-amm sam pilnuje minimum, ale wynik sprawdzamy tez po swojej stronie.
        require!(duster_out >= min_out, DusterError::SlippageExceeded);
        swapped = sale;
    }

    let accounts_closed = ctx.accounts.session.accounts;
    let c = &mut ctx.accounts.config;
    c.total_conversions = c.total_conversions.saturating_add(1);
    c.total_accounts_closed = c.total_accounts_closed.saturating_add(accounts_closed as u64);
    c.total_rent_lamports = c.total_rent_lamports.saturating_add(rent_part);
    c.total_rent_fee_lamports = c.total_rent_fee_lamports.saturating_add(fee);
    c.total_sale_lamports = c.total_sale_lamports.saturating_add(swapped);
    c.total_duster_to_users = c.total_duster_to_users.saturating_add(duster_out);

    emit!(Converted {
        user: ctx.accounts.user.key(),
        accounts_closed,
        rent_lamports: rent_part,
        rent_fee_lamports: fee,
        sale_lamports: swapped,
        duster_out,
    });
    Ok(())
}
