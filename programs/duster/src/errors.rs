use anchor_lang::prelude::*;

#[error_code]
pub enum DusterError {
    #[msg("Program is paused")]
    Paused,
    #[msg("Parameter out of the allowed range")]
    InvalidParameter,
    #[msg("Pool is not the DUSTER/SOL Meteora DAMM v2 pool")]
    InvalidPool,
    #[msg("begin_convert must be followed by finish_convert in the same transaction")]
    MissingFinish,
    #[msg("Account is not a token account owned by the user")]
    InvalidTokenAccount,
    #[msg("The same token account was passed more than once")]
    DuplicateTokenAccount,
    #[msg("Received less DUSTER than the minimum accepted amount")]
    SlippageExceeded,
    #[msg("Too early for the next buyback")]
    BuybackTooEarly,
    #[msg("Amount is below the minimum")]
    BelowMinimum,
    #[msg("Not enough shares")]
    InsufficientShares,
    #[msg("After a withdrawal the remaining stake must be zero or at least the minimum")]
    RemainderBelowMinimum,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Deposit is too small to receive a single share")]
    ZeroShares,
    #[msg("There are sale proceeds to swap but the user's DUSTER account was not provided")]
    MissingSwapAccounts,
}
