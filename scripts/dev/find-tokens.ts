/**
 * Narzedzie deweloperskie: szuka na mainnecie przykladowych tokenow pump.fun danego rodzaju
 * razem z portfelami, ktore je trzymaja (do symulacji sprzedazy).
 *
 *   npx tsx scripts/dev/find-tokens.ts cashback [ile]     tokeny cashback: na krzywej i po migracji
 *   npx tsx scripts/dev/find-tokens.ts holders <mint...>  posiadacze podanych tokenow
 *
 * Wynik: out/examples-<rodzaj>.json. Wylacznie odczyt (wymaga RPC z getProgramAccountsV2).
 */
import { bondingCurvePda, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda, PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-swap-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { connection, RPC_URL, sleep, writeOut } from "../lib/env";

interface Example {
  mint: string;
  holders: { owner: string; amount: string }[];
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** Strony getProgramAccountsV2 az do zebrania `want` kont pasujacych do filtrow. */
async function findAccounts(program: PublicKey, filters: unknown[], dataSlice: { offset: number; length: number }, want: number, maxPages = 40) {
  const out: { pubkey: string; data: Buffer }[] = [];
  let paginationKey: string | undefined;
  for (let page = 0; page < maxPages && out.length < want; page++) {
    const r = await rpc<{ accounts: { pubkey: string; account: { data: [string, string] } }[]; paginationKey?: string }>("getProgramAccountsV2", [
      program.toBase58(),
      { encoding: "base64", dataSlice, limit: 1000, filters, ...(paginationKey ? { paginationKey } : {}) },
    ]);
    for (const a of r.accounts) out.push({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], "base64") });
    if (!r.paginationKey) break;
    paginationKey = r.paginationKey;
  }
  return out.slice(0, want);
}

/** Posiadacze tokena z pominieciem kont protokolu (krzywa, pool). */
async function holders(mint: PublicKey, max = 6): Promise<Example["holders"]> {
  const conn = connection();
  const largest = await conn.getTokenLargestAccounts(mint).catch(() => null);
  if (!largest) return [];
  const accounts = largest.value.filter((a) => a.amount !== "0");
  const infos = await conn.getMultipleParsedAccounts(accounts.map((a) => a.address));
  const skip = new Set([bondingCurvePda(mint).toBase58(), canonicalPumpPoolPda(mint).toBase58()]);
  const out: Example["holders"] = [];
  accounts.forEach((a, i) => {
    const data = infos.value[i]?.data;
    const owner = data && "parsed" in data ? (data.parsed?.info?.owner as string | undefined) : undefined;
    if (owner && !skip.has(owner)) out.push({ owner, amount: a.amount });
  });
  // Najmniejsi posiadacze sa najblizsi temu, co sprzata Duster.
  return out.reverse().slice(0, max);
}

async function cashback(want: number) {
  const conn = connection();
  // Krzywa: bajt 48 = complete, bajt 82 = isCashbackCoin.
  const curves = await findAccounts(PUMP_PROGRAM_ID, [{ memcmp: { offset: 82, bytes: "2" } }, { memcmp: { offset: 48, bytes: "1" } }, { dataSize: 166 }], { offset: 0, length: 0 }, want * 3);
  const onCurve: Example[] = [];
  for (const c of curves) {
    if (onCurve.length >= want) break;
    // Mint poznajemy po koncie tokenow nalezacym do krzywej.
    for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
      const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(c.pubkey), { programId }).catch(() => null);
      const mint = res?.value[0]?.account.data.parsed?.info?.mint as string | undefined;
      if (!mint) continue;
      const h = await holders(new PublicKey(mint));
      if (h.length) onCurve.push({ mint, holders: h });
      break;
    }
    await sleep(100);
  }
  // Pool PumpSwap: bajt 244 = isCashbackCoin; mint bazowy od bajtu 43.
  const pools = await findAccounts(PUMP_AMM_PROGRAM_ID, [{ memcmp: { offset: 244, bytes: "2" } }], { offset: 43, length: 64 }, want * 3);
  const graduated: Example[] = [];
  for (const p of pools) {
    if (graduated.length >= want) break;
    const mint = new PublicKey(p.data.subarray(0, 32));
    if (!canonicalPumpPoolPda(mint).equals(new PublicKey(p.pubkey))) continue;
    const h = await holders(mint);
    if (h.length) graduated.push({ mint: mint.toBase58(), holders: h });
    await sleep(100);
  }
  console.log(`cashback na krzywej: ${onCurve.length}, po migracji: ${graduated.length}`);
  console.log("zapisano:", writeOut("examples-cashback.json", { onCurve, graduated }));
}

async function listHolders(mints: string[]) {
  const out: Example[] = [];
  for (const m of mints) out.push({ mint: m, holders: await holders(new PublicKey(m)) });
  console.log(JSON.stringify(out, null, 1));
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "holders" ? listHolders(rest) : cashback(Number(rest[0] ?? 6))).catch((e) => {
  console.error(e);
  process.exit(1);
});
