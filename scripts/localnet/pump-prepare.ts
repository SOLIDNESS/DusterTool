/**
 * Przygotowuje probe generalna wymiany na lokalnym walidatorze z prawdziwym
 * programem pump.fun i prawdziwymi martwymi tokenami skopiowanymi z mainnetu.
 *
 * Z mainnetu tylko czytamy. Konta tokenow przykladowego portfela sa zapisywane
 * do plikow z podmienionym wlascicielem na jednorazowy klucz testowy, a konta
 * pump.fun potrzebne do sprzedazy sa kopiowane bez zmian (poza doplata lamportow,
 * bo lokalny walidator liczy depozyt wedlug starej, wyzszej stawki).
 *
 * Uzycie: npx tsx scripts/localnet/pump-prepare.ts [portfel] [ile z krzywej] [ile do spalenia] [ile pustych] [ile po migracji]
 *           [--extra <portfel>:<mint> ...]
 * `--extra` doklada pojedynczy token z innego portfela (np. tokeny cashback, ktorych portfel
 * przykladowy nie ma). Tokeny sparowane z inna waluta niz SOL sa pomijane: ich zamiana idzie
 * przez zewnetrzne gieldy, ktorych lokalnie nie odtworzymy (sprawdza je scripts/dev/sim-token.ts).
 * Potem: npm run localnet:pump  oraz  npm run rehearsal
 */
