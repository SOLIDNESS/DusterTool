/**
 * Skanuje portfel i pokazuje, co da sie w nim wymienic.
 * Uzycie: npm run scan -- <adres portfela>   (domyslnie portfel 'tester')
 */
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { jupiterRouter } from "../src/core/route";
import { scanWallet, type DustKind } from "../src/core/scan";
import { connection, loadWallet, writeOut } from "./lib/env";

const sol = (lamports: bigint | number) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

async function main() {
  const arg = process.argv[2];
  const owner = arg ? new PublicKey(arg) : loadWallet("tester").publicKey;
  const conn = connection();
  const t0 = Date.now();
  const res = await scanWallet(conn, owner, { router: jupiterRouter(conn) });
  console.log(`portfel ${owner.toBase58()}: ${res.accounts.length} kont tokenowych (${Date.now() - t0} ms)\n`);

  const kinds: DustKind[] = ["curve", "graduated", "worthless", "empty", "unsupported"];
  const summary = kinds.map((kind) => {
    const list = res.accounts.filter((a) => a.kind === kind);
    return {
      rodzaj: kind,
      konta: list.length,
      "rent SOL": sol(list.reduce((s, a) => s + a.rentLamports, 0)),
      "sprzedaz SOL": sol(list.reduce((s, a) => s + a.quoteLamports, 0n)),
    };
  });
  console.table(summary);
  const sales = res.accounts.filter((a) => a.kind === "curve" || a.kind === "graduated");
  console.log(
    `w tym do sprzedazy: tokeny cashback ${sales.filter((a) => a.cashback).length}, sparowane z inna waluta niz SOL ${sales.filter((a) => a.via).length}`,
  );

  const reasons = new Map<string, number>();
  for (const a of res.accounts) if (a.reason) reasons.set(a.reason, (reasons.get(a.reason) ?? 0) + 1);
  if (reasons.size) console.log("nieobslugiwane wg powodu:", Object.fromEntries(reasons));

  const curve = res.accounts.filter((a) => a.kind === "curve").sort((x, y) => Number(y.quoteLamports - x.quoteLamports));
  console.log("\nnajwiecej warte tokeny na krzywej:");
  console.table(
    curve.slice(0, 10).map((a) => ({
      mint: a.mint.toBase58(),
      program: a.tokenProgram.toBase58().startsWith("Tokenz") ? "token-2022" : "spl",
      tokeny: (Number(a.amount) / 10 ** a.decimals).toFixed(0),
      "sprzedaz SOL": sol(a.quoteLamports),
      "rent SOL": sol(a.rentLamports),
    })),
  );

  const file = writeOut(
    `scan-${owner.toBase58().slice(0, 6)}.json`,
    res.accounts.map((a) => ({
      address: a.address.toBase58(),
      mint: a.mint.toBase58(),
      tokenProgram: a.tokenProgram.toBase58(),
      amount: a.amount.toString(),
      decimals: a.decimals,
      rentLamports: a.rentLamports,
      kind: a.kind,
      reason: a.reason,
      cashback: a.cashback,
      via: a.via ? { currency: a.via.currency.mint.toBase58(), amount: a.via.amount.toString(), route: a.via.route.labels } : undefined,
      quoteLamports: a.quoteLamports.toString(),
    })),
  );
  console.log(`\nzapisano: ${file}`);
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
