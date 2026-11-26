/**
 * Zawartosc tabeli adresow (ALT): stale konta programu i poola oraz konta
 * pump.fun i PumpSwap wspolne dla sprzedazy roznych tokenow. Do tabeli nie trafia
 * nic zaleznego od portfela uzytkownika, bo ma ona sluzyc wszystkim.
 */
import { userVolumeAccumulatorPda } from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  userVolumeAccumulatorPda as ammVolumeAccumulatorPda,
} from "@pump-fun/pump-swap-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildItem, saleOptions, sharedAddresses, type ConvertItem } from "./convert";
import type { Deployment } from "./deployment";
import { programLookupAddresses } from "./program-convert";
import { JUPITER_EVENT_AUTHORITY, JUPITER_PROGRAM_ID } from "./route";
import type { ScanResult } from "./scan";

/**
 * Konta pump.fun i PumpSwap powtarzajace sie w sprzedazach roznych tokenow. Wyznaczamy je
 * na tokenach z dowolnego portfela, ale dla losowego wlasciciela: wszystko, co
 * powtarza sie mimo to, nie zalezy od portfela.
 */
export async function pumpSharedAddresses(sample: ScanResult, limit = 16): Promise<PublicKey[]> {
  const owners = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const items: ConvertItem[] = [];
  const sells = [
    ...sample.accounts.filter((a) => a.kind === "curve").slice(0, limit),
    ...sample.accounts.filter((a) => a.kind === "graduated").slice(0, limit),
  ];
  for (const [i, a] of sells.entries()) {
    // Dwoch roznych wlascicieli na zmiane: adres wspolny musi wystapic u obu.
    const owner = owners[i % 2];
    const address = getAssociatedTokenAddressSync(a.mint, owner, true, a.tokenProgram);
    // Tokeny sparowane z inna waluta pomijamy: ich konta zaleza od trasy agregatora.
    if (a.via) continue;
    const item = await buildItem({ ...a, address }, { ...saleOptions(sample, 2), owner });
    if (item) items.push(item);
  }
  const perWallet = owners.flatMap((o) => [o, userVolumeAccumulatorPda(o), ammVolumeAccumulatorPda(o), getAssociatedTokenAddressSync(NATIVE_MINT, o, true)]);
  const candidates = sharedAddresses(items, perWallet);
  // Zostaja tylko adresy uzyte przez obu wlascicieli.
  const usedBy = (owner: PublicKey) =>
    new Set(
      items
        .filter((it) => it.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(owner))))
        .flatMap((it) => it.instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]))
        .map((k) => k.toBase58()),
    );
  const [a, b] = owners.map(usedBy);
  return candidates.filter((k) => a.has(k.toBase58()) && b.has(k.toBase58()));
}

/**
 * Stale konta pump.fun i PumpSwap potrzebne przy sprzedazy niezaleznie od tokena, takze te, ktorych
 * wymagaja starsze instrukcje dla tokenow cashback (odbiorcy oplaty protokolu i ich konta wSOL).
 * Wpisane wprost, zeby tabela nie zalezala od tego, jakie tokeny ma akurat portfel wzorcowy.
 */
export function ammLookupAddresses(sample: ScanResult): PublicKey[] {
  const sale = saleOptions(sample, 0);
  const wsol = (wallet: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  const present = (keys: (PublicKey | undefined)[]) => keys.filter((k): k is PublicKey => k !== undefined);
  const ammWallets = present([sale.ammBuybackFeeRecipient, sale.ammFeeRecipients?.normal, sale.ammFeeRecipients?.mayhem]);
  return [
    PUMP_AMM_PROGRAM_ID,
    GLOBAL_CONFIG_PDA,
    PUMP_AMM_FEE_CONFIG_PDA,
    PUMP_AMM_EVENT_AUTHORITY_PDA,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    ...ammWallets.flatMap((w) => [w, wsol(w)]),
    ...present([sale.buybackFeeRecipient, sale.feeRecipients?.normal, sale.feeRecipients?.mayhem]),
  ];
}

/**
 * Konta Jupitera, na ktorych zapisuje on saldo sprzed zamiany ("token ledger"). API wybiera jedno
 * z nich losowo; sa stale, wiec trzymamy w tabeli wszystkie.
 */
const JUPITER_TOKEN_LEDGERS = [
  "FhLPkpFmszHtSyyayj7KsXNZeBTqfQbUPmvgWAyJHBXh",
  "HxTk98CmBcxmtkrBWqRszYxrnDpqAsbitQBc2QjVBG3j",
  "HtncvpUBGhSrs48KtC58ntJcTDw53sn78Lpq71zVwiez",
  "CnUPHtfUVw3D2s4FB8H6QBuLwoes8YxauVgDtFybm7rz",
].map((k) => new PublicKey(k));

/** Najczestsze waluty kwotowania pump.fun inne niz SOL. */
const COMMON_QUOTE_CURRENCIES = [
  { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), tokenProgram: TOKEN_PROGRAM_ID },
  { mint: new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"), tokenProgram: TOKEN_2022_PROGRAM_ID },
];

/**
 * Stale konta potrzebne przy sprzedazy tokenow sparowanych z inna waluta niz SOL: konta Jupitera
 * oraz, dla najczestszych walut, konta oplat pump.fun i PumpSwap w tych walutach. Transakcja z
 * zamiana przez agregator ledwo miesci sie w limicie, wiec kazdy adres w tabeli sie liczy.
 */
export function routeLookupAddresses(sample: ScanResult): PublicKey[] {
  const sale = saleOptions(sample, 0);
  const wallets = [sale.buybackFeeRecipient, sale.ammBuybackFeeRecipient].filter((k): k is PublicKey => k !== undefined);
  return [
    JUPITER_PROGRAM_ID,
    JUPITER_EVENT_AUTHORITY,
    ...JUPITER_TOKEN_LEDGERS,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ...COMMON_QUOTE_CURRENCIES.flatMap((c) => [c.mint, ...wallets.map((w) => getAssociatedTokenAddressSync(c.mint, w, true, c.tokenProgram))]),
  ];
}

/** Pelna lista adresow do tabeli dla danego wdrozenia. */
export async function lookupAddresses(d: Deployment, sample: ScanResult): Promise<PublicKey[]> {
  const all = [
    ...programLookupAddresses(d.refs, d.treasury),
    ...ammLookupAddresses(sample),
    ...routeLookupAddresses(sample),
    ...(await pumpSharedAddresses(sample)),
  ];
  return [...new Map(all.map((k) => [k.toBase58(), k])).values()];
}
