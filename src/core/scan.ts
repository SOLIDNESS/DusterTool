/**
 * Skaner portfela: znajduje konta tokenowe, rozpoznaje tokeny pump.fun i
 * wycenia je po realnej cenie sprzedazy.
 *
 * Wylacznie odczyt z sieci; niczego nie podpisuje.
 */
import {
  BONDING_CURVE_SIZE,
  bondingCurvePda,
  computeFeesBps,
  userVolumeAccumulatorPda,
  getSellSolAmountFromTokenAmount,
  isSolLikeQuoteMint,
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  quoteTransferFeeOf,
  type BondingCurve,
  type FeeConfig,
  type Global,
  type QuoteTransferFee,
} from "@pump-fun/pump-sdk";
import {
  canonicalPoolQuoteMint,
  canonicalPumpPoolPda,
  computeFeesBps as ammComputeFeesBps,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  sellBaseInput,
  userVolumeAccumulatorPda as ammVolumeAccumulatorPda,
  type FeeConfig as AmmFeeConfig,
  type GlobalConfig as AmmGlobalConfig,
  type Pool as AmmPool,
} from "@pump-fun/pump-swap-sdk";
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type RawMint,
} from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import type { RouteQuote, Router } from "./route";
import { getAccountsChunked, withRetry } from "./rpc";

/** Najkrotszy poprawny uklad konta krzywej (starsze konta sa krotsze niz obecne). */
const MIN_CURVE_BYTES = 49;

export type DustKind =
  /** Konto bez tokenow: wystarczy je zamknac. */
  | "empty"
  /** Token pump.fun nadal na krzywej: sprzedajemy na krzywej. */
  | "curve"
  /** Token pump.fun po migracji (graduacji): sprzedajemy na jego poolu PumpSwap. */
  | "graduated"
  /** Token pump.fun, ktorego sprzedaz dalaby 0 lamportow: spalenie i zamkniecie. */
  | "worthless"
  /** Wszystko inne: nie ruszamy. */
  | "unsupported";

export type UnsupportedReason =
  /** wrapped SOL */
  | "wsol"
  /** konto zamrozone */
  | "frozen"
  /** wstrzymane oplaty transferowe Token-2022 */
  | "withheld-fees"
  /** nie jest tokenem pump.fun */
  | "not-pump"
  /** token sparowany z czyms innym niz SOL, a skan dzialal bez routera (patrz ScanOptions.router) */
  | "non-sol-pair"
  /** token sparowany z innym tokenem, dla ktorego agregator nie znalazl zamiany na SOL */
  | "no-route"
  /** token typu cashback sparowany z czyms innym niz SOL */
  | "cashback"
  /** konto tokenow spoza standardu ATA */
  | "non-ata"
  /** token po migracji, ale bez kanonicznego poola PumpSwap */
  | "no-pool";

/** Czy pozycja tego rodzaju jest sprzedawana (a nie tylko palona lub zamykana). */
export const isSale = (kind: DustKind): boolean => kind === "curve" || kind === "graduated";

/** Stan poola PumpSwap potrzebny do wyceny i zlozenia sprzedazy. */
export interface AmmPoolState {
  poolKey: PublicKey;
  pool: AmmPool;
  /** Rezerwy poola w chwili skanu (najmniejsze jednostki). */
  baseReserve: bigint;
  quoteReserve: bigint;
}

/** Waluta inna niz SOL, w ktorej kwotowany jest token (USDC, PUMP, inny token). */
export interface QuoteCurrency {
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** Oplata transferowa Token-2022 tej waluty w biezacej epoce (zwykle brak). */
  transferFee: QuoteTransferFee | null;
  /** Konto ATA uzytkownika w tej walucie. Jesli istnialo przed wymiana, zostaje z tym samym saldem. */
  userAccount: { address: PublicKey; exists: boolean };
  /**
   * Konta, na ktore pump.fun i PumpSwap odprowadzaja czesc oplaty (buyback) w tej walucie.
   * Program ich nie zaklada: gdy ktoregos brakuje, musi je zalozyc sprzedajacy, na swoj koszt.
   */
  curveBuybackAccount: { address: PublicKey; exists: boolean } | null;
  ammBuybackAccount: { address: PublicKey; exists: boolean } | null;
}

