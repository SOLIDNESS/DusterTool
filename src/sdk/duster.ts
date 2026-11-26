/**
 * Klient programu Duster: adresy kont, instrukcje i odczyt stanu.
 * Wspolny dla skryptow, bota i aplikacji webowej.
 */
import { AnchorProvider, BN, Program, type IdlAccounts } from "@coral-xyz/anchor";
import { CP_AMM_PROGRAM_ID, derivePoolAuthority, deriveTokenVaultAddress } from "@meteora-ag/cp-amm-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import idl from "./idl/duster.json";
import type { Duster } from "./idl/duster";

export const DUSTER_PROGRAM_ID = new PublicKey(idl.address);

export type ConfigAccount = IdlAccounts<Duster>["config"];
export type UserStakeAccount = IdlAccounts<Duster>["userStake"];

const pda = (seeds: (Buffer | Uint8Array)[], programId = DUSTER_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = (mint: PublicKey) => pda([Buffer.from("config"), mint.toBuffer()]);
export const stakeVaultPda = (config: PublicKey) => pda([Buffer.from("stake_vault"), config.toBuffer()]);
export const feeWsolPda = (config: PublicKey) => pda([Buffer.from("fee_wsol"), config.toBuffer()]);
export const swapWsolPda = (config: PublicKey) => pda([Buffer.from("swap_wsol"), config.toBuffer()]);
export const userStakePda = (config: PublicKey, user: PublicKey) =>
  pda([Buffer.from("stake"), config.toBuffer(), user.toBuffer()]);
export const sessionPda = (config: PublicKey, user: PublicKey) =>
  pda([Buffer.from("session"), config.toBuffer(), user.toBuffer()]);
export const cpAmmEventAuthority = () => pda([Buffer.from("__event_authority")], CP_AMM_PROGRAM_ID);

/** Program tylko do skladania instrukcji i odczytu; niczego nie podpisuje. */
export function dusterProgram(conn: Connection): Program<Duster> {
  const readonlyWallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => {
      throw new Error("Portfel tylko do odczytu");
    },
    signAllTransactions: async () => {
      throw new Error("Portfel tylko do odczytu");
    },
  };
  const provider = new AnchorProvider(conn, readonlyWallet as never, { commitment: "confirmed" });
  return new Program<Duster>(idl as Duster, provider);
}

/** Stale konta poola potrzebne przy swapie i odbiorze oplat. */
export interface PoolRefs {
  mint: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  poolAuthority: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  eventAuthority: PublicKey;
  stakeVault: PublicKey;
  feeWsol: PublicKey;
  /** Konto wSOL programu, przez ktore przychod z wymiany wchodzi do poola. */
  swapWsol: PublicKey;
}

export function poolRefs(mint: PublicKey, pool: PublicKey): PoolRefs {
  const config = configPda(mint);
  return {
    mint,
    config,
    pool,
    poolAuthority: derivePoolAuthority(),
    tokenAVault: deriveTokenVaultAddress(mint, pool),
    tokenBVault: deriveTokenVaultAddress(NATIVE_MINT, pool),
    eventAuthority: cpAmmEventAuthority(),
    stakeVault: stakeVaultPda(config),
    feeWsol: feeWsolPda(config),
    swapWsol: swapWsolPda(config),
  };
}

export interface InitParams {
  treasury: PublicKey;
  rentFeeBps: number;
  stakerShareBps: number;
  buybackIntervalSecs: number;
  releaseDurationSecs: number;
  maxBuybackLamports: BN;
  minStake: BN;
}

