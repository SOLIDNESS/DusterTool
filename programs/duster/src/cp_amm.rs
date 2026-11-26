//! Wywolania programu Meteora DAMM v2 (cp-amm). Instrukcje skladamy recznie,
//! zeby nie ciagnac calego SDK do programu: potrzebujemy tylko swapu i odbioru oplat.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

pub const ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

/// Polozenie mintow w danych konta poola (za 8-bajtowym dyskryminatorem).
pub const POOL_TOKEN_A_MINT_OFFSET: usize = 168;
pub const POOL_TOKEN_B_MINT_OFFSET: usize = 200;

const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
const CLAIM_POSITION_FEE_DISCRIMINATOR: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

pub struct Swap<'info> {
    pub pool_authority: AccountInfo<'info>,
    pub pool: AccountInfo<'info>,
    pub input_token_account: AccountInfo<'info>,
    pub output_token_account: AccountInfo<'info>,
    pub token_a_vault: AccountInfo<'info>,
    pub token_b_vault: AccountInfo<'info>,
    pub token_a_mint: AccountInfo<'info>,
    pub token_b_mint: AccountInfo<'info>,
    pub payer: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
}

/// Swap z dokladna kwota wejsciowa. Kierunek wynika z minta konta wejsciowego.
pub fn swap(a: Swap, amount_in: u64, minimum_amount_out: u64, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());

    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(a.pool_authority.key(), false),
            AccountMeta::new(a.pool.key(), false),
            AccountMeta::new(a.input_token_account.key(), false),
            AccountMeta::new(a.output_token_account.key(), false),
            AccountMeta::new(a.token_a_vault.key(), false),
            AccountMeta::new(a.token_b_vault.key(), false),
            AccountMeta::new_readonly(a.token_a_mint.key(), false),
            AccountMeta::new_readonly(a.token_b_mint.key(), false),
            AccountMeta::new_readonly(a.payer.key(), true),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            // Brak konta polecajacego: konwencja Anchora to adres programu w tym miejscu.
            AccountMeta::new_readonly(ID, false),
            AccountMeta::new_readonly(a.event_authority.key(), false),
            AccountMeta::new_readonly(ID, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.pool_authority,
            a.pool,
            a.input_token_account,
            a.output_token_account,
            a.token_a_vault,
            a.token_b_vault,
            a.token_a_mint,
            a.token_b_mint,
            a.payer,
            a.token_program,
            a.event_authority,
            a.program,
        ],
        signer_seeds,
    )?;
    Ok(())
}

pub struct ClaimPositionFee<'info> {
    pub pool_authority: AccountInfo<'info>,
    pub pool: AccountInfo<'info>,
    pub position: AccountInfo<'info>,
    pub token_a_account: AccountInfo<'info>,
    pub token_b_account: AccountInfo<'info>,
    pub token_a_vault: AccountInfo<'info>,
    pub token_b_vault: AccountInfo<'info>,
    pub token_a_mint: AccountInfo<'info>,
    pub token_b_mint: AccountInfo<'info>,
    pub position_nft_account: AccountInfo<'info>,
    /// Wlasciciel pozycji albo delegat z prawem odbioru oplat.
    pub signer: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub program: AccountInfo<'info>,
}

pub fn claim_position_fee(a: ClaimPositionFee, signer_seeds: &[&[&[u8]]]) -> Result<()> {
    let ix = Instruction {
        program_id: ID,
        accounts: vec![
            AccountMeta::new_readonly(a.pool_authority.key(), false),
            AccountMeta::new_readonly(a.pool.key(), false),
            AccountMeta::new(a.position.key(), false),
            AccountMeta::new(a.token_a_account.key(), false),
            AccountMeta::new(a.token_b_account.key(), false),
            AccountMeta::new(a.token_a_vault.key(), false),
            AccountMeta::new(a.token_b_vault.key(), false),
            AccountMeta::new_readonly(a.token_a_mint.key(), false),
            AccountMeta::new_readonly(a.token_b_mint.key(), false),
            AccountMeta::new_readonly(a.position_nft_account.key(), false),
            AccountMeta::new_readonly(a.signer.key(), true),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.token_program.key(), false),
            AccountMeta::new_readonly(a.event_authority.key(), false),
            AccountMeta::new_readonly(ID, false),
        ],
        data: CLAIM_POSITION_FEE_DISCRIMINATOR.to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            a.pool_authority,
            a.pool,
            a.position,
            a.token_a_account,
            a.token_b_account,
            a.token_a_vault,
            a.token_b_vault,
            a.token_a_mint,
            a.token_b_mint,
            a.position_nft_account,
            a.signer,
            a.token_program,
            a.event_authority,
            a.program,
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// Sprawdza, ze konto jest poolem cp-amm z podana para mintow (A, B).
pub fn check_pool(pool: &AccountInfo, token_a_mint: &Pubkey, token_b_mint: &Pubkey) -> bool {
    if pool.owner != &ID {
        return false;
    }
    let Ok(data) = pool.try_borrow_data() else {
        return false;
    };
    if data.len() < POOL_TOKEN_B_MINT_OFFSET + 32 {
        return false;
    }
    data[POOL_TOKEN_A_MINT_OFFSET..POOL_TOKEN_A_MINT_OFFSET + 32] == token_a_mint.to_bytes()
        && data[POOL_TOKEN_B_MINT_OFFSET..POOL_TOKEN_B_MINT_OFFSET + 32] == token_b_mint.to_bytes()
}
