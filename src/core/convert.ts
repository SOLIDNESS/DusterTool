/**
 * Budowanie transakcji wymiany: sprzedaz martwych tokenow, zamkniecie kont,
 * fee od rentu. Wszystkie instrukcje podpisuje wylacznie wlasciciel portfela.
 */
import { PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import {
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  GLOBAL_CONFIG_PDA,
  OFFLINE_PUMP_AMM_PROGRAM,
  poolV2Pda,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_SDK,
  userVolumeAccumulatorPda as ammVolumeAccumulatorPda,
} from "@pump-fun/pump-swap-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import type { Router } from "./route";
import { isSale, type DustAccount, type ScanResult } from "./scan";
import { measureV1, V1_MAX_ACCOUNTS, V1_MAX_BYTES } from "./v1";
import { guardReserve, MAX_INSTRUCTION_TRACE, traceLength } from "./wallet-guards";

/** Limity transakcji w formacie v0. */
export const MAX_TX_BYTES = 1232;
export const MAX_TX_ACCOUNTS = 64;

/** Format transakcji: v0 (1232 bajty, tabele adresow) albo v1 (4096 bajtow, bez tabel): patrz v1.ts. */
export type TxFormat = "v0" | "v1";

export interface ConvertOptions {
  owner: PublicKey;
  /** Dopuszczalny poslizg sprzedazy w procentach (1 = 1%). */
  slippagePct: number;
  /** Jeden staly odbiorca oplaty buyback pump.fun dla calej paczki, zeby nie mnozyc kont. */
  buybackFeeRecipient?: PublicKey;
  /** To samo dla PumpSwap (portfel odbiorcy; oplata trafia na jego konto w walucie poola). Wymagane dla tokenow po migracji. */
  ammBuybackFeeRecipient?: PublicKey;
  /** Odbiorcy oplaty protokolu, ktorych wymagaja starsze instrukcje sprzedazy (tokeny cashback). */
  feeRecipients?: { normal: PublicKey; mayhem: PublicKey };
  ammFeeRecipients?: { normal: PublicKey; mayhem: PublicKey };
  /** Agregator dla tokenow sparowanych z inna waluta niz SOL (ten sam, ktory wycenil je w skanie). */
  router?: Router;
}

/** Opcje sprzedazy wynikajace ze skanu: stali odbiorcy oplat pump.fun i PumpSwap. */
export function saleOptions(scan: ScanResult, slippagePct: number, router?: Router): ConvertOptions {
  const g = scan.global;
  const a = scan.amm.globalConfig;
  const listed = (keys: PublicKey[]) => keys.find((k) => !k.equals(PublicKey.default));
  return {
    owner: scan.owner,
    slippagePct,
    buybackFeeRecipient: g.buybackFeeRecipients?.[0],
    ammBuybackFeeRecipient: a?.buybackFeeRecipients?.[0],
    feeRecipients: {
      normal: listed([g.feeRecipient, ...g.feeRecipients]) ?? g.feeRecipient,
      mayhem: listed([g.reservedFeeRecipient, ...g.reservedFeeRecipients]) ?? g.reservedFeeRecipient,
    },
    ammFeeRecipients: a
      ? { normal: a.protocolFeeRecipients[0], mayhem: listed([a.reservedFeeRecipient, ...a.reservedFeeRecipients]) ?? a.reservedFeeRecipient }
      : undefined,
    router,
  };
}

export interface ConvertItem {
  account: DustAccount;
  instructions: TransactionInstruction[];
  /** Tabele adresow potrzebne tej pozycji (zamiana waluty kwotowania przez agregator). */
  lookupTables?: AddressLookupTableAccount[];
  /**
   * Czy trasa agregatora prowadzi przez pump.fun lub PumpSwap. Jesli tak, moze po drodze zalozyc
   * uzytkownikowi konto statystyk wolumenu, ktore paczka musi potem zamknac.
   */
  routeUses?: { pump: boolean; amm: boolean };
}

/** Kwota pomniejszona o dopuszczalny poslizg. */
function lessSlippage(amount: bigint, slippagePct: number): bigint {
  return (amount * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
}

/** Instrukcje dla jednego konta: sprzedaz lub spalenie, a potem zamkniecie. */
export async function buildItem(a: DustAccount, opts: ConvertOptions): Promise<ConvertItem | null> {
  const { owner } = opts;
  const close = createCloseAccountInstruction(a.address, owner, owner, [], a.tokenProgram);

  if (a.kind === "empty") return { account: a, instructions: [close] };

  if (a.kind === "worthless") {
    const burn = createBurnInstruction(a.address, a.mint, owner, a.amount, [], a.tokenProgram);
    return { account: a, instructions: [burn, close] };
  }

  if (a.kind !== "curve" && a.kind !== "graduated") return null;

  // Token sparowany z inna waluta niz SOL: sprzedaz daje te walute na koncie ATA uzytkownika,
  // a agregator w tej samej transakcji zamienia ja na wSOL. Kont, ktorych uzytkownik nie mial,
  // nie zostawiamy: konto waluty zamykamy zaraz po zamianie.
  const currency = a.via?.currency;
  const before: TransactionInstruction[] = [];
  const after: TransactionInstruction[] = [];
  let lookupTables: AddressLookupTableAccount[] | undefined;
  let routeUses: ConvertItem["routeUses"];
  if (a.via && currency) {
    const route = await opts.router?.instructions(a.via.route, owner);
    if (!route) return null;
    const ata = (address: PublicKey, wallet: PublicKey) =>
      createAssociatedTokenAccountIdempotentInstruction(owner, address, wallet, currency.mint, currency.tokenProgram);
    if (!currency.userAccount.exists) {
      before.push(ata(currency.userAccount.address, owner));
      after.push(createCloseAccountInstruction(currency.userAccount.address, owner, owner, [], currency.tokenProgram));
    }
    const buyback = a.kind === "curve" ? currency.curveBuybackAccount : currency.ammBuybackAccount;
    const buybackWallet = a.kind === "curve" ? opts.buybackFeeRecipient : opts.ammBuybackFeeRecipient;
    if (!buyback || !buybackWallet) return null;
    if (!buyback.exists) before.push(ata(buyback.address, buybackWallet));
    before.push(route.ledger);
    after.unshift(route.swap);
    lookupTables = route.lookupTables;
    const through = (program: PublicKey) => route.swap.keys.some((k) => k.pubkey.equals(program));
    routeUses = { pump: through(PUMP_PROGRAM_ID), amm: through(PUMP_AMM_PROGRAM_ID) };
  }
  // Minimalna wyplata ze sprzedazy, w walucie kwotowania (dla SOL: w lamportach, przed odjeciem kosztow).
  const minOut = new BN(lessSlippage(a.via ? a.via.amount : a.quoteLamports + a.sellCostLamports, opts.slippagePct).toString());
  const amount = new BN(a.sellAmount.toString());
  const item = (sell: TransactionInstruction[], rest: TransactionInstruction[] = []): ConvertItem => ({
    account: a,
    instructions: [...before, ...sell, ...after, ...rest, close],
    lookupTables,
    routeUses,
  });

  if (a.kind === "curve" && a.bondingCurve) {
    // Sprzedaz na krzywej dziala wylacznie na koncie ATA wlasciciela; skaner oznacza inne konta jako nieobslugiwane.
    const ata = getAssociatedTokenAddressSync(a.mint, owner, true, a.tokenProgram);
    if (!ata.equals(a.address)) return null;
    // Reszte, ktorej krzywa nie jest w stanie wyplacic, palimy, zeby dalo sie zamknac konto.
    const rest = a.amount - a.sellAmount;
    const burnRest = rest > 0n ? [createBurnInstruction(a.address, a.mint, owner, rest, [], a.tokenProgram)] : [];

    if (a.bondingCurve.isCashbackCoin) {
      // Tokenow cashback nie obsluguje sell_v3. Starsza instrukcja `sell` przyjmuje je z kontem
      // statystyk sprzedajacego, na ktore trafia cashback (czesc oplaty przypadajaca tworcy).
      if (currency || !opts.feeRecipients || !opts.buybackFeeRecipient) return null;
      const sell = await PUMP_SDK.getSellInstructionRaw({
        user: owner,
        mint: a.mint,
        creator: a.bondingCurve.creator,
        amount,
        solAmount: minOut,
        feeRecipient: a.bondingCurve.isMayhemMode ? opts.feeRecipients.mayhem : opts.feeRecipients.normal,
        buybackFeeRecipient: opts.buybackFeeRecipient,
        tokenProgram: a.tokenProgram,
        cashback: true,
      });
      return item([sell], burnRest);
    }
    const sell = await PUMP_SDK.getSellV3InstructionRaw({
      user: owner,
      mint: a.mint,
      amount,
      quoteAmount: minOut,
      tokenProgram: a.tokenProgram,
      quoteMint: a.bondingCurve.quoteMint,
      quoteTokenProgram: currency?.tokenProgram ?? TOKEN_PROGRAM_ID,
      buybackFeeRecipient: opts.buybackFeeRecipient,
    });
    return item([sell], burnRest);
  }

  if (a.kind === "graduated" && a.amm && opts.ammBuybackFeeRecipient) {
    // PumpSwap wyplaca w walucie poola na konto uzytkownika. Dla SOL jest to konto wSOL, ktore
    // zaklada i zamyka (zamieniajac wSOL na SOL) otoczka paczki: patrz batchWrappers.
    const { pool, poolKey } = a.amm;
    const quoteMint = currency?.mint ?? NATIVE_MINT;
    const quoteTokenProgram = currency?.tokenProgram ?? TOKEN_PROGRAM_ID;
    const quoteAta = (wallet: PublicKey) => getAssociatedTokenAddressSync(quoteMint, wallet, true, quoteTokenProgram);
    const common = {
      pool: poolKey,
      user: owner,
      globalConfig: GLOBAL_CONFIG_PDA,
      baseMint: a.mint,
      quoteMint,
      userBaseTokenAccount: a.address,
      userQuoteTokenAccount: quoteAta(owner),
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      baseTokenProgram: a.tokenProgram,
      quoteTokenProgram,
      systemProgram: SystemProgram.programId,
      eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: PUMP_AMM_PROGRAM_ID,
    };

    if (pool.isCashbackCoin) {
      // Jak na krzywej: tokeny cashback przyjmuje tylko starsza instrukcja `sell`, z kontem
      // statystyk sprzedajacego i jego kontem wSOL (tam trafia cashback) na liscie dodatkowych kont.
      if (currency || !opts.ammFeeRecipients) return null;
      const feeRecipient = pool.isMayhemMode ? opts.ammFeeRecipients.mayhem : opts.ammFeeRecipients.normal;
      const vaultAuthority = coinCreatorVaultAuthorityPda(pool.coinCreator);
      const accumulator = ammVolumeAccumulatorPda(owner);
      const extra = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isWritable, isSigner: false });
      const sell = await OFFLINE_PUMP_AMM_PROGRAM.methods
        .sell(amount, minOut)
        .accountsPartial({
          ...common,
          protocolFeeRecipient: feeRecipient,
          protocolFeeRecipientTokenAccount: quoteAta(feeRecipient),
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          coinCreatorVaultAta: coinCreatorVaultAtaPda(vaultAuthority, quoteMint, quoteTokenProgram),
          coinCreatorVaultAuthority: vaultAuthority,
        })
        .remainingAccounts([
          extra(quoteAta(accumulator), true),
          extra(accumulator, true),
          ...(pool.coinCreator.equals(PublicKey.default) ? [] : [extra(poolV2Pda(pool.baseMint), false)]),
          extra(opts.ammBuybackFeeRecipient, false),
          extra(quoteAta(opts.ammBuybackFeeRecipient), true),
        ])
        .instruction();
      return item([sell]);
    }
    const sell = await OFFLINE_PUMP_AMM_PROGRAM.methods
      .sellV2(amount, minOut)
      .accountsStrict({
        ...common,
        userVolumeAccumulator: ammVolumeAccumulatorPda(owner),
        feeConfig: PUMP_AMM_FEE_CONFIG_PDA,
        buybackFeeRecipient: quoteAta(opts.ammBuybackFeeRecipient),
      })
      .instruction();
    return item([sell]);
  }

  return null;
}

