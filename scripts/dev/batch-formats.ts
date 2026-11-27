/**
 * Porownanie planu wymiany dla portfela w trzech wariantach: zwykly (v0), v0 z zapasem na
 * instrukcje kontrolne Phantoma i v1 z tym zapasem. Niczego nie wysyla.
 * Uzycie: tsx scripts/dev/batch-formats.ts <adres portfela> [--sim] [--rent-duster]
 *   --sim          symuluje paczki v1 i podaje faktyczna dlugosc sladu instrukcji
 *   --rent-duster  plan z rentem zamienianym na DUSTER (finish_convert_all)
 */
import { PublicKey } from "@solana/web3.js";
import { buildItems, isConvertible, loadPlanContext, planConversion, type TxProfile } from "../../src/core/plan";
import { scanWallet } from "../../src/core/scan";
import { simulateV1 } from "../../src/core/v1";
import { traceLength } from "../../src/core/wallet-guards";
import { loadDeployment } from "../lib/deployment";
import { connection } from "../lib/env";

const PROFILES: [string, TxProfile][] = [
  ["v0", { format: "v0", walletGuards: false }],
  ["v0 + zapas", { format: "v0", walletGuards: true }],
  ["v1 + zapas", { format: "v1", walletGuards: true }],
];

async function main() {
  const conn = connection();
  const d = loadDeployment();
  const owner = new PublicKey(process.argv[2]);
  const scan = await scanWallet(conn, owner);
  for (const [name, tx] of PROFILES) {
    const ctx = await loadPlanContext(conn, d, scan, { rentToDuster: process.argv.includes("--rent-duster") }, undefined, tx);
    const items = await buildItems(ctx, scan.accounts.filter((a) => isConvertible(a, d)));
    const plan = planConversion(ctx, items);
    console.log(`${name}: ${items.length} pozycji w ${plan.batches.length} transakcjach`);
    for (const b of plan.batches) {
      const kinds = b.items.map((i) => i.account.kind[0]).join("");
      let line = `  ${kinds.padEnd(26)} ${b.bytes} B, ${b.accounts} kont`;
      if (tx.format === "v1" && process.argv.includes("--sim")) {
        const sim = await simulateV1(conn, b.instructions, owner);
        line += `, symulacja ${sim.err ? JSON.stringify(sim.err) : "ok"} ${sim.units} CU, dane ${sim.loadedBytes}`;
        const est = traceLength(b.instructions, owner, b.items, { createsDusterAccount: !ctx.hasDusterAccount });
        line += `, slad ${traceLength(b.instructions, owner, b.items, { inner: sim.inner })} (szacunek ${est})`;
      }
      console.log(line);
    }
  }
}
main().catch((e) => {
  console.error(String(e?.stack ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=<x>").slice(0, 1500));
  process.exit(1);
});