import {
  bondingCurvePda,
  FEE_PROGRAM_GLOBAL_PDA,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import { GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda as ammVolumeAccumulatorPda } from "@pump-fun/pump-swap-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { batchWrappers, buildItem, saleOptions } from "../../src/core/convert";
import { getAccountsChunked } from "../../src/core/rpc";
import { scanWallet, type DustAccount, type ScanResult } from "../../src/core/scan";
import { connection, OUT_DIR } from "../lib/env";

const DIR = path.join(OUT_DIR, "localnet-pump");
/** Zapas na roznice miedzy depozytem na mainnecie a starsza stawka lokalnego walidatora. */
const LAMPORT_BUMP = 1_000_000;
const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
/** Programy, ktore lokalny walidator ma wbudowane; wersji z mainnetu nie kopiujemy. */
const BUILTIN = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

function accountFile(pubkey: PublicKey, info: AccountInfo<Buffer>, data: Buffer, lamports: number): string {
  const file = path.join(DIR, "accounts", `${pubkey.toBase58()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: {
        lamports,
        data: [data.toString("base64"), "base64"],
        owner: info.owner.toBase58(),
        executable: false,
        rentEpoch: 18446744073709551615,
        space: data.length,
      },
    }).replace('"rentEpoch":18446744073709552000', '"rentEpoch":18446744073709551615'),
  );
  return file;
}

async function main() {
  const argv = process.argv.slice(2);
  const extras: { owner: PublicKey; mint: PublicKey }[] = [];
  for (let i = argv.indexOf("--extra"); i >= 0; i = argv.indexOf("--extra")) {
    const [owner, mint] = argv.splice(i, 2)[1].split(":");
    extras.push({ owner: new PublicKey(owner), mint: new PublicKey(mint) });
  }
  const sample = new PublicKey(argv[0] ?? "Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUpA");
  const want = {
    curve: Number(argv[1] ?? 9),
    worthless: Number(argv[2] ?? 4),
    empty: Number(argv[3] ?? 3),
    graduated: Number(argv[4] ?? 4),
  };
  const conn = connection();

  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, "accounts"), { recursive: true });
  const tester = Keypair.generate();
  fs.writeFileSync(path.join(DIR, "tester.json"), JSON.stringify(Array.from(tester.secretKey)), { mode: 0o600 });

  const scan = await scanWallet(conn, sample);
  const pick = (kind: DustAccount["kind"], n: number) =>
    scan.accounts.filter((a) => a.kind === kind && a.quoteLamports <= 60_000_000n).slice(0, n);
  const selected = [
    ...pick("curve", want.curve),
    ...pick("graduated", want.graduated),
    ...pick("worthless", want.worthless),
    ...pick("empty", want.empty),
  ];
  for (const extra of extras) {
    const other = await scanWallet(conn, extra.owner);
    const found = other.accounts.find((a) => a.mint.equals(extra.mint) && a.kind !== "unsupported" && !selected.some((s) => s.mint.equals(a.mint)));
    if (found) selected.push(found);
    else console.log(`pominiety dodatkowy token ${extra.mint.toBase58()}: brak w portfelu albo nieobslugiwany`);
  }
  const n = (kind: DustAccount["kind"], cashback: boolean) => selected.filter((a) => a.kind === kind && Boolean(a.cashback) === cashback).length;
  console.log(
    `wybrane konta: krzywa ${n("curve", false)} (+${n("curve", true)} cashback), po migracji ${n("graduated", false)} (+${n("graduated", true)} cashback), ` +
      `do spalenia ${selected.filter((a) => a.kind === "worthless").length}, puste ${selected.filter((a) => a.kind === "empty").length}`,
  );

  // 1. Konta tokenow: kopia z podmienionym wlascicielem, pod adresem ATA klucza testowego.
  const tokenInfos = await getAccountsChunked(conn, selected.map((a) => a.address));
  const args: string[] = [];
  // Konta samego portfela testowego: powstaja dopiero w trakcie wymiany, z mainnetu ich nie kopiujemy.
  const testerWsol = getAssociatedTokenAddressSync(NATIVE_MINT, tester.publicKey, true);
  const testerCashback = getAssociatedTokenAddressSync(NATIVE_MINT, ammVolumeAccumulatorPda(tester.publicKey), true);
  const own = new Set<string>([
    tester.publicKey.toBase58(),
    userVolumeAccumulatorPda(tester.publicKey).toBase58(),
    ammVolumeAccumulatorPda(tester.publicKey).toBase58(),
    testerWsol.toBase58(),
    testerCashback.toBase58(),
  ]);
  // Stan swiezego portfela testowego: bez konta wSOL i bez kont statystyk.
  const fresh: ScanResult = {
    ...scan,
    owner: tester.publicKey,
    volumeAccumulator: { ...scan.volumeAccumulator, exists: false },
    amm: {
      ...scan.amm,
      wsolAccount: { address: testerWsol, exists: false, amount: 0n },
      volumeAccumulator: { exists: false },
      cashbackAccount: { address: testerCashback, exists: false },
    },
  };
  const moved: DustAccount[] = [];
  selected.forEach((a, i) => {
    const info = tokenInfos[i];
    if (!info) return;
    const data = Buffer.from(info.data);
    tester.publicKey.toBuffer().copy(data, 32);
    const ata = getAssociatedTokenAddressSync(a.mint, tester.publicKey, true, a.tokenProgram);
    args.push("--account", ata.toBase58(), accountFile(ata, info, data, info.lamports + LAMPORT_BUMP));
    own.add(ata.toBase58());
    moved.push({ ...a, address: ata });
  });

  // 2. Wszystkie konta, ktorych dotykaja instrukcje sprzedazy, plus konta czytane przez skaner.
  const needed = new Map<string, PublicKey>();
  const add = (k: PublicKey) => {
    if (!own.has(k.toBase58())) needed.set(k.toBase58(), k);
  };
  for (const a of moved) {
    const item = await buildItem(a, saleOptions(fresh, 2));
    if (!item) continue;
    for (const ix of item.instructions) {
      add(ix.programId);
      ix.keys.forEach((k) => add(k.pubkey));
    }
    add(a.mint);
    // Skaner rozpoznaje token pump.fun po koncie krzywej, takze gdy token idzie tylko do spalenia.
    if (a.amount > 0n) add(bondingCurvePda(a.mint));
    // Token po migracji skaner wycenia z poola PumpSwap, takze gdy jest wart za malo, zeby go sprzedawac.
    if (a.amm) [a.amm.poolKey, a.amm.pool.poolBaseTokenAccount, a.amm.pool.poolQuoteTokenAccount].forEach(add);
  }
  [GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, FEE_PROGRAM_GLOBAL_PDA].forEach(add);
  // PumpSwap: konfiguracja czytana przez skaner.
  [GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA].forEach(add);
  // Konta z otoczki paczek: konto wSOL, zamkniecie kont statystyk, wyplata cashbacku.
  const wrap = await batchWrappers(fresh);
  const wrapIxs = [
    ...wrap.wsol.before,
    ...wrap.wsol.after,
    ...(wrap.pumpAccumulator ? [wrap.pumpAccumulator.ensure, wrap.pumpAccumulator.close] : []),
    ...(wrap.ammAccumulator ? [wrap.ammAccumulator.ensure, wrap.ammAccumulator.claim, wrap.ammAccumulator.close] : []),
  ];
  for (const ix of wrapIxs) {
    add(ix.programId);
    ix.keys.forEach((k) => add(k.pubkey));
  }

  const keys = [...needed.values()];
  const infos = await getAccountsChunked(conn, keys);
  let programs = 0;
  let accounts = 0;
  let missing = 0;
  keys.forEach((key, i) => {
    const info = infos[i];
    if (!info) {
      missing++;
      return;
    }
    if (info.executable) {
      // Programy wbudowane w walidator (system, token, ATA itd.) pomijamy.
      if (info.owner.toBase58() === BPF_UPGRADEABLE && !BUILTIN.has(key.toBase58())) {
        args.push("--clone-upgradeable-program", key.toBase58());
        programs++;
      }
      return;
    }
    args.push("--account", key.toBase58(), accountFile(key, info, Buffer.from(info.data), info.lamports + LAMPORT_BUMP));
    accounts++;
  });

  fs.writeFileSync(path.join(DIR, "validator-args.txt"), args.join("\n") + "\n");
  fs.writeFileSync(
    path.join(DIR, "expected.json"),
    JSON.stringify(
      {
        sample: sample.toBase58(),
        tester: tester.publicKey.toBase58(),
        items: moved.map((a) => ({ mint: a.mint.toBase58(), kind: a.kind, amount: a.amount.toString(), quoteLamports: a.quoteLamports.toString() })),
      },
      null,
      2,
    ),
  );
  console.log(`klucz testowy: ${tester.publicKey.toBase58()}`);
  console.log(`konta tokenow: ${moved.length}, konta pump.fun: ${accounts}, programy: ${programs}, nieistniejace na mainnecie: ${missing}`);
  console.log(`zapisano: ${DIR}`);
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 2000) ?? e);
  process.exit(1);
});
