/**
 * Narzedzie deweloperskie: rozklad rozmiaru pelnej transakcji wymiany (z programem Duster i tabela
 * adresow) dla jednego tokena: ktore konta zajmuja miejsce jako klucze statyczne i w ktorych
 * instrukcjach wystepuja.
 *
 *   DEPLOYMENT=local npx tsx scripts/dev/tx-keys.ts <portfel> <poczatek minta>
 */
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import { assembleBatch, batchWrappers, buildItem, measureBatch, saleOptions, virtualLookupTable, type BatchPlanOptions, type ConvertItem } from "../../src/core/convert";
import { lookupAddresses } from "../../src/core/lookup";
import { programPlanOptions } from "../../src/core/program-convert";
import { jupiterRouter } from "../../src/core/route";
import { isSale, scanWallet } from "../../src/core/scan";
import { loadDeployment } from "../lib/deployment";
import { connection } from "../lib/env";

const assembleFor = (item: ConvertItem, opts: BatchPlanOptions) => assembleBatch([item], opts);

async function main() {
  const owner = new PublicKey(process.argv[2]);
  const prefix = process.argv[3] ?? "";
  const conn = connection();
  const router = jupiterRouter(conn);
  const scan = await scanWallet(conn, owner, { router });
  const a = scan.accounts.find((x) => isSale(x.kind) && x.mint.toBase58().startsWith(prefix));
  if (!a) throw new Error("brak takiego tokena do sprzedazy");
  const item = await buildItem(a, saleOptions(scan, 2, router));
  if (!item) throw new Error("brak instrukcji");
  const d = loadDeployment("local");
  const opts: BatchPlanOptions = {
    owner,
    treasury: d.treasury,
    rentFeeBps: 500,
    computeUnitLimit: 1_000_000,
    computeUnitPriceMicroLamports: 20_000,
    wrappers: await batchWrappers(scan),
    lookupTables: [virtualLookupTable(await lookupAddresses(d, scan))],
    ...programPlanOptions({ owner, refs: d.refs, treasury: d.treasury, minRate: () => 0n }),
  };
  // Paczka z jedna pusta pozycja ma te sama otoczke; dokladamy do niej instrukcje badanej pozycji.
  const batch = { instructions: assembleFor(item, opts), lookupTables: [...(opts.lookupTables ?? []), ...(item.lookupTables ?? [])] };
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: batch.instructions }).compileToV0Message(batch.lookupTables);
  const size = measureBatch([item], opts);
  console.log(`bajty ${size?.bytes ?? "ponad limit serializacji"}, konta ${size?.accounts}, statyczne ${msg.staticAccountKeys.length}, tabele ${batch.lookupTables.length}, trasa ${a.via?.route.labels.join(">") ?? "-"}`);
  batch.instructions.forEach((ix, i) => console.log(`  ix ${i}: ${ix.programId.toBase58().slice(0, 8)} konta ${ix.keys.length} dane ${ix.data.length} B`));
  for (const key of msg.staticAccountKeys) {
    const used = batch.instructions.flatMap((ix, i) => (ix.programId.equals(key) ? [`${i}p`] : ix.keys.some((k) => k.pubkey.equals(key)) ? [`${i}`] : []));
    const signerOrWritable = batch.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(key) && k.isWritable)) ? "w" : " ";
    console.log(`  ${key.toBase58().padEnd(44)} ${signerOrWritable} ix: ${used.join(",")}`);
  }
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
