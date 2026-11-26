/**
 * Symuluje wymiane na mainnecie dla dowolnego portfela, bez podpisu i bez
 * wysylania czegokolwiek. Mierzy, ile pozycji miesci sie w transakcji, zuzycie
 * mocy obliczeniowej i realny wplyw SOL wzgledem wyceny.
 *
 * Uzycie: npm run simulate -- <adres portfela> [maxPozycji] [maxWartoscSOL]
 *
 * Kazda paczka jest symulowana osobno na biezacym stanie sieci, wiec skutki
 * wczesniejszych paczek nie sa widoczne dla pozniejszych.
 */
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  batchWrappers,
  buildItem,
  planBatches,
  saleOptions,
  sharedAddresses,
  toTransaction,
  virtualLookupTable,
  type BatchPlanOptions,
  type ConvertItem,
} from "../src/core/convert";
import { jupiterRouter } from "../src/core/route";
import { withRetry } from "../src/core/rpc";
import { isSale, scanWallet } from "../src/core/scan";
import { connection, loadWallet, sleep, writeOut } from "./lib/env";
import { simulateStable } from "./lib/sim";

const sol = (lamports: bigint | number) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
const BASE_FEE_LAMPORTS = 5000;

async function main() {
  const owner = new PublicKey(process.argv[2] ?? loadWallet("tester").publicKey.toBase58());
  const maxItems = Number(process.argv[3] ?? 40);
  const maxValueLamports = BigInt(Math.round(Number(process.argv[4] ?? 0.05) * LAMPORTS_PER_SOL));
  const conn = connection();

  // Przelew fee ponizej minimalnego salda na puste konto jest odrzucany przez siec,
  // wiec dopoki treasury nie jest zasilone, w symulacji fee trafia z powrotem do wlasciciela.
  let treasury = loadWallet("treasury").publicKey;
  if ((await withRetry(() => conn.getBalance(treasury))) === 0) {
    console.log("uwaga: treasury ma saldo 0, w symulacji fee jest przelewane na adres wlasciciela");
    treasury = owner;
  }

  const router = jupiterRouter(conn);
  const scan = await scanWallet(conn, owner, { router });
  const candidates = scan.accounts
    .filter((a) => isSale(a.kind) || a.kind === "worthless" || a.kind === "empty")
    .filter((a) => a.quoteLamports <= maxValueLamports)
    // Najpierw tokeny do sprzedazy: to one decyduja o pojemnosci transakcji.
    .sort((x, y) => Number(isSale(y.kind)) - Number(isSale(x.kind)))
    .slice(0, maxItems);

  const sale = saleOptions(scan, 2, router);
  const built = await Promise.all(candidates.map((a) => buildItem(a, sale).catch(() => null)));
  const items = built.filter((it): it is ConvertItem => it !== null);
  const count = (k: string) => items.filter((i) => i.account.kind === k).length;
  console.log(
    `pozycje: ${items.length} (krzywa ${count("curve")}, po migracji ${count("graduated")}, do spalenia ${count("worthless")}, puste ${count("empty")})`,
  );
  console.log(`konto statystyk pump.fun: ${scan.volumeAccumulator.exists ? "istnieje" : "brak, depozyt " + sol(scan.volumeAccumulator.rentLamports) + " SOL"}`);
  if (!items.length) return;

  const planOpts: BatchPlanOptions = {
    owner,
    treasury,
    rentFeeBps: 500,
    computeUnitLimit: 1_400_000,
    computeUnitPriceMicroLamports: 0,
    // Konto wSOL i konta statystyk, ktore zaklada sprzedaz, kazda paczka sama po sobie sprzata.
    wrappers: await batchWrappers(scan),
  };
  const batches = planBatches(items, planOpts);

  const rows: Record<string, unknown>[] = [];
  for (const [i, b] of batches.entries()) {
    const { blockhash } = await withRetry(() => conn.getLatestBlockhash());
    const tx = toTransaction(b, owner, blockhash);
    const { sim, deltaLamports, stable } = await simulateStable(conn, tx, owner);
    const feeToSelf = treasury.equals(owner) ? b.feeLamports : 0;
    const expected =
      BigInt(b.rentLamports - b.feeLamports + feeToSelf - BASE_FEE_LAMPORTS) + b.expectedSaleLamports;
    const got = deltaLamports !== null ? BigInt(deltaLamports) : null;
    rows.push({
      paczka: i + 1,
      pozycje: b.items.length,
      rodzaje: b.items.map((it) => (it.account.via ? "r" : it.account.kind[0])).join(""),
      bajty: b.bytes,
      konta: b.accounts,
      CU: sim.value.unitsConsumed ?? null,
      blad: sim.value.err ? JSON.stringify(sim.value.err) : "",
      "oczekiwane SOL": sol(expected),
      "symulacja SOL": got !== null ? sol(got) : "",
      "roznica lamporty": got !== null ? (got - expected).toString() + (stable ? "" : " (niepewne)") : "",
    });
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      writeOut(`sim-logs-${i + 1}.txt`, logs.join("\n"));
      console.log(`paczka ${i + 1} blad; ostatnie logi:\n  ${logs.slice(-6).join("\n  ")}`);
    }
    await sleep(400);
  }
  console.log("\nbez tabeli adresow (stan obecny, symulowany na mainnecie):");
  console.table(rows);

  // Pojemnosc z tabela adresow: sam pomiar rozmiaru, tabela jeszcze nie istnieje w sieci.
  const alt = virtualLookupTable([...sharedAddresses(items, [owner]), treasury]);
  const withAlt = planBatches(items, { ...planOpts, lookupTables: [alt] });
  console.log(`z tabela adresow (${alt.state.addresses.length} adresow), sam pomiar rozmiaru:`);
  console.table(
    withAlt.map((b, i) => ({
      paczka: i + 1,
      pozycje: b.items.length,
      rodzaje: b.items.map((it) => (it.account.via ? "r" : it.account.kind[0])).join(""),
      bajty: b.bytes,
      konta: b.accounts,
    })),
  );
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