/**
 * Instrukcje otaczajace sprzedaze w jednej paczce. Dzieki nim kazda paczka jest samodzielna:
 * mozna ja wyslac w dowolnej kolejnosci, a przerwanie wymiany w polowie niczego w portfelu
 * nie zostawia.
 */
export interface BatchWrappers {
  /**
   * Konto wSOL uzytkownika. PumpSwap i agregator wyplacaja wSOL, a nie SOL, wiec przed sprzedazami
   * konto zakladamy, a po nich zamykamy, co zamienia wSOL na zwykly SOL w portfelu (depozyt wraca
   * w calosci). Jesli uzytkownik mial juz takie konto, po zamknieciu odtwarzamy je z dokladnie tym
   * samym saldem, zeby jego wlasny wSOL nie zostal policzony jako przychod ze sprzedazy.
   */
  wsol: { before: TransactionInstruction[]; after: TransactionInstruction[] };
  /**
   * Konta statystyk wolumenu pump.fun i PumpSwap. Sprzedaz zaklada je na koszt uzytkownika; jesli
   * ich nie mial, po sprzedazach je zamykamy i depozyt wraca. `ensure` zaklada konto, gdyby nie
   * zrobila tego zadna instrukcja paczki (zamkniecie nieistniejacego konta zatrzymaloby transakcje);
   * `claim` wyplaca cashback zebrany na koncie PumpSwap, zanim zostanie ono zamkniete.
   * null, gdy uzytkownik mial juz dane konto: wtedy go nie ruszamy.
   */
  pumpAccumulator: { ensure: TransactionInstruction; close: TransactionInstruction } | null;
  ammAccumulator: { ensure: TransactionInstruction; claim: TransactionInstruction; close: TransactionInstruction } | null;
}

