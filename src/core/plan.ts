/**
 * Plan wymiany: od wyniku skanu do gotowych paczek transakcji z wycena.
 * Wspolny dla aplikacji webowej i skryptow; niczego nie podpisuje.
 */
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import type { AddressLookupTableAccount, Connection, PublicKey } from "@solana/web3.js";
import {
  batchWrappers,
  buildItem,
  fitsInTransaction,
  planBatches,
  rentFee,
  saleOptions,
  type Batch,
  type BatchPlanOptions,
  type BatchWrappers,
  type ConvertItem,
  type ConvertOptions,
  type TxFormat,
} from "./convert";
import type { Deployment } from "./deployment";
import { TOKEN_DECIMALS } from "./pool";
import { applyMinRate, dusterQuoter, programPlanOptions, quoteBatches, type BatchQuote, type DusterQuoter } from "./program-convert";
import type { RouteLimits, Router } from "./route";
import { withRetry } from "./rpc";
import { isSale, type DustAccount, type ScanResult } from "./scan";
import { dusterProgram } from "../sdk/duster";

export interface PlanSettings {
  /** Dopuszczalny poslizg sprzedazy na pump.fun, w procentach. */
  sellSlippagePct: number;
  /** Dopuszczalny poslizg zakupu DUSTER, w punktach bazowych. */
  swapSlippageBps: number;
  computeUnitLimit: number;
  /** Limit dla transakcji z zamiana waluty kwotowania przez agregator (trasa zuzywa wiecej). */
  routedComputeUnitLimit: number;
  priorityMicroLamports: number;
  /**
   * Odzyskane depozyty (po odjeciu fee) tez ida na DUSTER, zamiast wracac w SOL. Wybor uzytkownika;
   * mozna go zmienic na gotowym kontekscie bez ponownego wczytywania (withRentToDuster).
   */
  rentToDuster: boolean;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  sellSlippagePct: 2,
  swapSlippageBps: 1500,
  computeUnitLimit: 600_000,
  routedComputeUnitLimit: 1_000_000,
  priorityMicroLamports: 20_000,
  rentToDuster: false,
};

/** Jak portfel uzytkownika przyjmuje transakcje: od tego zalezy ich format i wielkosc paczek. */
export interface TxProfile {
  format: TxFormat;
  /**
   * Portfel dopisuje do transakcji wlasne instrukcje kontrolne (Phantom na stronie, ktorej jeszcze
   * nie sprawdzil): kazda paczka zostawia na nie miejsce.
   */
  walletGuards: boolean;
}

export const DEFAULT_TX_PROFILE: TxProfile = { format: "v0", walletGuards: false };

export interface PlanContext {
  owner: PublicKey;
  deployment: Deployment;
  /** Fee od rentu z konfiguracji programu (do podgladu; pobiera je program). */
  rentFeeBps: number;
  paused: boolean;
  lookupTables: AddressLookupTableAccount[];
  /** Czy uzytkownik ma juz konto DUSTER. Jesli nie, program zalozy je przy pierwszej sprzedazy. */
  hasDusterAccount: boolean;
  /** Depozyt konta tokenow (zwrotny przy jego zamknieciu). */
  tokenAccountRent: number;
  /** Opcje sprzedazy (stali odbiorcy oplat pump.fun i PumpSwap, agregator). */
  sale: ConvertOptions;
  /** Instrukcje otaczajace sprzedaze w kazdej paczce: konto wSOL i konta statystyk. */
  wrappers: BatchWrappers;
  quoter: DusterQuoter;
  settings: PlanSettings;
  tx: TxProfile;
}

/** Ten sam kontekst z innym wyborem, w czym wraca rent (SOL albo DUSTER). */
export function withRentToDuster(ctx: PlanContext, rentToDuster: boolean): PlanContext {
  return ctx.settings.rentToDuster === rentToDuster ? ctx : { ...ctx, settings: { ...ctx.settings, rentToDuster } };
}

/** Konta, ktore wymiana potrafi obsluzyc. Samego DUSTER i wSOL nie ruszamy. */
export function isConvertible(a: DustAccount, deployment: Deployment): boolean {
  if (!isSale(a.kind) && a.kind !== "worthless" && a.kind !== "empty") return false;
  return !a.mint.equals(deployment.mint) && !a.mint.equals(NATIVE_MINT);
}

