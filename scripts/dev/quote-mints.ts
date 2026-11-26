/**
 * Narzedzie deweloperskie: w czym sa kwotowane tokeny pump.fun.
 *
 *   npx tsx scripts/dev/quote-mints.ts            lista walut dopuszczonych przez pump.fun
 *   npx tsx scripts/dev/quote-mints.ts sample [n] probka ostatnich transakcji: jakie tokeny sa w obrocie
 *
 * Wylacznie odczyt.
 */
import { OnlinePumpSdk, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, isSolLikeQuoteMint, isStableQuoteMint } from "@pump-fun/pump-sdk";
import { PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-swap-sdk";
import { PublicKey } from "@solana/web3.js";
import { getAccountsChunked } from "../../src/core/rpc";
import { connection, sleep, writeOut } from "../lib/env";

async function supported() {
  const conn = connection();
  const sdk = new OnlinePumpSdk(conn);
  const global = await sdk.fetchGlobal();
  console.log("maxCurveDepth:", global.maxCurveDepth, "isCashbackEnabled:", global.isCashbackEnabled, "createV2Enabled:", global.createV2Enabled);
  console.log("whitelistedQuoteMints:", global.whitelistedQuoteMints.map((m) => m.toBase58()));
  const qc = await sdk.fetchQuoteControl();
  console.log("quoteControl:", qc?.mints.map((m) => `${m.mint.toBase58()} (${m.initialVirtualQuoteReserves.toString()})`));
  const list = await sdk.fetchSupportedQuoteMints();
  console.table(list.map((q) => ({ mint: q.mint.toBase58(), source: q.source, ivqr: q.initialVirtualQuoteReserves.toString() })));
}

async function sample(limit: number) {
  const conn = connection();
  // mint -> portfele, ktore mialy go w ostatnich transakcjach (do pozniejszych symulacji)
  const mints = new Map<string, Set<string>>();
  for (const program of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID]) {
    let before: string | undefined;
    let left = limit;
    while (left > 0) {
      const sigs = await conn.getSignaturesForAddress(program, { limit: Math.min(left, 1000), before });
      if (!sigs.length) break;
      before = sigs[sigs.length - 1].signature;
      left -= sigs.length;
      const ok = sigs.filter((s) => !s.err);
      for (let i = 0; i < ok.length; i += 20) {
        const txs = await Promise.all(
          ok.slice(i, i + 20).map((s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)),
        );
        for (const tx of txs) {
          for (const b of tx?.meta?.postTokenBalances ?? []) {
            if (!mints.has(b.mint)) mints.set(b.mint, new Set());
            if (b.owner && b.uiTokenAmount.amount !== "0") mints.get(b.mint)!.add(b.owner);
          }
        }
        await sleep(150);
      }
    }
  }
  const list = [...mints.keys()].map((m) => new PublicKey(m));
  const infos = await getAccountsChunked(conn, list.map((m) => bondingCurvePda(m)));
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
  const quotes: Record<string, number> = {};
  const examples: Record<string, { mint: string; quote: string; depth: number; holders: string[] }[]> = {};
  list.forEach((m, i) => {
    const info = infos[i];
    if (!info || !info.owner.equals(PUMP_PROGRAM_ID) || info.data.length < 49) return;
    const c = PUMP_SDK.decodeBondingCurveNullable(info);
    if (!c) return;
    bump("tokeny pump.fun");
    const sol = isSolLikeQuoteMint(c.quoteMint);
    const cat = [c.complete ? "po migracji" : "na krzywej", sol ? "SOL" : isStableQuoteMint(c.quoteMint) ? "stable" : c.depth > 0 ? "pump coin" : "inny token", c.isCashbackCoin ? "cashback" : "", c.isMayhemMode ? "mayhem" : ""]
      .filter(Boolean)
      .join(", ");
    bump(cat);
    if (!sol) quotes[c.quoteMint.toBase58()] = (quotes[c.quoteMint.toBase58()] ?? 0) + 1;
    (examples[cat] ??= []).push({ mint: m.toBase58(), quote: c.quoteMint.toBase58(), depth: c.depth, holders: [...mints.get(m.toBase58())!].slice(0, 6) });
  });
  console.table(stats);
  console.table(Object.entries(quotes).sort((a, b) => b[1] - a[1]).slice(0, 15));
  console.log("zapisano:", writeOut("sample-tokens.json", examples));
}

const [cmd, arg] = process.argv.slice(2);
(cmd === "sample" ? sample(Number(arg ?? 150)) : supported()).catch((e) => {
  console.error(e);
  process.exit(1);
});