export async function batchWrappers(scan: ScanResult): Promise<BatchWrappers> {
  const owner = scan.owner;
  const { wsolAccount } = scan.amm;
  const wsol = wsolAccount.address;
  const create = createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT);
  const after: TransactionInstruction[] = [createCloseAccountInstruction(wsol, owner, owner)];
  if (wsolAccount.exists) {
    after.push(create);
    if (wsolAccount.amount > 0n) {
      after.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: wsolAccount.amount }), createSyncNativeInstruction(wsol));
    }
  }
  return {
    wsol: { before: wsolAccount.exists ? [] : [create], after },
    pumpAccumulator: scan.volumeAccumulator.exists
      ? null
      : { ensure: await PUMP_SDK.initUserVolumeAccumulator({ payer: owner, user: owner }), close: await PUMP_SDK.closeUserVolumeAccumulator(owner) },
    ammAccumulator: scan.amm.volumeAccumulator.exists
      ? null
      : {
          ensure: await PUMP_AMM_SDK.initUserVolumeAccumulator({ payer: owner, user: owner }),
          claim: await OFFLINE_PUMP_AMM_PROGRAM.methods
            .claimCashback()
            .accountsPartial({ user: owner, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, userWsolTokenAccount: wsol })
            .instruction(),
          close: await PUMP_AMM_SDK.closeUserVolumeAccumulator(owner),
        },
  };
}