/** Sprzedaz tokena sparowanego z inna waluta niz SOL: najpierw na te walute, potem waluta na SOL. */
export interface RoutedSale {
  currency: QuoteCurrency;
  /** Ile waluty da sprzedaz tokena, po oplatach pump.fun. */
  amount: bigint;
  /** Wycena zamiany tej kwoty na SOL. */
  route: RouteQuote;
}

export interface DustAccount {
  /** Adres konta tokenowego. */
  address: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** Saldo w najmniejszych jednostkach. */
  amount: bigint;
  decimals: number;
  /** Lamporty na koncie, czyli rent do odzyskania przy zamknieciu. */
  rentLamports: number;
  kind: DustKind;
  /** Powod, dla ktorego konto jest nieobslugiwane. */
  reason?: UnsupportedReason;
  /**
   * Ile tokenow da sie realnie sprzedac. Zwykle cale saldo; mniej, gdy krzywa
   * nie ma dosc SOL na wyplate (tokeny w trybie Mayhem). Reszta jest palona.
   */
  sellAmount: bigint;
  /**
   * Szacowany wplyw ze sprzedazy sellAmount w lamportach: netto po oplatach pump.fun, po zamianie
   * na SOL (jesli token jest sparowany z inna waluta) i po odjeciu sellCostLamports.
   */
  quoteLamports: bigint;
  /**
   * Bezzwrotny koszt sprzedazy ponoszony przez sprzedajacego: doplata do depozytu konta krzywej,
   * jesli ma ono jeszcze stary, krotszy uklad, albo zalozenie konta, ktorego wymaga pump.fun
   * (konto oplaty buyback w walucie kwotowania, konto cashbacku na PumpSwap).
   */
  sellCostLamports: bigint;
  /** Token typu cashback: sprzedaz wymaga starszej instrukcji z dodatkowymi kontami. */
  cashback?: boolean;
  /**
   * Ustawione, gdy sprzedaz liczy na to, ze konto cashbacku PumpSwap oplaci inna pozycja z tego
   * portfela (adres jej konta tokenow). Koszt ponosi ta sprzedaz, ktora wykona sie pierwsza, wiec
   * bez tamtej pozycji w wymianie spada on na te.
   */
  cashbackCarrier?: PublicKey;
  /** Ustawione, gdy token jest sparowany z inna waluta niz SOL. */
  via?: RoutedSale;
  /** Stan krzywej (tylko dla tokenow pump.fun). */
  bondingCurve?: BondingCurve;
  mintSupply?: BN;
  /** Pool PumpSwap (tylko dla tokenow po migracji). */
  amm?: AmmPoolState;
}

export interface ScanOptions {
  /**
   * Najmniejszy wplyw netto, przy ktorym sprzedaz ma sens. Tansze resztki sa
   * palone: sprzedaz zajmuje w transakcji znacznie wiecej miejsca niz spalenie.
   */
  minSellLamports?: bigint;
  /**
   * Agregator, ktory zamienia walute kwotowania na SOL. Bez niego tokeny sparowane z czyms
   * innym niz SOL sa oznaczane jako nieobslugiwane.
   */
  router?: Router;
}

export const DEFAULT_MIN_SELL_LAMPORTS = 10_000n;

export interface ScanResult {
  owner: PublicKey;
  accounts: DustAccount[];
  global: Global;
  feeConfig: FeeConfig | null;
  /**
   * Konto statystyk wolumenu pump.fun dla tego portfela. Pierwsza sprzedaz
   * tworzy je na koszt uzytkownika; jesli go nie bylo, zamykamy je na koncu
   * wymiany i caly depozyt wraca.
   */
  volumeAccumulator: { exists: boolean; rentLamports: number };
  /** Wspolny stan PumpSwap: konfiguracja programu i konta uzytkownika uzywane przy sprzedazy. */
  amm: AmmScan;
}