export function initializeIx(
  program: Program<Duster>,
  admin: PublicKey,
  r: PoolRefs,
  position: PublicKey,
  p: InitParams,
): Promise<TransactionInstruction> {
  return program.methods
    .initialize({
      treasury: p.treasury,
      rentFeeBps: p.rentFeeBps,
      stakerShareBps: p.stakerShareBps,
      buybackInterval: new BN(p.buybackIntervalSecs),
      releaseDuration: new BN(p.releaseDurationSecs),
      maxBuybackLamports: p.maxBuybackLamports,
      minStake: p.minStake,
    })
    .accountsStrict({
      admin,
      config: r.config,
      dusterMint: r.mint,
      wsolMint: NATIVE_MINT,
      pool: r.pool,
      position,
      stakeVault: r.stakeVault,
      feeWsol: r.feeWsol,
      swapWsol: r.swapWsol,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface UpdateParams {
  newAdmin?: PublicKey;
  treasury?: PublicKey;
  position?: PublicKey;
  rentFeeBps?: number;
  stakerShareBps?: number;
  buybackIntervalSecs?: number;
  releaseDurationSecs?: number;
  maxBuybackLamports?: BN;
  minStake?: BN;
  paused?: boolean;
}

export function updateConfigIx(
  program: Program<Duster>,
  admin: PublicKey,
  config: PublicKey,
  p: UpdateParams,
): Promise<TransactionInstruction> {
  const opt = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
  return program.methods
    .updateConfig({
      newAdmin: opt(p.newAdmin),
      treasury: opt(p.treasury),
      position: opt(p.position),
      rentFeeBps: opt(p.rentFeeBps),
      stakerShareBps: opt(p.stakerShareBps),
      buybackInterval: p.buybackIntervalSecs === undefined ? null : new BN(p.buybackIntervalSecs),
      releaseDuration: p.releaseDurationSecs === undefined ? null : new BN(p.releaseDurationSecs),
      maxBuybackLamports: opt(p.maxBuybackLamports),
      minStake: opt(p.minStake),
      paused: opt(p.paused),
    })
    .accountsStrict({ admin, config })
    .instruction();
}

/** `tokenAccounts`: konta tokenow, ktore ta transakcja zamknie (od ich depozytu liczone jest fee). */
export function beginConvertIx(
  program: Program<Duster>,
  user: PublicKey,
  config: PublicKey,
  tokenAccounts: PublicKey[],
): Promise<TransactionInstruction> {
  return program.methods
    .beginConvert()
    .accountsStrict({
      user,
      config,
      session: sessionPda(config, user),
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(tokenAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))
    .instruction();
}

/**
 * `minRate`: minimalna liczba jednostek DUSTER za 1 SOL przychodu ze sprzedazy.
 * `withSwap = false` pomija konto DUSTER uzytkownika: dla transakcji, ktore
 * tylko zamykaja konta i nie maja przychodu do zamiany. Konta DUSTER nie trzeba
 * zakladac wczesniej; program robi to sam przy pierwszej wymianie.
 */
export function finishConvertIx(
  program: Program<Duster>,
  user: PublicKey,
  r: PoolRefs,
  treasury: PublicKey,
  minRate: BN,
  withSwap = true,
): Promise<TransactionInstruction> {
  return program.methods
    .finishConvert(minRate)
    .accountsStrict({
      user,
      config: r.config,
      session: sessionPda(r.config, user),
      treasury,
      swapWsol: r.swapWsol,
      userDuster: withSwap ? getAssociatedTokenAddressSync(r.mint, user) : null,
      poolAuthority: r.poolAuthority,
      pool: r.pool,
      tokenAVault: r.tokenAVault,
      tokenBVault: r.tokenBVault,
      dusterMint: r.mint,
      wsolMint: NATIVE_MINT,
      eventAuthority: r.eventAuthority,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function buybackIx(
  program: Program<Duster>,
  cranker: PublicKey,
  r: PoolRefs,
  treasury: PublicKey,
  position: PublicKey,
  positionNftAccount: PublicKey,
  minDusterOut: BN,
): Promise<TransactionInstruction> {
  return program.methods
    .buyback(minDusterOut)
    .accountsStrict({
      cranker,
      config: r.config,
      stakeVault: r.stakeVault,
      feeWsol: r.feeWsol,
      treasuryWsol: getAssociatedTokenAddressSync(NATIVE_MINT, treasury, true),
      poolAuthority: r.poolAuthority,
      pool: r.pool,
      position,
      positionNftAccount,
      tokenAVault: r.tokenAVault,
      tokenBVault: r.tokenBVault,
      dusterMint: r.mint,
      wsolMint: NATIVE_MINT,
      eventAuthority: r.eventAuthority,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export function stakeIx(program: Program<Duster>, user: PublicKey, r: PoolRefs, amount: BN): Promise<TransactionInstruction> {
  return program.methods
    .stake(amount)
    .accountsStrict({
      user,
      config: r.config,
      userStake: userStakePda(r.config, user),
      userDuster: getAssociatedTokenAddressSync(r.mint, user),
      stakeVault: r.stakeVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export const UNSTAKE_ALL = new BN("18446744073709551615");

/** `shares`: liczba udzialow do wyplaty; `UNSTAKE_ALL` wyplaca calosc. */
export function unstakeIx(program: Program<Duster>, user: PublicKey, r: PoolRefs, shares: BN): Promise<TransactionInstruction> {
  return program.methods
    .unstake(shares)
    .accountsStrict({
      user,
      config: r.config,
      userStake: userStakePda(r.config, user),
      userDuster: getAssociatedTokenAddressSync(r.mint, user),
      stakeVault: r.stakeVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

// --- odczyt stanu stakingu (lustro obliczen z programu) ---

/** Nagroda jeszcze nieuwolniona w chwili `now` (sekundy unix). */
export function unreleasedAt(c: ConfigAccount, now: number): bigint {
  const unreleased = BigInt(c.unreleased.toString());
  const updated = BigInt(c.streamUpdated.toString());
  const end = BigInt(c.streamEnd.toString());
  const t = BigInt(Math.floor(now));
  if (t >= end || end <= updated) return 0n;
  if (t <= updated) return unreleased;
  const num = unreleased * (end - t);
  const den = end - updated;
  const value = (num + den - 1n) / den;
  return value < unreleased ? value : unreleased;
}

/** Aktywa nalezace juz do stakujacych. */
export function effectiveAssets(c: ConfigAccount, now: number): bigint {
  const total = BigInt(c.totalAssets.toString());
  const locked = unreleasedAt(c, now);
  return total > locked ? total - locked : 0n;
}

/** Wartosc udzialow w jednostkach DUSTER. */
export function sharesToAssets(c: ConfigAccount, shares: bigint, now: number): bigint {
  const totalShares = BigInt(c.totalShares.toString());
  if (totalShares === 0n) return 0n;
  return (shares * effectiveAssets(c, now)) / totalShares;
}

/** Ile udzialow da wplata `amount`. */
export function assetsToShares(c: ConfigAccount, amount: bigint, now: number): bigint {
  const totalShares = BigInt(c.totalShares.toString());
  const effective = effectiveAssets(c, now);
  if (totalShares === 0n || effective === 0n) return amount;
  return (amount * totalShares) / effective;
}
