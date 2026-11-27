/**
 * Instrukcje kontrolne, ktore Phantom dopisuje do podpisywanej transakcji, i miejsce, jakie
 * trzeba na nie zostawic.
 *
 * Na stronach, ktorych Phantom jeszcze nie sprawdzil, kazda transakcja dostaje instrukcje programu
 * Lighthouse: przed naszymi po jednej na kazde zapisywalne konto (stan kont tokenow uzytkownika
 * jest przypinany skrotem danych), po naszych sprawdzenie sald uzytkownika. Gdy sie nie mieszcza,
 * portfel pokazuje "Request blocked - This dApp could be malicious". To samo robi dla kazdej prosby
 * o podpisanie wielu transakcji naraz, wiec w tym trybie kazda transakcja jest zatwierdzana osobno.
 *
 * Skutek przypiecia stanu: transakcja podpisana przed zmiana salda DUSTER uzytkownika (np. przez
 * poprzednia paczke) nie wykona sie. Kolejna paczke dajemy wiec do podpisu dopiero po
 * potwierdzeniu poprzedniej.
 *
 * Drugi skutek: instrukcji kontrolnych jest duzo (okolo jednej na kazde zapisywalne konto), a siec
 * wykonuje w jednej transakcji najwyzej 64 instrukcje, liczac zagniezdzone wywolania programow.
 * To ten limit, a nie rozmiar w bajtach, wyznacza, ile pozycji miesci sie w paczce.
 */
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-swap-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { DUSTER_PROGRAM_ID } from "../sdk/duster";
import type { ConvertItem } from "./convert";
import { isSale } from "./scan";
import { accountsOf, MAX_COMPUTE_UNITS, MAX_LOADED_DATA_BYTES, priorityFee, type V1Limits } from "./v1";

/**
 * Bajty dopisywane przez Phantoma, zmierzone w wersji 26.43 na prawdziwych transakcjach czyszczenia
 * (rozmiar przed -> po): 2 puste konta +615, 12 pustych +1395, 1 spalenie +594, 2 spalenia +729,
 * sprzedaz na krzywej +800, sprzedaz na PumpSwap +817, 4 sprzedaze (3 PumpSwap, 1 krzywa) +1410,
 * sprzedaz + 2 puste +956, 2 sprzedaze + 2 puste + 2 spalenia +1502.
 */
const BASE = 470; // adres programu Lighthouse i konta obecne w kazdej paczce (portfel, pool, skarbiec)
const PER_EMPTY = 80;
const PER_BURN = 138; // konto tokenow i mint
const SWAP = 85; // konto DUSTER uzytkownika: pojawia sie, gdy paczka kupuje DUSTER
const FIRST_AMM_SALE = 280; // z kontami wspolnymi dla sprzedazy na PumpSwap (wSOL, statystyki)
const NEXT_AMM_SALE = 172;
const PER_CURVE_SALE = 262;
const PER_ROUTED_ACCOUNT = 95; // sprzedaz z zamiana przez agregator: liczymy od kont zapisywalnych
const MARGIN = 1.04;
const SLACK = 60;

function writableAccounts(item: ConvertItem): number {
  const keys = new Set<string>();
  for (const ix of item.instructions) for (const k of ix.keys) if (k.isWritable) keys.add(k.pubkey.toBase58());
  return keys.size;
}

/**
 * Miejsce do zostawienia w transakcji z podanymi pozycjami: bajty i konta (program Lighthouse).
 * `swaps`: paczka kupuje DUSTER takze bez sprzedazy (rent zamieniany na DUSTER).
 */
export function guardReserve(items: ConvertItem[], swaps = false): { bytes: number; accounts: number } {
  let bytes = BASE;
  let amm = 0;
  let sold = swaps;
  for (const it of items) {
    const kind = it.account.kind;
    if (kind === "empty") bytes += PER_EMPTY;
    else if (kind === "worthless") bytes += PER_BURN;
    else {
      sold = true;
      if (it.account.via) bytes += PER_ROUTED_ACCOUNT * writableAccounts(it);
      else if (kind === "graduated") bytes += amm++ ? NEXT_AMM_SALE : FIRST_AMM_SALE;
      else bytes += PER_CURVE_SALE;
    }
  }
  if (sold) bytes += SWAP;
  return { bytes: Math.ceil(bytes * MARGIN) + SLACK, accounts: 2 };
}

/** Najwiecej instrukcji (glownych i zagniezdzonych razem), jakie siec wykona w jednej transakcji. */
export const MAX_INSTRUCTION_TRACE = 64;

