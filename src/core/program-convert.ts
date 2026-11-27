/**
 * Wymiana przez program Duster: kazda paczka to jedna transakcja
 *   begin_convert [sprzedaze, spalenia, zamkniecia] finish_convert
 *
 * Instrukcje programu skladamy tu synchronicznie (bez klienta Anchora), bo
 * planowanie paczek wielokrotnie mierzy rozmiar transakcji.
 */
import { CP_AMM_PROGRAM_ID, CpAmm, type PoolState } from "@meteora-ag/cp-amm-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { DUSTER_PROGRAM_ID, sessionPda, type PoolRefs } from "../sdk/duster";
import idl from "../sdk/idl/duster.json";
import type { Batch, BatchPlanOptions, ConvertItem } from "./convert";
import { isSale } from "./scan";

const discriminator = (name: string): Buffer => {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`Brak instrukcji ${name} w IDL`);
  return Buffer.from(ix.discriminator);
};
const BEGIN_CONVERT = discriminator("begin_convert");
const FINISH_CONVERT = discriminator("finish_convert");
const FINISH_CONVERT_ALL = discriminator("finish_convert_all");

const isFinish = (ix: TransactionInstruction): boolean =>
  ix.programId.equals(DUSTER_PROGRAM_ID) && (ix.data.subarray(0, 8).equals(FINISH_CONVERT) || ix.data.subarray(0, 8).equals(FINISH_CONVERT_ALL));

const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });

export function beginConvertInstruction(user: PublicKey, config: PublicKey, tokenAccounts: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: DUSTER_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      ro(config),
      rw(sessionPda(config, user)),
      ro(SYSVAR_INSTRUCTIONS_PUBKEY),
      ro(SystemProgram.programId),
      ...tokenAccounts.map(ro),
    ],
    data: BEGIN_CONVERT,
  });
}

/**
 * `all = true` to finish_convert_all: na DUSTER idzie nie tylko przychod ze sprzedazy, ale i
 * odzyskane depozyty (po odjeciu fee). Konta sa te same.
 */
export function finishConvertInstruction(
  user: PublicKey,
  r: PoolRefs,
  treasury: PublicKey,
  minRate: bigint,
  withSwap: boolean,
  all = false,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  (all ? FINISH_CONVERT_ALL : FINISH_CONVERT).copy(data, 0);
  data.writeBigUInt64LE(minRate, 8);
  return new TransactionInstruction({
    programId: DUSTER_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      rw(r.config),
      rw(sessionPda(r.config, user)),
      rw(treasury),
      rw(r.swapWsol),
      // Pominiete konto opcjonalne zastepuje adres programu (konwencja Anchora).
      withSwap ? rw(getAssociatedTokenAddressSync(r.mint, user)) : ro(DUSTER_PROGRAM_ID),
      ro(r.poolAuthority),
      rw(r.pool),
      rw(r.tokenAVault),
      rw(r.tokenBVault),
      ro(r.mint),
      ro(NATIVE_MINT),
      ro(r.eventAuthority),
      ro(CP_AMM_PROGRAM_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId),
    ],
    data,
  });
}

export interface ProgramWrapOptions {
  owner: PublicKey;
  refs: PoolRefs;
  treasury: PublicKey;
  /** Minimalny kurs (jednostki DUSTER za 1 SOL) dla danej paczki. */
  minRate: (items: ConvertItem[]) => bigint;
  /** Odzyskane depozyty tez zamieniamy na DUSTER (zamiast wyplacac je w SOL). */
  rentToDuster?: boolean;
}

/**
 * Opcje planowania paczek dla wymiany przez program. Uzytkownik nie potrzebuje
 * konta wSOL, a konto DUSTER program zaklada sam, wiec paczka to tylko
 * begin_convert, pozycje i finish_convert.
 */