export interface AmmScan {
  /** null, gdy portfel nie ma tokenow po migracji (konfiguracji wtedy nie pobieramy). */
  globalConfig: AmmGlobalConfig | null;
  feeConfig: AmmFeeConfig | null;
  /**
   * Konto wSOL uzytkownika: tam PumpSwap wyplaca przychod ze sprzedazy. Jesli juz istnieje,
   * po wymianie odtwarzamy je z tym samym saldem.
   */
  wsolAccount: { address: PublicKey; exists: boolean; amount: bigint };
  /** Konto statystyk wolumenu PumpSwap; sprzedaz zaklada je sama, wiec po wymianie je zamykamy. */
  volumeAccumulator: { exists: boolean };
  /**
   * Konto wSOL nalezace do konta statystyk: tam PumpSwap odklada cashback ze sprzedazy tokenow
   * cashback. Gdy go nie ma, pierwsza taka sprzedaz zaklada je na koszt sprzedajacego i tego
   * depozytu nie da sie odzyskac.
   */
  cashbackAccount: { address: PublicKey; exists: boolean };
}

interface RawTokenAccount {
  address: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  amount: bigint;
  decimals: number;
  rentLamports: number;
  frozen: boolean;
  withheldFees: boolean;
}

async function fetchTokenAccounts(conn: Connection, owner: PublicKey): Promise<RawTokenAccount[]> {
  const out: RawTokenAccount[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await withRetry(() => conn.getParsedTokenAccountsByOwner(owner, { programId }));
    for (const { pubkey, account } of res.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;
      const extensions: { extension: string; state?: { withheldAmount?: number | string } }[] = info.extensions ?? [];
      const withheld = extensions.find((e) => e.extension === "transferFeeAmount")?.state?.withheldAmount;
      out.push({
        address: pubkey,
        mint: new PublicKey(info.mint),
        tokenProgram: programId,
        amount: BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        rentLamports: account.lamports,
        frozen: info.state === "frozen",
        withheldFees: withheld !== undefined && BigInt(withheld) > 0n,
      });
    }
  }
  return out;
}

/**
 * Najwieksza liczba tokenow, ktorej sprzedaz krzywa jest w stanie wyplacic.
 *
 * Wyplata brutto to amount * vQ / (vT + amount) i nie moze przekroczyc realnych
 * rezerw SOL. Na zwyklej krzywej to zawsze prawda; na krzywej Mayhem agent mogl
 * wyprowadzic SOL i sprzedaz calego salda konczy sie bledem Overflow.
 * Zostawiamy 1% zapasu na zmiany stanu miedzy wycena a wykonaniem.
 */
export function maxSellable(curve: BondingCurve, amount: bigint): bigint {
  const vQ = BigInt(curve.virtualQuoteReserves.toString());
  const vT = BigInt(curve.virtualTokenReserves.toString());
  const real = BigInt(curve.realQuoteReserves.toString());
  if (amount <= 0n || vQ <= 0n || vT <= 0n || real <= 0n) return 0n;
  const gross = (amount * vQ) / (vT + amount);
  if (gross <= real) return amount;
  const budget = (real * 99n) / 100n;
  if (budget <= 0n || budget >= vQ) return 0n;
  const max = (budget * vT) / (vQ - budget);
  return max < amount ? max : amount;
}

/** Uruchamia zadania z ograniczona liczba naraz (zewnetrzne API maja limity zapytan). */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Podaz, od ktorej pump.fun liczy kapitalizacje tokenow poza trybem Mayhem. */
const ONE_BILLION_SUPPLY = new BN("1000000000000000");
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const big = (v: BN) => BigInt(v.toString());
const bn = (v: bigint) => new BN(v.toString());

/** Rozmiar konta statystyk wolumenu uzytkownika w programie pump.fun. */
const VOLUME_ACCUMULATOR_BYTES = 137;
/** Gorne oszacowanie rozmiaru konta tokenow Token-2022 z rozszerzeniami (do wyceny kosztu zalozenia). */
const TOKEN_2022_ACCOUNT_BYTES = 300;

/** Token czeka na wycene zamiany waluty kwotowania na SOL. */
interface PendingRoute {
  index: number;
  currency: QuoteCurrency;
  amount: bigint;
}

