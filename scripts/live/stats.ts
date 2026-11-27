/**
 * Statystyki Dustera odczytane z sieci (tylko odczyt, bez kluczy).
 *
 *   DEPLOYMENT=mainnet npx tsx scripts/live/stats.ts
 *
 * Liczniki prowadzi sam program (konto config). Liczbe portfeli i podzial na dni liczymy z historii
 * transakcji programu. Gdy istnieje plik ze stanem z chwili publicznego startu
 * (assets/stats/launch-baseline.json), obok wartosci lacznych sa wartosci "od startu".
 */
import fs from "node:fs";
import path from "node:path";
import type { PublicKey } from "@solana/web3.js";
import { connection, ROOT } from "../lib/env";
import { loadDeployment } from "../lib/deployment";
import { dusterProgram, DUSTER_PROGRAM_ID } from "../../src/sdk/duster";

const BASELINE_FILE = path.join(ROOT, "assets", "stats", "launch-baseline.json");
/** Portfele projektu (adresy publiczne): ich transakcje po starcie to nasze testy, nie uzytkownicy. */
const OWN_WALLETS = new Set([
  "AnUCrg9fNBbFi7eWKDU4MMesfZNkUZ9wCgzqfwXkbs3h", // tester
  "4BraQBmCAQdfTL26WpU5pwqDq8QVnGEUJBs76R3MmGb3", // deployer
  "DXWhWxagQwzHTNkFRDpan2JrBv6fCFgAemhLFTAnadK3", // crank
  "GU1t3k117nnqPywzHfBpmbPPeEMPs3k5XxoAYTPzRxak", // treasury
]);

interface Baseline {
  takenAt: string;
  stakers: number;
  counters: Record<string, string>;
}

type Num = { toString(): string };
const big = (v: Num | string | undefined) => BigInt(v?.toString() ?? "0");
const sol = (v: bigint) => (Number(v) / 1e9).toFixed(4);
const duster = (v: bigint) => Math.round(Number(v) / 1e6).toLocaleString("en-US");
const plain = (v: bigint) => v.toLocaleString("en-US");

async function main() {
  const conn = connection();
  const program = dusterProgram(conn);
  const baseline: Baseline | null = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : null;
  const [config, stakes] = await Promise.all([
    program.account.config.fetch(loadDeployment().refs.config) as Promise<Record<string, Num>>,
    program.account.userStake.all(),
  ]);
  const stakers = stakes.filter((s) => big((s.account as unknown as { shares: Num }).shares) > 0n).length;

  const rows: [string, string, (v: bigint) => string][] = [
    ["transakcje czyszczenia", "totalConversions", plain],
    ["zamkniete konta", "totalAccountsClosed", plain],
    ["odzyskany rent (SOL)", "totalRentLamports", sol],
    ["fee od rentu (SOL)", "totalRentFeeLamports", sol],
    ["sprzedane martwe tokeny (SOL)", "totalSaleLamports", sol],
    ["DUSTER za czyszczenie", "totalDusterToUsers", duster],
    ["oplaty z poola odebrane (SOL)", "totalFeesClaimedLamports", sol],
    ["z tego treasury (SOL)", "totalTreasuryLamports", sol],
    ["z tego buyback (SOL)", "totalBuybackLamports", sol],
    ["DUSTER kupione dla stakujacych", "totalBuybackDuster", duster],
  ];
  const table: Record<string, Record<string, string>> = {};
  for (const [label, field, fmt] of rows) {
    const now = big(config[field]);
    table[label] = baseline ? { "od startu": fmt(now - big(baseline.counters[field])), lacznie: fmt(now) } : { lacznie: fmt(now) };
  }
  table["stakowane DUSTER"] = baseline
    ? { "od startu": duster(big(config.totalAssets) - big(baseline.counters.totalAssets)), lacznie: duster(big(config.totalAssets)) }
    : { lacznie: duster(big(config.totalAssets)) };
  table["stakujacy"] = baseline ? { "od startu": String(stakers - baseline.stakers), lacznie: String(stakers) } : { lacznie: String(stakers) };
  if (baseline) console.log(`start publiczny: ${baseline.takenAt}`);
  console.table(table);

  // Historia transakcji programu: od najnowszej wstecz, do chwili startu.
  const users = new Map<string, number>();
  const own = new Map<string, number>();
  const days = new Map<string, { cleanups: number; wallets: Set<string> }>();
  let stakeTxs = 0;
  let unstakeTxs = 0;
  let before: string | undefined;
  // Czas startu w sekundach; bez pliku ze stanem startowym liczymy cala historie.
  const cutoff = baseline ? Date.parse(baseline.takenAt) / 1000 : 0;
  for (;;) {
    const page = await conn.getSignaturesForAddress(DUSTER_PROGRAM_ID, { before, limit: 1000 });
    if (!page.length) break;
    before = page[page.length - 1].signature;
    const fresh = page.filter((s) => (s.blockTime ?? 0) > cutoff);
    const ok = fresh.filter((s) => !s.err);
    for (let i = 0; i < ok.length; i += 20) {
      const txs = await Promise.all(ok.slice(i, i + 20).map((s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 as 0 })));
      for (const tx of txs) {
        const logs = tx?.meta?.logMessages;
        if (!tx || !logs) continue;
        // Nazwa instrukcji konczacej wymiane bywa ucieta z dlugiego dziennika; ta z poczatku transakcji jest zawsze.
        if (logs.some((l) => l.includes("Instruction: Stake"))) stakeTxs++;
        if (logs.some((l) => l.includes("Instruction: Unstake"))) unstakeTxs++;
        if (!logs.some((l) => l.includes("Instruction: BeginConvert"))) continue;
        const payer = (tx.transaction.message as unknown as { staticAccountKeys: PublicKey[] }).staticAccountKeys[0].toBase58();
        if (OWN_WALLETS.has(payer)) {
          own.set(payer, (own.get(payer) ?? 0) + 1);
          continue;
        }
        users.set(payer, (users.get(payer) ?? 0) + 1);
        const day = new Date((tx.blockTime ?? 0) * 1000).toISOString().slice(0, 10);
        const d = days.get(day) ?? { cleanups: 0, wallets: new Set<string>() };
        d.cleanups++;
        d.wallets.add(payer);
        days.set(day, d);
      }
    }
    if (page.length < 1000 || fresh.length < page.length) break;
  }

  const scope = baseline ? "od startu" : "lacznie";
  const cleanups = [...users.values()].reduce((a, b) => a + b, 0);
  console.log(`${scope}: ${users.size} portfeli czyscilo (${cleanups} transakcji), ${stakeTxs} wplat do stakingu, ${unstakeTxs} wyplat`);
  const ownTxs = [...own.values()].reduce((a, b) => a + b, 0);
  if (ownTxs) console.log(`w licznikach programu jest tez ${ownTxs} transakcji naszych portfeli testowych (nie wliczone w portfele powyzej)`);
  if (days.size) {
    console.table(Object.fromEntries([...days].sort().map(([day, d]) => [day, { "transakcje czyszczenia": d.cleanups, portfele: d.wallets.size }])));
  }
}

main().catch((e) => {
  console.error(String(e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=<x>").slice(0, 600));
  process.exit(1);
});
