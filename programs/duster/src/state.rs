use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const STAKE_VAULT_SEED: &[u8] = b"stake_vault";
pub const FEE_WSOL_SEED: &[u8] = b"fee_wsol";
pub const SWAP_WSOL_SEED: &[u8] = b"swap_wsol";
pub const USER_STAKE_SEED: &[u8] = b"stake";
pub const SESSION_SEED: &[u8] = b"session";

/// Gorne limity parametrow, ktorych administrator nie moze przekroczyc.
pub const MAX_RENT_FEE_BPS: u16 = 1_000; // 10%
pub const MAX_BPS: u16 = 10_000;
pub const MIN_INTERVAL_SECS: i64 = 60;
pub const MAX_INTERVAL_SECS: i64 = 7 * 24 * 3_600;

/// Ponizej tej kwoty nie robimy swapu: oplaty zjadlyby calosc.
pub const MIN_SWAP_LAMPORTS: u64 = 1_000;

/// Jedyna instancja konfiguracji i stanu dla danego tokena (PDA: "config" + mint).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Zwykly portfel, na ktory trafia fee od rentu oraz nasza czesc oplat z poola (jako wSOL).
    pub treasury: Pubkey,
    pub duster_mint: Pubkey,
    /// Pool DUSTER/SOL na Meteora DAMM v2 (token A = DUSTER, token B = wSOL).
    pub pool: Pubkey,
    /// Pozycja LP, z ktorej program odbiera oplaty.
    pub position: Pubkey,
    pub stake_vault: Pubkey,
    pub fee_wsol: Pubkey,

    /// Fee od odzyskanego rentu, w punktach bazowych (500 = 5%).
    pub rent_fee_bps: u16,
    /// Czesc oplat z poola przeznaczana na buyback dla stakujacych (5000 = polowa).
    pub staker_share_bps: u16,
    /// Minimalny odstep miedzy buybackami, w sekundach.
    pub buyback_interval: i64,
    /// Czas, przez ktory uwalnia sie nagroda z jednego buybacku, w sekundach.
    pub release_duration: i64,
    /// Limit SOL wydawanego w jednym buybacku; reszta czeka na kolejne.
    pub max_buyback_lamports: u64,
    /// Minimalna wplata do stakingu i minimalna pozostawiona kwota.
    pub min_stake: u64,
    pub paused: bool,
    pub bump: u8,

    // --- staking ---
    pub total_shares: u64,
    /// DUSTER w skarbcu stakingu wedlug ksiegowania programu (z czescia jeszcze nieuwolniona).
    pub total_assets: u64,
    /// Nieuwolniona nagroda wedlug stanu na `stream_updated`.
    pub unreleased: u64,
    pub stream_updated: i64,
    pub stream_end: i64,

    // --- buyback ---
    pub last_buyback: i64,
    /// Czesc stakujacych odebrana z poola, ktora czeka na zamiane na DUSTER.
    pub pending_staker_lamports: u64,

    // --- statystyki ---
    pub total_conversions: u64,
    pub total_accounts_closed: u64,
    pub total_rent_lamports: u64,
    pub total_rent_fee_lamports: u64,
    pub total_sale_lamports: u64,
    pub total_duster_to_users: u64,
    pub total_fees_claimed_lamports: u64,
    pub total_treasury_lamports: u64,
    pub total_buyback_lamports: u64,
    pub total_buyback_duster: u64,

    /// Konto wSOL programu, przez ktore przychod z wymiany wchodzi do poola.
    /// Miedzy transakcjami jest puste: kazda wymiana wplaca i od razu zamienia dokladnie te sama kwote.
    pub swap_wsol: Pubkey,

    pub reserved: [u64; 4],
}

/// Udzialy jednego stakujacego (PDA: "stake" + config + portfel).
#[account]
#[derive(InitSpace)]
pub struct UserStake {
    pub owner: Pubkey,
    pub shares: u64,
    /// Suma wplat pomniejszona o wyplaty; sluzy tylko do pokazania zysku w aplikacji.
    pub deposited: u64,
    pub bump: u8,
}

/// Konto tymczasowe jednej wymiany. Powstaje w `begin_convert` i jest zamykane
/// w `finish_convert` tej samej transakcji, wiec jego depozyt wraca od razu.
#[account]
#[derive(InitSpace)]
pub struct ConvertSession {
    pub user: Pubkey,
    /// Saldo SOL uzytkownika na poczatku wymiany.
    pub start_lamports: u64,
    /// Suma depozytow (rentu) na kontach tokenow zgloszonych do zamkniecia.
    pub rent_lamports: u64,
    pub accounts: u16,
    pub bump: u8,
}