/** Pobiera z sieci wszystko, czego potrzeba do zaplanowania wymiany dla portfela. */
export async function loadPlanContext(
  conn: Connection,
  deployment: Deployment,
  scan: ScanResult,
  settings: Partial<PlanSettings> = {},
  router?: Router,
  tx: TxProfile = DEFAULT_TX_PROFILE,
): Promise<PlanContext> {
  const owner = scan.owner;
  const cpAmm = new CpAmm(conn);
  const duster = getAssociatedTokenAddressSync(deployment.mint, owner);
  const [table, dusterInfo, tokenAccountRent, poolState, slot, config] = await Promise.all([
    deployment.lookupTable ? withRetry(() => conn.getAddressLookupTable(deployment.lookupTable!)) : null,
    withRetry(() => conn.getAccountInfo(duster)),
    withRetry(() => conn.getMinimumBalanceForRentExemption(165)),
    withRetry(() => cpAmm.fetchPoolState(deployment.pool)),
    withRetry(() => conn.getSlot()),
    withRetry(() => dusterProgram(conn).account.config.fetch(deployment.refs.config)),
  ]);
  const blockTime = await withRetry(() => conn.getBlockTime(slot)).catch(() => null);
  const merged = { ...DEFAULT_PLAN_SETTINGS, ...settings };
  return {
    owner,
    deployment,
    rentFeeBps: config.rentFeeBps,
    paused: config.paused,
    lookupTables: table?.value ? [table.value] : [],
    hasDusterAccount: dusterInfo !== null,
    tokenAccountRent,
    sale: saleOptions(scan, merged.sellSlippagePct, router),
    wrappers: await batchWrappers(scan),
    quoter: dusterQuoter(cpAmm, poolState, TOKEN_DECIMALS, blockTime ?? Math.floor(Date.now() / 1000), slot),
    settings: merged,
    tx,
  };
}

/**
 * Staly zapas zostawiany w kazdej transakcji dla portfeli, ktore dopisuja do niej cos od siebie.
 * Dla Phantoma to za malo: jego instrukcje kontrolne rosna z liczba kont, wiec tam zapas liczymy
 * dla kazdej paczki z osobna (TxProfile.walletGuards).
 */
const WALLET_RESERVE_BYTES = 256;
const WALLET_RESERVE_ACCOUNTS = 2;

/** Ustawienia paczek wspolne dla calej wymiany. */
function batchOptions(ctx: PlanContext, forceMinRate?: bigint): BatchPlanOptions {
  const d = ctx.deployment;
  return {
    owner: ctx.owner,
    treasury: d.treasury,
    rentFeeBps: ctx.rentFeeBps,
    format: ctx.tx.format,
    walletGuards: ctx.tx.walletGuards,
    createsDusterAccount: !ctx.hasDusterAccount,
    reserveBytes: WALLET_RESERVE_BYTES,
    reserveAccounts: WALLET_RESERVE_ACCOUNTS,
    computeUnitLimit: ctx.settings.computeUnitLimit,
    routedComputeUnitLimit: ctx.settings.routedComputeUnitLimit,
    computeUnitPriceMicroLamports: ctx.settings.priorityMicroLamports,
    lookupTables: ctx.lookupTables,
    wrappers: ctx.wrappers,
    ...programPlanOptions({
      owner: ctx.owner,
      refs: d.refs,
      treasury: d.treasury,
      minRate: () => forceMinRate ?? 0n,
      rentToDuster: ctx.settings.rentToDuster,
    }),
  };
}

/** Coraz prostsze trasy zamiany, probowane po kolei, gdy poprzednia nie miesci sie w transakcji. */
const SIMPLER_ROUTES: RouteLimits[] = [{ maxAccounts: 16 }, { maxAccounts: 16, directOnly: true }];

/**
 * Instrukcje dla jednego konta. Sprzedaz tokena sparowanego z inna waluta niz SOL musi zmiescic
 * sie w jednej transakcji razem z zamiana tej waluty przez agregator; jesli trasa jest na to za
 * duza, prosimy o prostsza (kurs moze byc wtedy nieco gorszy, wycena pozycji to uwzglednia).
 */