export interface BatchPlanOptions {
  owner: PublicKey;
  treasury: PublicKey;
  /** Fee od odzyskanego rentu w punktach bazowych (500 = 5%). */
  rentFeeBps: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** Tabele adresow; uzywane tylko w formacie v0. */
  lookupTables?: AddressLookupTableAccount[];
  /** Format skladanych transakcji; domyslnie v0. */
  format?: TxFormat;
  /** Domyslnie limity wybranego formatu. */
  maxBytes?: number;
  maxAccounts?: number;
  /**
   * Miejsce zostawiane w kazdej paczce dla portfela. Portfele dopisuja do podpisywanej transakcji
   * wlasne instrukcje kontrolne; gdy transakcja jest wypelniona do limitu, nie maja na nie miejsca
   * i pokazuja ostrzezenie, ze nie moga sprawdzic transakcji. Pozycja, ktora sama nie miesci sie
   * z tym zapasem (dluga trasa zamiany), dostaje i tak wlasna paczke.
   */
  reserveBytes?: number;
  reserveAccounts?: number;
  /**
   * Zapas liczony dla kazdej paczki z osobna, na instrukcje kontrolne Phantoma (rosna z liczba
   * pozycji): patrz wallet-guards.ts. Zastepuje staly zapas i dotyczy takze paczek z jedna pozycja.
   * Paczka musi tez zmiescic sie z tymi instrukcjami w limicie 64 wykonywanych instrukcji.
   */
  walletGuards?: boolean;
  /** Uzytkownik nie ma konta DUSTER: zalozy je pierwsza sprzedaz (dodatkowe zagniezdzone wywolania). */
  createsDusterAccount?: boolean;
  /**
   * Limit jednostek obliczen dla paczek z zamiana waluty kwotowania przez agregator: trasa przez
   * zewnetrzne gieldy zuzywa ich wyraznie wiecej niz sama sprzedaz. Domyslnie `computeUnitLimit`.
   */
  routedComputeUnitLimit?: number;
  /** Instrukcje otaczajace sprzedaze (konto wSOL, konta statystyk): patrz batchWrappers. */
  wrappers?: BatchWrappers;
  /**
   * Instrukcje otaczajace pozycje paczki. Tak wpinamy program Duster:
   * `before` konczy sie na begin_convert, `after` zaczyna od finish_convert.
   */
  wrap?: (items: ConvertItem[]) => { before: TransactionInstruction[]; after: TransactionInstruction[] };
  /**
   * true, gdy fee od rentu pobiera program w finish_convert. Wtedy paczka nie
   * zawiera osobnego przelewu, a `feeLamports` sluzy tylko do podgladu.
   */
  feeCollectedByProgram?: boolean;
  /** Kazda paczka kupuje DUSTER, takze bez sprzedazy: odzyskane depozyty ida na DUSTER. */
  rentToDuster?: boolean;
}

