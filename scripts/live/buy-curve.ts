/**
 * Test na mainnecie: kupuje portfelem 'tester' drobna ilosc tokena prosto na krzywej pump.fun
 * (dla tokenow, ktorych agregator nie obsluguje, np. starszych tokenow cashback).
 * Domyslnie tylko symuluje; --send wysyla.
 *
 *   npx tsx scripts/live/buy-curve.ts [--sol 0.0008] [--send] <mint...>
 */
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { ComputeBudgetProgram, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { connection, loadWallet } from "../lib/env";

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const solAt = args.indexOf("--sol");
  const lamports = new BN(Math.round(Number(solAt >= 0 ? args[solAt + 1] : 0.0008) * LAMPORTS_PER_SOL));
  const mints = args.filter((a, i) => !a.startsWith("--") && i !== solAt + 1);
  const conn = connection();
  const tester = loadWallet("tester");
  const sdk = new OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);

  for (const m of mints) {
    const mint = new PublicKey(m);
    const mintInfo = await conn.getAccountInfo(mint);
    if (!mintInfo) {
      console.log(`${m}: brak minta`);
      continue;
    }
    const tokenProgram = mintInfo.owner;
    const state = await sdk.fetchBuyState(mint, tester.publicKey, tokenProgram);
    const supply = new BN((await conn.getTokenSupply(mint)).value.amount);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: supply,
      bondingCurve: state.bondingCurve,
      amount: lamports,
      quoteMint: state.quoteMint,
      quoteTransferFee: state.quoteTransferFee,
    });
    const ixs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user: tester.publicKey,
      amount,
      solAmount: lamports,
      slippage: 10,
      tokenProgram,
    });
    const latest = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: tester.publicKey,
        recentBlockhash: latest.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs],
      }).compileToV0Message(),
    );
    tx.sign([tester]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      console.log(`${m}: symulacja nieudana: ${JSON.stringify(sim.value.err)} ${sim.value.logs?.slice(-3).join(" | ").slice(0, 300)}`);
      continue;
    }
    if (!send) {
      console.log(`${m}: symulacja OK, ${amount.toString()} jednostek (cashback: ${state.bondingCurve.isCashbackCoin})`);
      continue;
    }
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const res = await conn.confirmTransaction({ signature, ...latest }, "confirmed").catch((e) => ({ value: { err: String(e) } }));
    console.log(`${m}: ${res.value.err ? `BLAD ${JSON.stringify(res.value.err)}` : "kupione"} ${signature}`);
  }
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1200) ?? e);
  process.exit(1);
});