async function buildFitting(ctx: PlanContext, a: DustAccount, opts: BatchPlanOptions): Promise<ConvertItem | null> {
  const item = await buildItem(a, ctx.sale).catch(() => null);
  if (!a.via) return item;
  if (item && fitsInTransaction([item], opts)) return item;
  for (const limits of SIMPLER_ROUTES) {
    const route = await ctx.sale.router?.quote(a.via.currency.mint, a.via.amount, limits).catch(() => null);
    if (!route || route.outLamports <= a.sellCostLamports) continue;
    const simpler: DustAccount = { ...a, quoteLamports: route.outLamports - a.sellCostLamports, via: { ...a.via, route } };
    const retry = await buildItem(simpler, ctx.sale).catch(() => null);
    if (retry && fitsInTransaction([retry], opts)) return retry;
  }
  return null;
}

/**
 * Instrukcje dla wybranych kont, w kolejnosci pakowania do transakcji. Konta, dla ktorych nie
 * dalo sie zlozyc sprzedazy (agregator nie zwrocil trasy albo zadna nie miesci sie w transakcji),
 * sa pomijane i zostaja w portfelu nietkniete.
 */
export async function buildItems(ctx: PlanContext, accounts: DustAccount[]): Promise<ConvertItem[]> {
  const picked = accounts.filter((a) => isConvertible(a, ctx.deployment));
  const opts = batchOptions(ctx);
  // Pozycje z zamiana przez agregator wymagaja zapytan do jego API, wiec skladamy je rownolegle
  // (API ma limit zapytan, stad niewielka liczba naraz).
  const built: (ConvertItem | null)[] = new Array(picked.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, picked.length) }, async () => {
      while (next < picked.length) {
        const i = next++;
        built[i] = await buildFitting(ctx, picked[i], opts);
      }
    }),
  );
  return packingOrder(built.filter((it): it is ConvertItem => it !== null));
}

/**
 * Kolejnosc pakowania do transakcji: sprzedaze na poczatek, a tokeny po migracji osobno od tych
 * z krzywej. Paczki sa wtedy rowniej wypelnione, a otoczka z kontem wSOL trafia tylko do tych,
 * ktore jej potrzebuja. Sortowanie jest stabilne, wiec w ramach rodzaju zostaje kolejnosc wywolujacego.
 */
function packingOrder(items: ConvertItem[]): ConvertItem[] {
  const order = (it: ConvertItem) => (it.account.via ? 0 : it.account.kind === "graduated" ? 1 : it.account.kind === "curve" ? 2 : 3);
  return [...items].sort((x, y) => order(x) - order(y));
}

export interface ConversionPlan {
  batches: Batch[];
  quotes: BatchQuote[];
  /** Kurs minimalny wpisany do kazdej paczki (jednostki DUSTER za 1 SOL, skala 1e9). */
  minRate: bigint;
  accounts: number;
  /** Depozyty zamykanych kont. */
  rentLamports: number;
  /** Fee od rentu dla projektu. */
  feeLamports: number;
  /** Przychod ze sprzedazy tokenow, w calosci zamieniany na DUSTER. */
  saleLamports: bigint;
  /** Czy rent (po odjeciu fee) tez idzie na DUSTER. */
  rentToDuster: boolean;
  /** Laczna kwota SOL zamieniana na DUSTER: przychod ze sprzedazy, a przy rencie w DUSTER takze depozyty. */
  swapLamports: bigint;
  /**
   * Depozyt konta DUSTER, ktore zalozy ta wymiana (0, gdy uzytkownik je ma albo nic nie kupuje).
   * Przy rencie w SOL placi go uzytkownik ze swojego salda, przy rencie w DUSTER pomniejsza zamiane.
   */
  dusterAccountLamports: number;
  /** Oczekiwana ilosc DUSTER (najmniejsze jednostki). */
  dusterOut: bigint;
}

/** Najmniejsza kwota, jaka program zamienia na DUSTER (MIN_SWAP_LAMPORTS w programie). */
const MIN_SWAP_LAMPORTS = 1_000n;

/**
 * Ile SOL kazda paczka zamieni na DUSTER. Przy rencie w DUSTER program zamienia caly przyrost
 * salda uzytkownika: sprzedaz plus depozyty minus fee. Paczka, ktora zaklada konto DUSTER, placi
 * jego depozyt z tej kwoty; jesli jej na to nie stac, program konta nie zaklada i rent tej paczki
 * zostaje w SOL.
 */