export interface Batch {
  items: ConvertItem[];
  rentLamports: number;
  feeLamports: number;
  expectedSaleLamports: bigint;
  instructions: TransactionInstruction[];
  /** Tabele adresow, z ktorymi trzeba zlozyc transakcje: wspolne i wlasne pozycji tej paczki. */
  lookupTables: AddressLookupTableAccount[];
  format: TxFormat;
  bytes: number;
  accounts: number;
}

export function rentFee(rentLamports: number, rentFeeBps: number): number {
  return Math.floor((rentLamports * rentFeeBps) / 10_000);
}

function assemble(items: ConvertItem[], o: BatchPlanOptions): TransactionInstruction[] {
  const rent = items.reduce((s, it) => s + it.account.rentLamports, 0);
  const fee = rentFee(rent, o.rentFeeBps);
  const wrap = o.wrap?.(items);
  const w = o.wrappers;
  const routed = items.some((it) => it.account.via);
  const ammCashback = items.some((it) => it.account.kind === "graduated" && it.account.cashback);
  // Kto w tej paczce dotyka kont statystyk wolumenu: sprzedaz za SOL zawsze je zaklada (to
  // zmierzone), sprzedaz za inna walute i trasa agregatora przez pump.fun moga, ale nie musza.
  const sure = (kind: DustAccount["kind"]) => items.some((it) => it.account.kind === kind && !it.account.via);
  const maybe = (kind: DustAccount["kind"], program: "pump" | "amm") =>
    items.some((it) => it.account.via && (it.account.kind === kind || it.routeUses?.[program]));
  // Wynik w wSOL daje kazda sprzedaz na PumpSwap i kazda zamiana przez agregator.
  const wsol = sure("graduated") || routed ? w?.wsol : undefined;
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: routed ? (o.routedComputeUnitLimit ?? o.computeUnitLimit) : o.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.computeUnitPriceMicroLamports }),
    ...(wrap?.before ?? []),
    ...(wsol?.before ?? []),
    ...items.flatMap((it) => it.instructions),
  ];
  // Konto, ktore mogla zalozyc ta paczka, zamykamy. Gdy nie ma pewnosci, ze powstalo, najpierw je
  // zakladamy (instrukcja nic nie robi, jesli konto juz jest): zamkniecie nieistniejacego konta
  // zatrzymaloby cala transakcje.
  if (w?.pumpAccumulator && (sure("curve") || maybe("curve", "pump"))) {
    if (!sure("curve")) ixs.push(w.pumpAccumulator.ensure);
    ixs.push(w.pumpAccumulator.close);
  }
  if (w?.ammAccumulator && (sure("graduated") || maybe("graduated", "amm"))) {
    if (!sure("graduated")) ixs.push(w.ammAccumulator.ensure);
    if (ammCashback) ixs.push(w.ammAccumulator.claim);
    ixs.push(w.ammAccumulator.close);
  }
  ixs.push(...(wsol?.after ?? []));
  if (fee > 0 && !o.feeCollectedByProgram) {
    ixs.push(SystemProgram.transfer({ fromPubkey: o.owner, toPubkey: o.treasury, lamports: fee }));
  }
  ixs.push(...(wrap?.after ?? []));
  return ixs;
}