/**
 * Ile instrukcji kontrolnych dopisze Phantom: przed naszymi po jednej na kazde zapisywalne konto
 * poza platnikiem, po naszych po jednej na kazde zamykane konto, saldo SOL i (przy zakupie DUSTER)
 * saldo DUSTER. Zgadza sie co do sztuki z czterema zmierzonymi transakcjami (18, 20, 38 i 43 instrukcje).
 * `swaps`: paczka kupuje DUSTER takze bez sprzedazy (rent zamieniany na DUSTER).
 */
export function guardInstructions(writable: number, items: ConvertItem[], swaps = false): number {
  const sold = swaps || items.some((it) => isSale(it.account.kind));
  return writable - 1 + items.length + 1 + (sold ? 1 : 0);
}

/** Czy transakcja kupuje DUSTER: finish_convert z kontem DUSTER uzytkownika. */
function buysDuster(instructions: TransactionInstruction[]): boolean {
  return instructions.some((ix) => ix.programId.equals(DUSTER_PROGRAM_ID) && ix.data.length >= 16 && (ix.keys[5]?.isWritable ?? false));
}

/**
 * Szacunek liczby zagniezdzonych wywolan w naszych instrukcjach (zmierzone na mainnecie):
 * begin_convert 1, finish_convert 1 bez zakupu i 7 z zakupem DUSTER (plus zalozenie konta DUSTER,
 * gdy uzytkownik go nie ma), zalozenie konta przez program ATA 4, sprzedaz na PumpSwap 4,
 * sprzedaz na krzywej 2. Dokladna liczbe podaje symulacja przed podpisem: patrz traceLength.
 */
function innerEstimate(ix: TransactionInstruction, createsDusterAccount: boolean): number {
  const p = ix.programId;
  if (p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID) || p.equals(SystemProgram.programId) || p.equals(ComputeBudgetProgram.programId)) return 0;
  if (p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 4;
  if (p.equals(DUSTER_PROGRAM_ID)) {
    if (ix.data.length < 16) return 1; // begin_convert
    const withSwap = ix.keys[5]?.isWritable ?? false;
    return withSwap ? 7 + (createsDusterAccount ? 5 : 0) : 1;
  }
  // Sprzedaz ma kilkanascie kont; pozostale instrukcje tych programow (konta statystyk) sa drobne.
  // Starsza instrukcja sprzedazy tokenow cashback ma kont wiecej i dodatkowy przelew.
  if (p.equals(PUMP_AMM_PROGRAM_ID)) return ix.keys.length >= 20 ? 6 : ix.keys.length >= 12 ? 4 : 1;
  if (p.equals(PUMP_PROGRAM_ID)) return ix.keys.length >= 16 ? 4 : ix.keys.length >= 10 ? 2 : 1;
  // Trasa agregatora przez zewnetrzne gieldy.
  return 16;
}

/**
 * Dlugosc sladu instrukcji transakcji po dopisaniu instrukcji kontrolnych Phantoma.
 * `inner` to faktyczna liczba zagniezdzonych wywolan z symulacji; bez niej liczymy szacunek.
 */
export function traceLength(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  items: ConvertItem[],
  opts: { inner?: number; createsDusterAccount?: boolean } = {},
): number {
  const own = instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  const inner = opts.inner ?? own.reduce((s, ix) => s + innerEstimate(ix, opts.createsDusterAccount ?? false), 0);
  return own.length + inner + guardInstructions(accountsOf(instructions, payer).writable, items, buysDuster(instructions));
}

/**
 * Limity dla transakcji v1, do ktorej portfel dopisze instrukcje kontrolne: zuzycie z symulacji
 * z zapasem na nie. Zmierzone: instrukcji jest mniej wiecej tyle, ile kont zapisywalnych plus
 * pozycji, srednio ok. 3,3 tys. jednostek kazda (przypiecie skrotem ok. 9,5 tys.); program
 * Lighthouse to ok. 1 MiB wczytanych danych.
 */
export function guardedLimits(sim: { units: number; loadedBytes: number }, writable: number, items: number, microLamports: number): V1Limits {
  const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil(sim.units * 1.2) + 10_000 + 4_500 * (writable + 2 * items + 2));
  const data = Math.min(MAX_LOADED_DATA_BYTES, Math.ceil((sim.loadedBytes + 2 * 1024 * 1024) / 32_768) * 32_768);
  return { computeUnitLimit: units, loadedAccountsDataSizeLimit: data, priorityFeeLamports: priorityFee(units, microLamports) };
}