export async function scanWallet(conn: Connection, owner: PublicKey, opts: ScanOptions = {}): Promise<ScanResult> {
  const minSell = opts.minSellLamports ?? DEFAULT_MIN_SELL_LAMPORTS;
  const sdk = new OnlinePumpSdk(conn);
  const [raw, global, feeConfig, rentCurve, rentAccumulator, rentToken, rentToken2022, accumulatorInfo] = await Promise.all([
    fetchTokenAccounts(conn, owner),
    withRetry(() => sdk.fetchGlobal()),
    withRetry(() => sdk.fetchFeeConfig()).catch(() => null),
    withRetry(() => conn.getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE)),
    withRetry(() => conn.getMinimumBalanceForRentExemption(VOLUME_ACCUMULATOR_BYTES)),
    withRetry(() => conn.getMinimumBalanceForRentExemption(AccountLayout.span)),
    withRetry(() => conn.getMinimumBalanceForRentExemption(TOKEN_2022_ACCOUNT_BYTES)),
    withRetry(() => conn.getAccountInfo(userVolumeAccumulatorPda(owner))),
  ]);

  // Stan krzywych i mintow pobieramy tylko dla kont z saldem.
  const withBalance = raw.filter((a) => a.amount > 0n && !a.mint.equals(NATIVE_MINT));
  const mints = [...new Map(withBalance.map((a) => [a.mint.toBase58(), a.mint])).values()];
  const wsolAddress = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  const ammAccumulator = ammVolumeAccumulatorPda(owner);
  const cashbackAddress = getAssociatedTokenAddressSync(NATIVE_MINT, ammAccumulator, true);
  const [curveInfos, mintInfos, userAmmInfos] = await Promise.all([
    getAccountsChunked(conn, mints.map((m) => bondingCurvePda(m))),
    getAccountsChunked(conn, mints),
    getAccountsChunked(conn, [wsolAddress, ammAccumulator, cashbackAddress]),
  ]);
  const wsolInfo = userAmmInfos[0];
  const wsolOk = wsolInfo !== null && wsolInfo.owner.equals(TOKEN_PROGRAM_ID) && wsolInfo.data.length >= AccountLayout.span;
  const amm: AmmScan = {
    globalConfig: null,
    feeConfig: null,
    wsolAccount: {
      address: wsolAddress,
      exists: wsolInfo !== null,
      amount: wsolOk ? AccountLayout.decode(wsolInfo.data.subarray(0, AccountLayout.span)).amount : 0n,
    },
    volumeAccumulator: { exists: userAmmInfos[1] !== null },
    cashbackAccount: { address: cashbackAddress, exists: userAmmInfos[2] !== null },
  };

  const curves = new Map<string, BondingCurve>();
  const curveGrowCost = new Map<string, bigint>();
  const supplies = new Map<string, BN>();
  const rawMints = new Map<string, RawMint>();
  mints.forEach((mint, i) => {
    const key = mint.toBase58();
    const curveInfo = curveInfos[i];
    // Konto krzywej bywa puste (0 bajtow) albo nalezy do innego programu: to nie jest aktywna krzywa.
    if (curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID) && curveInfo.data.length >= MIN_CURVE_BYTES) {
      const decoded = PUMP_SDK.decodeBondingCurveNullable(curveInfo);
      if (decoded) {
        curves.set(key, decoded);
        // Starsze, krotsze konto krzywej jest przy sprzedazy powiekszane do pelnego rozmiaru.
        // Sprzedajacy doplaca tylko tyle, ile brakuje do minimalnego depozytu po odliczeniu
        // rezerwy SOL (zmierzone na mainnecie: konta zalozone przed obnizka rentu maja zapas).
        let topUp = 0n;
        if (curveInfo.data.length < BONDING_CURVE_SIZE) {
          const spare = BigInt(curveInfo.lamports) - big(decoded.realQuoteReserves);
          const missing = BigInt(rentCurve) - (spare > 0n ? spare : 0n);
          topUp = missing > 0n ? missing : 0n;
        }
        curveGrowCost.set(key, topUp);
      }
    }
    const mintInfo = mintInfos[i];
    if (mintInfo && mintInfo.data.length >= MintLayout.span) {
      const decoded = MintLayout.decode(mintInfo.data.subarray(0, MintLayout.span));
      supplies.set(key, new BN(decoded.supply.toString()));
      rawMints.set(key, decoded);
    }
  });

  // Tokeny po migracji: kanoniczny pool PumpSwap, o adresie wyliczonym z minta i waluty kwotowania.
  const graduated = mints.filter((m) => curves.get(m.toBase58())?.complete);
  const pools = new Map<string, AmmPoolState>();
  if (graduated.length) {
    const poolKeys = graduated.map((m) => canonicalPumpPoolPda(m, curves.get(m.toBase58())!.quoteMint));
    const [poolInfos, configInfos] = await Promise.all([
      getAccountsChunked(conn, poolKeys),
      getAccountsChunked(conn, [GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA]),
    ]);
    if (configInfos[0]) amm.globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(configInfos[0]);
    if (configInfos[1]) amm.feeConfig = PUMP_AMM_SDK.decodeFeeConfig(configInfos[1]);
    const decoded: { mint: PublicKey; poolKey: PublicKey; pool: AmmPool }[] = [];
    graduated.forEach((mint, i) => {
      const info = poolInfos[i];
      if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) return;
      const pool = PUMP_AMM_SDK.decodePoolNullable(info);
      const quoteMint = canonicalPoolQuoteMint(curves.get(mint.toBase58())!.quoteMint);
      if (pool && pool.baseMint.equals(mint) && pool.quoteMint.equals(quoteMint)) decoded.push({ mint, poolKey: poolKeys[i], pool });
    });
    const vaults = await getAccountsChunked(
      conn,
      decoded.flatMap((d) => [d.pool.poolBaseTokenAccount, d.pool.poolQuoteTokenAccount]),
    );
    const balance = (i: number) => {
      const info = vaults[i];
      return info && info.data.length >= AccountLayout.span ? AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount : null;
    };
    decoded.forEach((d, i) => {
      const baseReserve = balance(2 * i);
      const quoteReserve = balance(2 * i + 1);
      if (baseReserve === null || quoteReserve === null || baseReserve === 0n) return;
      pools.set(d.mint.toBase58(), { poolKey: d.poolKey, pool: d.pool, baseReserve, quoteReserve });
    });
  }

  // Waluty kwotowania inne niz SOL: program tokenow, konta uzytkownika i konta oplaty buyback.
  const currencies = new Map<string, QuoteCurrency>();
  const quoteMints = [
    ...new Map(
      [...curves.values()].filter((c) => !isSolLikeQuoteMint(c.quoteMint)).map((c) => [c.quoteMint.toBase58(), c.quoteMint]),
    ).values(),
  ];
  if (quoteMints.length && opts.router) {
    const quoteInfos = await getAccountsChunked(conn, quoteMints);
    const epoch = quoteInfos.some((i) => i?.owner.equals(TOKEN_2022_PROGRAM_ID)) ? (await withRetry(() => conn.getEpochInfo())).epoch : 0;
    const curveBuyback = global.buybackFeeRecipients?.[0];
    const ammBuyback = amm.globalConfig?.buybackFeeRecipients?.[0];
    const known: { mint: PublicKey; tokenProgram: PublicKey; transferFee: QuoteTransferFee | null }[] = [];
    quoteMints.forEach((mint, i) => {
      const info = quoteInfos[i];
      if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) return;
      try {
        known.push({ mint, tokenProgram: info.owner, transferFee: quoteTransferFeeOf(mint, info, epoch) });
      } catch {
        // Mint z niepoprawnym rozszerzeniem: pump.fun tez go nie obsluzy.
      }
    });
    const ata = (mint: PublicKey, wallet: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(mint, wallet, true, program);
    const addresses = known.flatMap((k) => [
      ata(k.mint, owner, k.tokenProgram),
      curveBuyback ? ata(k.mint, curveBuyback, k.tokenProgram) : PublicKey.default,
      ammBuyback ? ata(k.mint, ammBuyback, k.tokenProgram) : PublicKey.default,
    ]);
    const infos = await getAccountsChunked(conn, addresses);
    known.forEach((k, i) => {
      const slot = (j: number, present: boolean) => (present ? { address: addresses[3 * i + j], exists: infos[3 * i + j] !== null } : null);
      currencies.set(k.mint.toBase58(), {
        ...k,
        userAccount: slot(0, true)!,
        curveBuybackAccount: slot(1, Boolean(curveBuyback)),
        ammBuybackAccount: slot(2, Boolean(ammBuyback)),
      });
    });
  }

  const pending: PendingRoute[] = [];
  /** Sprzedaze tokenow cashback na PumpSwap z portfela, ktory nie ma jeszcze konta cashbacku. */
  const needCashbackAccount: number[] = [];
  const accounts: DustAccount[] = raw.map((a, index) => {
    const base = {
      address: a.address,
      mint: a.mint,
      tokenProgram: a.tokenProgram,
      amount: a.amount,
      decimals: a.decimals,
      rentLamports: a.rentLamports,
      sellAmount: 0n,
      quoteLamports: 0n,
      sellCostLamports: 0n,
    };
    const unsupported = (reason: UnsupportedReason): DustAccount => ({ ...base, kind: "unsupported", reason });

    if (a.mint.equals(NATIVE_MINT)) return unsupported("wsol");
    if (a.frozen) return unsupported("frozen");
    if (a.withheldFees) return unsupported("withheld-fees");
    if (a.amount === 0n) return { ...base, kind: "empty" };

    const key = a.mint.toBase58();
    const curve = curves.get(key);
    const mintSupply = supplies.get(key);
    if (!curve || !mintSupply) return unsupported("not-pump");
    const pump = { bondingCurve: curve, mintSupply, cashback: curve.isCashbackCoin };

    // Token sparowany z inna waluta niz SOL: potrzebna jest jeszcze zamiana tej waluty na SOL.
    const solQuote = isSolLikeQuoteMint(curve.quoteMint);
    const currency = solQuote ? undefined : currencies.get(curve.quoteMint.toBase58());
    if (!solQuote) {
      if (!opts.router) return { ...unsupported("non-sol-pair"), ...pump };
      if (!currency) return { ...unsupported("no-route"), ...pump };
      // Cashback w innej walucie niz SOL wymagalby jeszcze jednego konta na kazda walute.
      if (curve.isCashbackCoin) return { ...unsupported("cashback"), ...pump };
    }
    const tokenAccountCost = (program: PublicKey) => BigInt(program.equals(TOKEN_2022_PROGRAM_ID) ? rentToken2022 : rentToken);

    if (curve.complete) {
      const state = pools.get(key);
      const rawMint = rawMints.get(key);
      if (!state || !rawMint || !amm.globalConfig) return { ...unsupported("no-pool"), ...pump };
      const cashback = state.pool.isCashbackCoin;
      const position = { ...base, ...pump, cashback, amm: state };
      let out = 0n;
      let cashbackOut = 0n;
      try {
        const reserves = { baseReserve: bn(state.baseReserve), quoteReserve: bn(state.quoteReserve) };
        const res = sellBaseInput({
          base: bn(a.amount),
          slippage: 0,
          ...reserves,
          virtualQuoteReserves: state.pool.virtualQuoteReserves,
          feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees),
          globalConfig: amm.globalConfig,
          baseMintAccount: rawMint,
          baseMint: a.mint,
          coinCreator: state.pool.coinCreator,
          creator: state.pool.creator,
          feeConfig: amm.feeConfig,
          quoteMint: state.pool.quoteMint,
          isMayhemMode: state.pool.isMayhemMode,
          creatorFeeBps: state.pool.creatorFeeBps,
          quoteTransferFee: currency?.transferFee,
        });
        out = big(res.uiQuote);
        // Przy tokenie cashback oplata tworcy wraca do sprzedajacego (na konto statystyk).
        if (cashback && !state.pool.coinCreator.equals(PublicKey.default)) {
          const { creatorFeeBps } = ammComputeFeesBps({
            globalConfig: amm.globalConfig,
            feeConfig: amm.feeConfig,
            creator: state.pool.creator,
            baseMintSupply: new BN(rawMint.supply.toString()),
            baseMint: a.mint,
            baseReserve: reserves.baseReserve,
            quoteReserve: reserves.quoteReserve.add(state.pool.virtualQuoteReserves),
            quoteMint: state.pool.quoteMint,
            isMayhemMode: state.pool.isMayhemMode,
            creatorFeeBps: state.pool.creatorFeeBps,
          });
          cashbackOut = ceilDiv(big(res.internalQuoteAmountOut) * big(creatorFeeBps), 10_000n);
        }
      } catch {
        out = 0n;
      }
      if (currency) {
        if (out <= 0n) return { ...position, kind: "worthless" };
        const cost = currency.ammBuybackAccount?.exists === false ? tokenAccountCost(currency.tokenProgram) : 0n;
        pending.push({ index, currency, amount: out });
        return { ...position, kind: "graduated", sellAmount: a.amount, sellCostLamports: cost };
      }
      // Cashback zabieramy tylko wtedy, gdy konto statystyk zalozy dopiero ta wymiana (i potem je
      // zamknie). Jesli uzytkownik juz je ma, cashback zostaje na nim do odebrania na pump.fun.
      const gain = out + (cashback && !amm.volumeAccumulator.exists ? cashbackOut : 0n);
      if (gain < minSell || gain <= 0n) return { ...position, kind: "worthless" };
      if (cashback && !amm.cashbackAccount.exists) needCashbackAccount.push(index);
      return { ...position, kind: "graduated", sellAmount: a.amount, quoteLamports: gain };
    }

    const sellAmount = maxSellable(curve, a.amount);
    let out = 0n;
    let cashbackOut = 0n;
    if (sellAmount > 0n) {
      try {
        out = big(
          getSellSolAmountFromTokenAmount({
            global,
            feeConfig,
            mintSupply,
            bondingCurve: curve,
            amount: bn(sellAmount),
            quoteTransferFee: currency?.transferFee,
          }),
        );
        if (curve.isCashbackCoin && !curve.creator.equals(PublicKey.default)) {
          const { creatorFeeBps } = computeFeesBps({
            global,
            feeConfig,
            mintSupply: curve.isMayhemMode ? mintSupply : ONE_BILLION_SUPPLY,
            virtualQuoteReserves: curve.virtualQuoteReserves,
            virtualTokenReserves: curve.virtualTokenReserves,
            quoteMint: curve.quoteMint,
            creatorFeeBps: curve.creatorFeeBps,
          });
          const gross = (sellAmount * big(curve.virtualQuoteReserves)) / (big(curve.virtualTokenReserves) + sellAmount);
          cashbackOut = ceilDiv(gross * big(creatorFeeBps), 10_000n);
        }
      } catch {
        out = 0n;
      }
    }
    // Sprzedaz na krzywej dziala tylko ze standardowego konta ATA wlasciciela.
    const isAta = getAssociatedTokenAddressSync(a.mint, owner, true, a.tokenProgram).equals(a.address);
    const growCost = curveGrowCost.get(key) ?? 0n;
    if (currency) {
      if (out <= 0n) return { ...base, ...pump, kind: "worthless" };
      if (!isAta) return { ...unsupported("non-ata"), ...pump };
      const cost = growCost + (currency.curveBuybackAccount?.exists === false ? tokenAccountCost(currency.tokenProgram) : 0n);
      pending.push({ index, currency, amount: out });
      return { ...base, ...pump, kind: "curve", sellAmount, sellCostLamports: cost };
    }
    // Jak wyzej: cashback wraca razem z depozytem zamykanego konta statystyk, o ile zaklada je ta wymiana.
    const gain = out + (curve.isCashbackCoin && !accumulatorInfo ? cashbackOut : 0n);
    const net = gain - growCost;
    if (net < minSell || net <= 0n) return { ...base, ...pump, kind: "worthless" };
    const priced = { sellAmount, quoteLamports: net, sellCostLamports: growCost };
    if (!isAta) return { ...unsupported("non-ata"), ...pump, ...priced };
    return { ...base, ...pump, kind: "curve", ...priced };
  });

  // Pierwsza sprzedaz tokena cashback na PumpSwap zaklada konto cashbacku na koszt sprzedajacego
  // (bezzwrotnie), kolejne juz nic nie doplacaja. Koszt przypisujemy najcenniejszej z takich
  // pozycji. Jesli nawet ona go nie pokrywa, zadnej nie oplaca sie sprzedawac: ida do spalenia.
  if (needCashbackAccount.length) {
    const cost = BigInt(rentToken);
    const [top, ...rest] = needCashbackAccount.sort((x, y) => Number(accounts[y].quoteLamports - accounts[x].quoteLamports));
    const carrier = accounts[top];
    if (carrier.quoteLamports - cost >= minSell && carrier.quoteLamports > cost) {
      accounts[top] = { ...carrier, quoteLamports: carrier.quoteLamports - cost, sellCostLamports: cost };
      for (const i of rest) accounts[i] = { ...accounts[i], cashbackCarrier: carrier.address };
    } else {
      for (const i of [top, ...rest]) accounts[i] = { ...accounts[i], kind: "worthless", sellAmount: 0n, quoteLamports: 0n };
    }
  }

  // Druga czesc wyceny tokenow sparowanych z inna waluta: ile SOL da zamiana tej waluty.
  if (pending.length && opts.router) {
    const router = opts.router;
    const quote = (mint: PublicKey, amount: bigint) => router.quote(mint, amount).catch(() => null);
    const idle = { sellAmount: 0n, quoteLamports: 0n, sellCostLamports: 0n };
    const settle = (p: PendingRoute, route: RouteQuote | null) => {
      const a = accounts[p.index];
      if (!route) accounts[p.index] = { ...a, ...idle, kind: "unsupported", reason: "no-route" };
      else if (route.outLamports - a.sellCostLamports < minSell || route.outLamports <= a.sellCostLamports) accounts[p.index] = { ...a, ...idle, kind: "worthless" };
      else accounts[p.index] = { ...a, quoteLamports: route.outLamports - a.sellCostLamports, via: { currency: p.currency, amount: p.amount, route } };
    };
    // Portfel moze miec setki takich resztek, a agregator ma limit zapytan. Dlatego najpierw jedno
    // zapytanie na walute (dla najwiekszej kwoty) daje kurs odniesienia; osobno wyceniamy tylko te
    // pozycje, ktore przy tym kursie maja szanse przekroczyc prog oplacalnosci.
    const groups = new Map<string, PendingRoute[]>();
    for (const p of pending) groups.set(p.currency.mint.toBase58(), [...(groups.get(p.currency.mint.toBase58()) ?? []), p]);
    const individual: PendingRoute[] = [];
    await mapLimited([...groups.values()], 4, async (group) => {
      const sorted = [...group].sort((x, y) => (x.amount < y.amount ? 1 : x.amount > y.amount ? -1 : 0));
      const top = sorted[0];
      let reference = await quote(top.currency.mint, top.amount);
      if (reference) settle(top, reference);
      else if (sorted.length > 1) reference = await quote(top.currency.mint, sorted[sorted.length - 1].amount);
      if (!reference) {
        group.forEach((p) => settle(p, null));
        return;
      }
      for (const p of sorted) {
        if (p === top && reference.inAmount === top.amount) continue;
        // Mniejsza kwota ma kurs co najwyzej nieznacznie lepszy, wiec dwukrotny zapas wystarcza.
        const estimate = (p.amount * reference.outLamports) / reference.inAmount;
        if (estimate * 2n < minSell + accounts[p.index].sellCostLamports) accounts[p.index] = { ...accounts[p.index], ...idle, kind: "worthless" };
        else individual.push(p);
      }
    });
    const routes = await mapLimited(individual, 4, (p) => quote(p.currency.mint, p.amount));
    individual.forEach((p, i) => settle(p, routes[i]));
  }

  return {
    owner,
    accounts,
    global,
    feeConfig,
    volumeAccumulator: { exists: accumulatorInfo !== null, rentLamports: rentAccumulator },
    amm,
  };
}
