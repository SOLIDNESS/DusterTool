/**
 * Narzedzie deweloperskie: dla krotszych kont krzywych wypisuje saldo konta,
 * rezerwy i nadwyzke ponad minimalny depozyt, zeby dopasowac wzor na doplate.
 * Uzycie: npx tsx scripts/dev/curve-rent.ts <portfel>
 */
import { BONDING_CURVE_SIZE, bondingCurvePda } from "@pump-fun/pump-sdk";
import { PublicKey } from "@solana/web3.js";
import { getAccountsChunked, withRetry } from "../../src/core/rpc";
import { scanWallet } from "../../src/core/scan";
import { connection } from "../lib/env";

async function main() {
  const owner = new PublicKey(process.argv[2]);
  const conn = connection();
  const scan = await scanWallet(conn, owner);
  const short = scan.accounts.filter((a) => a.bondingCurve && !a.bondingCurve.complete && a.sellCostLamports > 0n);
  const infos = await getAccountsChunked(conn, short.map((a) => bondingCurvePda(a.mint)));
  const rentFull = await withRetry(() => conn.getMinimumBalanceForRentExemption(BONDING_CURVE_SIZE));
  const rows = [];
  for (let i = 0; i < short.length; i++) {
    const a = short[i];
    const info = infos[i]!;
    const c = a.bondingCurve!;
    const rentNow = await withRetry(() => conn.getMinimumBalanceForRentExemption(info.data.length));
    const real = Number(c.realQuoteReserves.toString());
    rows.push({
      mint: a.mint.toBase58().slice(0, 8),
      bajty: info.data.length,
      saldo: info.lamports,
      rezerwa: real,
      "saldo-rezerwa": info.lamports - real,
      "min dla obecnego": rentNow,
      "min dla 166": rentFull,
      "brakuje do 166": Math.max(0, rentFull - (info.lamports - real)),
      "rent konta tokena": a.rentLamports,
    });
  }
  console.table(rows);
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