export function programPlanOptions(o: ProgramWrapOptions): Pick<BatchPlanOptions, "wrap" | "feeCollectedByProgram" | "rentToDuster"> {
  const all = o.rentToDuster ?? false;
  return {
    feeCollectedByProgram: true,
    rentToDuster: all,
    wrap: (items) => {
      // Zamiana jest w paczce, gdy cos sprzedaje, a przy rencie w DUSTER zawsze.
      const swaps = all || items.some((it) => isSale(it.account.kind));
      const closing = items.map((it) => it.account.address);
      return {
        before: [beginConvertInstruction(o.owner, o.refs.config, closing)],
        after: [finishConvertInstruction(o.owner, o.refs, o.treasury, swaps ? o.minRate(items) : 0n, swaps, all)],
      };
    },
  };
}

/** Stale adresy do tabeli adresow (ALT): wszystko, co powtarza sie w kazdej wymianie. */
export function programLookupAddresses(r: PoolRefs, treasury: PublicKey): PublicKey[] {
  return [
    DUSTER_PROGRAM_ID,
    r.config,
    treasury,
    r.mint,
    NATIVE_MINT,
    r.pool,
    r.poolAuthority,
    r.tokenAVault,
    r.tokenBVault,
    r.swapWsol,
    r.eventAuthority,
    CP_AMM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    ComputeBudgetProgram.programId,
  ];
}

export interface DusterQuoter {
  /** Ile DUSTER da zamiana `lamports` SOL przy obecnym stanie poola. */
  out(lamports: bigint): bigint;
}

export function dusterQuoter(cpAmm: CpAmm, poolState: PoolState, tokenDecimals: number, currentTime: number, currentSlot: number): DusterQuoter {
  return {
    out(lamports) {
      if (lamports <= 0n) return 0n;
      const q = cpAmm.getQuote({
        inAmount: new BN(lamports.toString()),
        inputTokenMint: NATIVE_MINT,
        slippage: 0,
        poolState,
        currentTime,
        currentSlot,
        tokenADecimal: tokenDecimals,
        tokenBDecimal: 9,
      });
      return BigInt(q.swapOutAmount.toString());
    },
  };
}

export interface BatchQuote {
  /** SOL zamieniany w tej paczce na DUSTER: przychod ze sprzedazy, a przy rencie w DUSTER takze depozyty. */
  swapLamports: bigint;
  /** Oczekiwana ilosc DUSTER z tej paczki, liczona po kolei (kazda paczka podnosi cene). */
  dusterOut: bigint;
  /** Minimalny kurs wpisywany do finish_convert. */
  minRate: bigint;
}

const RATE_SCALE = 1_000_000_000n;

/**
 * Wycena paczek wysylanych jedna po drugiej. Kazda kolejna kupuje DUSTER
 * drozej, wiec jej kurs liczymy jako przyrost wyniku dla sumy narastajacej.
 */
export function quoteBatches(swapLamports: bigint[], quoter: DusterQuoter, slippageBps: number): BatchQuote[] {
  let cumulative = 0n;
  let previousOut = 0n;
  return swapLamports.map((amount) => {
    if (amount <= 0n) return { swapLamports: 0n, dusterOut: 0n, minRate: 0n };
    cumulative += amount;
    const total = quoter.out(cumulative);
    const dusterOut = total - previousOut;
    previousOut = total;
    const rate = (dusterOut * RATE_SCALE) / amount;
    return { swapLamports: amount, dusterOut, minRate: (rate * BigInt(10_000 - slippageBps)) / 10_000n };
  });
}

/**
 * Wpisuje kurs minimalny do finish_convert w gotowych paczkach. Wszystkie
 * paczki dostaja ten sam, najnizszy kurs, zeby kolejnosc ich wykonania nie
 * miala znaczenia.
 */
export function applyMinRate(batches: Batch[], quotes: BatchQuote[]): bigint {
  const rates = quotes.filter((q) => q.swapLamports > 0n).map((q) => q.minRate);
  const minRate = rates.length ? rates.reduce((a, b) => (b < a ? b : a)) : 0n;
  for (const b of batches) {
    for (const ix of b.instructions) {
      if (isFinish(ix)) {
        // Paczki bez zamiany nie maja konta DUSTER uzytkownika i zostaja z kursem 0.
        const hasSwap = ix.keys[5].isWritable;
        const data = Buffer.from(ix.data);
        data.writeBigUInt64LE(hasSwap ? minRate : 0n, 8);
        ix.data = data;
      }
    }
  }
  return minRate;
}
