/** Rozmiary paczek wymiany dla portfela na lokalnym walidatorze: ile sprzedazy miesci sie w transakcji. */
import { PublicKey } from "@solana/web3.js";
import { measure } from "../../src/core/convert";
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
  const plan = planConversion(ctx, items);
  console.log(`tabela: ${ctx.lookupTables[0]?.state.addresses.length ?? 0} adresow, DUSTER: ${ctx.hasDusterAccount}`);
  console.table(plan.batches.map((b) => ({ rodzaje: b.items.map((i) => i.account.kind[0]).join(""), bajty: b.bytes, konta: b.accounts, instrukcje: b.instructions.length })));
  // Ile zajmuje sama otoczka (bez pozycji) i kazda kolejna sprzedaz.
  const sells = items.filter((i) => i.account.kind === "curve");
  for (let n = 1; n <= Math.min(4, sells.length); n++) {
    try {
      const p = planConversion({ ...ctx }, sells.slice(0, n));
      const b = p.batches[0];
      console.log(`${n} sprzedaz(e): pierwsza paczka ${b.items.length} pozycji, ${b.bytes} bajtow, ${b.accounts} kont`);
    } catch (e) {
      console.log(n, (e as Error).message);
    }
  }
  const one = planConversion(ctx, sells.slice(0, 1)).batches[0];
  const staticKeys = measure(one.instructions, owner, []);
  console.log(`1 sprzedaz bez tabeli: ${staticKeys?.bytes} bajtow, ${staticKeys?.accounts} kont`);
}
main();
