/** Wypisuje konta pierwszej paczki ze sprzedaza: ktore sa w tabeli adresow, a ktore zajmuja miejsce w transakcji. */
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import { buildItems, isConvertible, loadPlanContext, planConversion } from "../../src/core/plan";
import { scanWallet } from "../../src/core/scan";
import { loadDeployment } from "../lib/deployment";
import { connection } from "../lib/env";

async function main() {
  const conn = connection();
  const d = loadDeployment();
  const owner = new PublicKey(process.argv[2]);
  const scan = await scanWallet(conn, owner);
  const ctx = await loadPlanContext(conn, d, scan);
  const items = await buildItems(ctx, scan.accounts.filter((a) => isConvertible(a, d)));
  const b = planConversion(ctx, items).batches[0];
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: b.instructions }).compileToV0Message(ctx.lookupTables);
  const count = new Map<string, number>();
  for (const ix of b.instructions) for (const k of [ix.programId, ...ix.keys.map((k) => k.pubkey)]) count.set(k.toBase58(), (count.get(k.toBase58()) ?? 0) + 1);
  console.log("statyczne (32 bajty kazde):");
  for (const k of msg.staticAccountKeys) console.log(`  ${k.toBase58()} x${count.get(k.toBase58()) ?? 0}`);
  console.log(`z tabeli: ${msg.addressTableLookups.reduce((s, l) => s + l.writableIndexes.length + l.readonlyIndexes.length, 0)}`);
  b.instructions.forEach((ix, i) => console.log(`ix ${i}: ${ix.programId.toBase58().slice(0, 8)} kont ${ix.keys.length} dane ${ix.data.length}`));
  console.log("global.feeRecipients:", [scan.global.feeRecipient, ...scan.global.feeRecipients].map((k) => k.toBase58().slice(0, 8)).join(" "));
}
main();