/** Tabele adresow paczki: wspolne oraz te, ktorych wymagaja jej pozycje (bez powtorzen). */
function batchTables(items: ConvertItem[], o: BatchPlanOptions): AddressLookupTableAccount[] {
  if (o.format === "v1") return [];
  const out = new Map<string, AddressLookupTableAccount>();
  for (const t of [...(o.lookupTables ?? []), ...items.flatMap((it) => it.lookupTables ?? [])]) out.set(t.key.toBase58(), t);
  return [...out.values()];
}

export interface TxSize {
  bytes: number;
  accounts: number;
  /** Ile kont transakcja otwiera do zapisu. */
  writable: number;
}

/** Rozmiar zserializowanej transakcji i liczba kont; null, gdy nie da sie jej zlozyc. */
export function measure(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  lookupTables: AddressLookupTableAccount[] = [],
  format: TxFormat = "v0",
): TxSize | null {
  if (format === "v1") return measureV1(instructions, payer);
  try {
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions,
    }).compileToV0Message(lookupTables);
    const bytes = new VersionedTransaction(msg).serialize().length;
    const looked = msg.addressTableLookups.reduce((s, l) => s + l.writableIndexes.length + l.readonlyIndexes.length, 0);
    const h = msg.header;
    const writable =
      msg.staticAccountKeys.length -
      h.numReadonlySignedAccounts -
      h.numReadonlyUnsignedAccounts +
      msg.addressTableLookups.reduce((s, l) => s + l.writableIndexes.length, 0);
    return { bytes, accounts: msg.staticAccountKeys.length + looked, writable };
  } catch {
    return null;
  }
}

/** Instrukcje transakcji dla podanych pozycji, razem z otoczka paczki. */
export function assembleBatch(items: ConvertItem[], o: BatchPlanOptions): TransactionInstruction[] {
  return assemble(items, o);
}

/** Rozmiar transakcji zlozonej z podanych pozycji (z otoczka paczki); null, gdy nie da sie jej zlozyc. */
export function measureBatch(items: ConvertItem[], o: BatchPlanOptions): TxSize | null {
  return measure(assemble(items, o), o.owner, batchTables(items, o), o.format);
}

function limitsOfFormat(o: BatchPlanOptions): { bytes: number; accounts: number } {
  const v1 = o.format === "v1";
  return { bytes: o.maxBytes ?? (v1 ? V1_MAX_BYTES : MAX_TX_BYTES), accounts: o.maxAccounts ?? (v1 ? V1_MAX_ACCOUNTS : MAX_TX_ACCOUNTS) };
}

/** Czy pozycje mieszcza sie razem w jednej transakcji (bez zapasu dla portfela). */
export function fitsInTransaction(items: ConvertItem[], o: BatchPlanOptions): boolean {
  const m = measureBatch(items, o);
  const max = limitsOfFormat(o);
  return m !== null && m.bytes <= max.bytes && m.accounts <= max.accounts;
}

