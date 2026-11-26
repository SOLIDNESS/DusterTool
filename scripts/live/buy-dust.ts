/**
 * Test na mainnecie: kupuje portfelem 'tester' drobne ilosci podanych tokenow (przez Jupiter),
 * zeby bylo co sprzatac. Domyslnie tylko symuluje; --send wysyla.
 *
 *   npx tsx scripts/live/buy-dust.ts [--sol 0.0015] [--send] <mint...>
 */
import { NATIVE_MINT } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_API } from "../../src/core/route";
import { connection, loadWallet, sleep } from "../lib/env";

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const solAt = args.indexOf("--sol");
  const amount = Math.round(Number(solAt >= 0 ? args[solAt + 1] : 0.0015) * LAMPORTS_PER_SOL);
  const mints = args.filter((a, i) => !a.startsWith("--") && i !== solAt + 1);
  const conn = connection();
  const tester = loadWallet("tester");

  for (const mint of mints) {
    await sleep(2000); // publiczne API Jupitera ma limit zapytan
    const quote = await fetch(`${JUPITER_API}/quote?inputMint=${NATIVE_MINT.toBase58()}&outputMint=${mint}&amount=${amount}&slippageBps=1500`).then((r) => r.json());
    if (!quote.outAmount) {
      console.log(`${mint}: brak trasy (${JSON.stringify(quote).slice(0, 120)})`);
      continue;
    }
    await sleep(1200);
    const labels = (quote.routePlan as { swapInfo: { label: string } }[]).map((p) => p.swapInfo.label).join(" > ");
    const swap = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: tester.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 20_000 }),
    }).then((r) => r.json());
    if (!swap.swapTransaction) {
      console.log(`${mint}: brak transakcji (${JSON.stringify(swap).slice(0, 160)})`);
      continue;
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    tx.sign([tester]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      console.log(`${mint}: symulacja nieudana (${labels}): ${JSON.stringify(sim.value.err)} ${sim.value.logs?.slice(-2).join(" | ").slice(0, 160)}`);
      continue;
    }
    if (!send) {
      console.log(`${mint}: symulacja OK, ${quote.outAmount} przez ${labels}`);
      continue;
    }
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const latest = await conn.getLatestBlockhash();
    const res = await conn.confirmTransaction({ signature, ...latest }, "confirmed").catch((e) => ({ value: { err: String(e) } }));
    console.log(`${mint}: ${res.value.err ? `BLAD ${JSON.stringify(res.value.err)}` : "kupione"} (${labels}) ${signature}`);
    await sleep(800);
  }
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