function swapAmounts(ctx: PlanContext, batches: Batch[]): bigint[] {
  let deposit = ctx.hasDusterAccount ? 0n : BigInt(ctx.tokenAccountRent);
  return batches.map((b) => {
    const sale = b.expectedSaleLamports > 0n ? b.expectedSaleLamports : 0n;
    if (!ctx.settings.rentToDuster) return sale;
    const gross = sale + BigInt(b.rentLamports - rentFee(b.rentLamports, ctx.rentFeeBps));
    if (gross < deposit + MIN_SWAP_LAMPORTS) return 0n;
    const amount = gross - deposit;
    deposit = 0n;
    return amount;
  });
}

/**
 * Wpisuje do paczek kurs minimalny liczony z biezacego stanu poola i zwraca go (0, gdy zadna z nich
 * nie kupuje DUSTER). Wycena z chwili skanu starzeje sie: gdy na tokenie jest ruch i cena wzrosnie
 * o wiecej niz tolerancja, program odrzuca zamiane. Dlatego kurs odswiezamy tuz przed podpisem.
 */
export async function refreshMinRate(conn: Connection, ctx: PlanContext, batches: Batch[]): Promise<bigint> {
  const amounts = swapAmounts(ctx, batches);
  if (!amounts.some((a) => a > 0n)) return 0n;
  const cpAmm = new CpAmm(conn);
  const [poolState, slot] = await Promise.all([withRetry(() => cpAmm.fetchPoolState(ctx.deployment.pool)), withRetry(() => conn.getSlot())]);
  const blockTime = await withRetry(() => conn.getBlockTime(slot)).catch(() => null);
  const quoter = dusterQuoter(cpAmm, poolState, TOKEN_DECIMALS, blockTime ?? Math.floor(Date.now() / 1000), slot);
  return applyMinRate(batches, quoteBatches(amounts, quoter, ctx.settings.swapSlippageBps));
}

/**
 * Dzieli pozycje na transakcje i wycenia je. `forceMinRate` pozwala zlozyc
 * paczki zastepcze z kursem minimalnym ustalonym wczesniej dla calej wymiany.
 */
export function planConversion(ctx: PlanContext, items: ConvertItem[], forceMinRate?: bigint): ConversionPlan {
  const batches = items.length ? planBatches(packingOrder(items), batchOptions(ctx, forceMinRate)) : [];
  // Konto cashbacku PumpSwap oplaca ta sprzedaz, ktora wykona sie pierwsza. Wycena przypisuje ten
  // koszt jednej pozycji; jesli nie ma jej w tej wymianie, poniesie go pierwsza z pozostalych.
  const present = new Set(items.map((it) => it.account.address.toBase58()));
  const orphan = batches.find((b) => b.items.some((it) => it.account.cashbackCarrier && !present.has(it.account.cashbackCarrier.toBase58())));
  if (orphan) {
    const cost = BigInt(ctx.tokenAccountRent);
    orphan.expectedSaleLamports = orphan.expectedSaleLamports > cost ? orphan.expectedSaleLamports - cost : 0n;
  }
  const quotes = quoteBatches(swapAmounts(ctx, batches), ctx.quoter, ctx.settings.swapSlippageBps);
  const minRate = forceMinRate ?? applyMinRate(batches, quotes);
  const rentLamports = batches.reduce((s, b) => s + b.rentLamports, 0);
  const buys = quotes.some((q) => q.swapLamports > 0n);
  return {
    batches,
    quotes,
    minRate,
    accounts: items.length,
    rentLamports,
    feeLamports: batches.reduce((s, b) => s + rentFee(b.rentLamports, ctx.rentFeeBps), 0),
    saleLamports: batches.reduce((s, b) => s + (b.expectedSaleLamports > 0n ? b.expectedSaleLamports : 0n), 0n),
    rentToDuster: ctx.settings.rentToDuster,
    swapLamports: quotes.reduce((s, q) => s + q.swapLamports, 0n),
    dusterAccountLamports: buys && !ctx.hasDusterAccount ? ctx.tokenAccountRent : 0,
    dusterOut: quotes.reduce((s, q) => s + q.dusterOut, 0n),
  };
}