/** Dzieli pozycje na paczki mieszczace sie w limitach jednej transakcji. */
export function planBatches(items: ConvertItem[], o: BatchPlanOptions): Batch[] {
  const max = limitsOfFormat(o);
  // Konto DUSTER zaklada pierwsza paczka, ktora cos kupuje (paczki z zapasem dla portfela ida po
  // kolei), wiec tylko ona potrzebuje miejsca na dodatkowe zagniezdzone wywolania. Gdyby ta paczka
  // odpadla, kolejna jest sprawdzana jeszcze raz przed podpisem, na wyniku symulacji.
  let dusterAccountPending = o.createsDusterAccount ?? false;
  // Zapas dla portfela obowiazuje przy dokladaniu kolejnych pozycji; pojedyncza pozycja, ktora
  // sie z nim nie miesci, moze zajac cala transakcje.
  const fits = (list: ConvertItem[]): TxSize | null => {
    const m = measureBatch(list, o);
    if (!m || m.bytes > max.bytes || m.accounts > max.accounts) return null;
    if (list.length === 1 && !o.walletGuards) return m;
    const reserve = o.walletGuards ? guardReserve(list, o.rentToDuster) : { bytes: o.reserveBytes ?? 0, accounts: o.reserveAccounts ?? 0 };
    const roomy =
      m.bytes + reserve.bytes <= max.bytes &&
      m.accounts + reserve.accounts <= max.accounts &&
      (!o.walletGuards || traceLength(assemble(list, o), o.owner, list, { createsDusterAccount: dusterAccountPending }) <= MAX_INSTRUCTION_TRACE);
    return roomy || list.length === 1 ? m : null;
  };

  const batches: Batch[] = [];
  let current: ConvertItem[] = [];
  const flush = () => {
    if (!current.length) return;
    const m = fits(current)!;
    const rent = current.reduce((s, it) => s + it.account.rentLamports, 0);
    batches.push({
      items: current,
      rentLamports: rent,
      feeLamports: rentFee(rent, o.rentFeeBps),
      expectedSaleLamports: current.reduce((s, it) => s + it.account.quoteLamports, 0n),
      instructions: assemble(current, o),
      lookupTables: batchTables(current, o),
      format: o.format ?? "v0",
      bytes: m.bytes,
      accounts: m.accounts,
    });
    if (o.rentToDuster || current.some((it) => isSale(it.account.kind))) dusterAccountPending = false;
    current = [];
  };

  for (const item of items) {
    if (fits([...current, item])) {
      current.push(item);
      continue;
    }
    flush();
    if (!fits([item])) throw new Error(`Pozycja ${item.account.mint.toBase58()} nie miesci sie w transakcji`);
    current.push(item);
  }
  flush();

  return batches;
}

/**
 * Wirtualna tabela adresow do samego pomiaru rozmiaru transakcji. Nie istnieje
 * w sieci, wiec transakcji z nia nie da sie wyslac ani zasymulowac.
 */
export function virtualLookupTable(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: PublicKey.unique(),
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

/** Adresy wystepujace w instrukcjach wiecej niz jednej pozycji: kandydaci do tabeli adresow. */
export function sharedAddresses(items: ConvertItem[], exclude: PublicKey[] = []): PublicKey[] {
  const skip = new Set(exclude.map((k) => k.toBase58()));
  const seenIn = new Map<string, Set<number>>();
  items.forEach((it, i) => {
    for (const ix of it.instructions) {
      for (const key of [ix.programId, ...ix.keys.map((k) => k.pubkey)]) {
        const s = key.toBase58();
        if (!seenIn.has(s)) seenIn.set(s, new Set());
        seenIn.get(s)!.add(i);
      }
    }
  });
  return [...seenIn.entries()]
    .filter(([key, set]) => set.size > 1 && !skip.has(key))
    .map(([key]) => new PublicKey(key));
}

export function toTransaction(
  batch: Batch,
  payer: PublicKey,
  recentBlockhash: string,
  lookupTables: AddressLookupTableAccount[] = batch.lookupTables,
): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions: batch.instructions }).compileToV0Message(
    lookupTables,
  );
  return new VersionedTransaction(msg);
}
