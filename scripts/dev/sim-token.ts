/**
 * Narzedzie deweloperskie: symuluje na mainnecie sprzedaz pojedynczych tokenow z dowolnego
 * portfela (kazdy w osobnej transakcji, z otoczka paczki) i porownuje wynik z wycena skanera.
 * Obejmuje wszystkie rodzaje sprzedazy: krzywa, PumpSwap, tokeny cashback i tokeny sparowane
 * z inna waluta niz SOL (zamiana przez agregator).
 *
 *   npx tsx scripts/dev/sim-token.ts <portfel> [poczatek minta ...] [--limit N] [--max SOL] [--only routed|cashback] [--flows] [--summary] [--fresh]
 *
 * `--fresh` sklada otoczke tak, jakby portfel nie mial kont statystyk pump.fun i PumpSwap (sa wtedy
 * zakladane w razie potrzeby i zamykane). Sprawdza to poprawnosc tych instrukcji na portfelu, ktory
 * konta juz ma; wynik jest wtedy wiekszy od wyceny o depozyty zamknietych kont.
 *
 * Wylacznie odczyt i symulacja: niczego nie podpisujemy.
 */
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { batchWrappers, buildItem, measureBatch, planBatches, saleOptions, toTransaction, virtualLookupTable, type BatchPlanOptions } from "../../src/core/convert";
import { lookupAddresses } from "../../src/core/lookup";
import { programPlanOptions } from "../../src/core/program-convert";
import { jupiterRouter } from "../../src/core/route";
import { withRetry } from "../../src/core/rpc";
import { isSale, scanWallet } from "../../src/core/scan";
import { loadDeployment } from "../lib/deployment";
import { connection, sleep } from "../lib/env";
import { simulateStable } from "../lib/sim";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const limit = Number(flag("--limit") ?? 12);
  const maxLamports = BigInt(Math.round(Number(flag("--max") ?? 1000) * LAMPORTS_PER_SOL));
  const only = flag("--only");
  const flows = args.includes("--flows");
  const summary = args.includes("--summary");
  const fresh = args.includes("--fresh");
  const [ownerArg, ...prefixes] = args.filter((a) => !a.startsWith("--"));
  const owner = new PublicKey(ownerArg);
  const conn = connection();
  const router = jupiterRouter(conn);

  const scan = await scanWallet(conn, owner, { router });
  const tally = new Map<string, number>();
  for (const a of scan.accounts) {
    const label = a.kind === "unsupported" ? `nieobslugiwane (${a.reason})` : a.kind + (a.via ? " przez walute" : "") + (a.cashback && isSale(a.kind) ? " cashback" : "");
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  console.log([...tally].map(([k, n]) => `${k}: ${n}`).join(", "));
  console.log(
    `konto statystyk pump.fun: ${scan.volumeAccumulator.exists ? "jest" : "brak"}, PumpSwap: ${scan.amm.volumeAccumulator.exists ? "jest" : "brak"}, ` +
      `konto cashbacku: ${scan.amm.cashbackAccount.exists ? "jest" : "brak"}, wSOL: ${scan.amm.wsolAccount.exists ? scan.amm.wsolAccount.amount : "brak"}`,
  );

  console.log(`saldo portfela: ${((await conn.getBalance(owner)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  const picked = scan.accounts
    .filter((a) => isSale(a.kind) && a.quoteLamports <= maxLamports)
    .filter((a) => !prefixes.length || prefixes.some((p) => a.mint.toBase58().startsWith(p)))
    .filter((a) => (only === "routed" ? Boolean(a.via) : only === "cashback" ? Boolean(a.cashback) : true))
    .slice(0, limit);
  const sale = saleOptions(scan, 2, router);
  const wrappers = await batchWrappers(
    fresh ? { ...scan, volumeAccumulator: { ...scan.volumeAccumulator, exists: false }, amm: { ...scan.amm, volumeAccumulator: { exists: false } } } : scan,
  );
  const planOpts: BatchPlanOptions = { owner, treasury: owner, rentFeeBps: 0, computeUnitLimit: 1_400_000, computeUnitPriceMicroLamports: 0, wrappers };
  // Rozmiar tej samej sprzedazy w pelnej transakcji: z programem Duster i tabela adresow. Do pomiaru
  // wystarcza dowolne wdrozenie (adresy nie wplywaja na rozmiar), a tabela jest wirtualna.
  const d = loadDeployment("local");
  const fullOpts: BatchPlanOptions = {
    ...planOpts,
    treasury: d.treasury,
    rentFeeBps: 500,
    lookupTables: [virtualLookupTable(await lookupAddresses(d, scan))],
    ...programPlanOptions({ owner, refs: d.refs, treasury: d.treasury, minRate: () => 0n }),
  };
  const rows: Record<string, unknown>[] = [];
  for (const a of picked) {
    const item = await buildItem(a, sale);
    const row: Record<string, unknown> = {
      mint: a.mint.toBase58().slice(0, 8),
      rodzaj: (a.kind === "curve" ? "krzywa" : "pool") + (a.cashback ? " cb" : ""),
      waluta: a.via ? a.via.currency.mint.toBase58().slice(0, 6) : "SOL",
      trasa: a.via?.route.labels.join(">") ?? "",
      wycena: a.quoteLamports.toString(),
      koszt: a.sellCostLamports.toString(),
    };
    if (!item) {
      rows.push({ ...row, err: "brak instrukcji" });
      continue;
    }
    // Portfel przykladowy bywa adresem programu (poza krzywa): wtedy pelnej transakcji nie da sie zlozyc.
    let full: ReturnType<typeof measureBatch> = null;
    try {
      full = measureBatch([item], fullOpts);
    } catch {
      full = null;
    }
    row["z programem"] = full ? `${full.bytes} B / ${full.accounts}` : "?";
    const alone = measureBatch([item], planOpts);
    if (!alone || alone.bytes > 1232 || alone.accounts > 64) {
      rows.push({ ...row, bajty: alone?.bytes, konta: alone?.accounts, err: "nie miesci sie w transakcji" });
      continue;
    }
    const batches = planBatches([item], planOpts);
    const [batch] = batches;
    const { blockhash } = await withRetry(() => conn.getLatestBlockhash());
    const tx = toTransaction(batch, owner, blockhash);
    const { sim, deltaLamports, stable } = await simulateStable(conn, tx, owner);
    const logs = sim.value.logs ?? [];
    const errLog = logs.find((l) => l.includes("AnchorError") || l.includes("Error Message") || l.includes("failed:"));
    // Przyrost salda = depozyt zamknietego konta + przychod - oplata za podpis.
    const got = deltaLamports !== null ? deltaLamports - a.rentLamports + 5000 : null;
    rows.push({
      ...row,
      wynik: got ?? "",
      "roznica bps": got !== null && a.quoteLamports > 0n ? Math.round(((got - Number(a.quoteLamports)) * 10_000) / Number(a.quoteLamports)) : "",
      pewne: stable,
      CU: sim.value.unitsConsumed,
      bajty: batch.bytes,
      konta: batch.accounts,
      err: sim.value.err ? (errLog?.match(/Error Code: (\w+)/)?.[1] ?? errLog?.slice(0, 80) ?? JSON.stringify(sim.value.err)) : "",
    });
    if (sim.value.err && flows) console.log(logs.slice(-14).join("\n"));
    await sleep(250);
  }
  if (!summary) console.table(rows);
  // Podsumowanie: ile sprzedazy przeszlo, o ile wynik rozni sie od wyceny i jakie byly bledy.
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = `${String(r.rodzaj)}${r.waluta === "SOL" ? "" : " przez walute"}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  console.table(
    [...groups].map(([rodzaj, list]) => {
      const ok = list.filter((r) => !r.err);
      const diffs = ok.map((r) => Number(r["roznica bps"])).filter((n) => Number.isFinite(n));
      const errors = new Map<string, number>();
      for (const r of list) if (r.err) errors.set(String(r.err).slice(0, 60), (errors.get(String(r.err).slice(0, 60)) ?? 0) + 1);
      return {
        rodzaj,
        razem: list.length,
        udane: ok.length,
        "co do lamporta": diffs.filter((d) => d === 0).length,
        "min bps": diffs.length ? Math.min(...diffs) : "",
        "max bps": diffs.length ? Math.max(...diffs) : "",
        "max CU": Math.max(0, ...ok.map((r) => Number(r.CU ?? 0))),
        bledy: [...errors].map(([e, n]) => `${n}x ${e}`).join("; "),
      };
    }),
  );
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
