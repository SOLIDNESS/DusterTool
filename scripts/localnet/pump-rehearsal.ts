/**
 * Proba generalna wymiany: prawdziwy program pump.fun i prawdziwe martwe tokeny
 * (skopiowane z mainnetu), nasz program i pool Meteory, wszystko na lokalnym walidatorze.
 *
 * Kolejnosc: npx tsx scripts/localnet/pump-prepare.ts -> npm run localnet:pump -> npm run rehearsal
 */
import { userVolumeAccumulatorPda } from "@pump-fun/pump-sdk";
import { userVolumeAccumulatorPda as ammVolumeAccumulatorPda } from "@pump-fun/pump-swap-sdk";
import { getAccount, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Deployment } from "../../src/core/deployment";
import { lookupAddresses } from "../../src/core/lookup";
import { buildItems, isConvertible, loadPlanContext, planConversion } from "../../src/core/plan";
import { scanWallet } from "../../src/core/scan";
import { dusterProgram, sessionPda } from "../../src/sdk/duster";
import { OUT_DIR } from "../lib/env";
import { airdrop, createLookupTable, localConnection, sendTx, setupLocalDuster } from "./lib";

const sol = (l: number | bigint) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

async function main() {
  const conn = await localConnection();
  const tester = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(OUT_DIR, "localnet-pump", "tester.json"), "utf8"))),
  );
  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  await airdrop(conn, admin.publicKey, 10);
  await airdrop(conn, treasury.publicKey, 1);
  // Maly zapas SOL: sprawdzamy, ze wymiana dziala z portfela, ktory ma prawie same smieci.
  await airdrop(conn, tester.publicKey, 0.02);

  const d = await setupLocalDuster(conn, admin, treasury.publicKey);
  const program = dusterProgram(conn);
  console.log("token, pool i program gotowe");

  // --- tabela adresow: tylko konta niezalezne od portfela, tak jak na mainnecie ---
  const scan = await scanWallet(conn, tester.publicKey);
  const base: Deployment = {
    mint: d.mint,
    pool: d.pool,
    position: d.position,
    positionNftAccount: d.positionNftAccount,
    treasury: treasury.publicKey,
    lookupTable: null,
    refs: d.refs,
  };
  const alt = await createLookupTable(conn, admin, await lookupAddresses(base, scan));
  const deployment: Deployment = { ...base, lookupTable: alt.key };
  console.log(`tabela adresow: ${alt.state.addresses.length} adresow`);

  // --- plan wymiany, dokladnie tak, jak sklada go aplikacja ---
  const ctx = await loadPlanContext(conn, deployment, scan, { priorityMicroLamports: 0, computeUnitLimit: 1_000_000 });
  const items = await buildItems(ctx, scan.accounts.filter((a) => isConvertible(a, deployment)));
  const count = (k: string) => items.filter((i) => i.account.kind === k).length;
  const cashback = (k: string) => items.filter((i) => i.account.kind === k && i.account.cashback).length;
  console.log(
    `pozycje: ${items.length} (krzywa ${count("curve")}, w tym cashback ${cashback("curve")}; po migracji ${count("graduated")}, w tym cashback ${cashback("graduated")}; ` +
      `do spalenia ${count("worthless")}, puste ${count("empty")})`,
  );
  assert.ok(count("curve") > 0, "brak tokenow do sprzedazy; czy walidator wystartowal z kontami z pump-prepare?");
  assert.ok(count("graduated") > 0, "brak tokenow po migracji; przygotuj konta ponownie skryptem pump-prepare");

  const plan = planConversion(ctx, items);
  const { batches, quotes, minRate } = plan;
  const expectedDuster = plan.dusterOut;
  const expectedSale = plan.saleLamports;
  const rentTotal = plan.rentLamports;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, tester.publicKey);
  const dusterAta = getAssociatedTokenAddressSync(d.mint, tester.publicKey);
  console.log(
    `plan: ${batches.length} paczek, sprzedaz ${sol(expectedSale)} SOL -> ok. ${(Number(expectedDuster) / 1e6).toFixed(2)} DUSTER, rent ${sol(rentTotal)} SOL, kurs min. ${minRate}`,
  );

  // --- wysylka paczek jedna po drugiej ---
  const solBefore = await conn.getBalance(tester.publicKey);
  const treasuryBefore = await conn.getBalance(treasury.publicKey);
  let fees = 0;
  const rows: Record<string, unknown>[] = [];
  for (const [i, b] of batches.entries()) {
    const sig = await sendTx(conn, b.instructions, [tester], b.lookupTables);
    const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    fees += info?.meta?.fee ?? 0;
    rows.push({
      paczka: i + 1,
      // Duza litera = token cashback.
      rodzaje: b.items.map((it) => (it.account.cashback && it.account.kind !== "worthless" ? it.account.kind[0].toUpperCase() : it.account.kind[0])).join(""),
      bajty: b.bytes,
      konta: b.accounts,
      CU: info?.meta?.computeUnitsConsumed,
      "sprzedaz SOL": sol(b.expectedSaleLamports),
      "DUSTER (wycena)": (Number(quotes[i].dusterOut) / 1e6).toFixed(2),
    });
  }
  console.table(rows);

  // --- weryfikacja ---
  const cfg = await program.account.config.fetch(d.refs.config);
  const gotDuster = (await getAccount(conn, dusterAta)).amount;
  const solAfter = await conn.getBalance(tester.publicKey);
  const treasuryGain = (await conn.getBalance(treasury.publicKey)) - treasuryBefore;
  const dusterRent = (await conn.getAccountInfo(dusterAta))!.lamports;
  const feeExpected = batches.reduce((s, b) => s + Math.floor((b.rentLamports * 500) / 10_000), 0);

  for (const it of items) assert.equal(await conn.getAccountInfo(it.account.address), null, `konto ${it.account.address.toBase58()} nie zostalo zamkniete`);
  assert.equal(await conn.getAccountInfo(wsolAta), null, "po wymianie nie moze zostac konto wSOL uzytkownika");
  assert.equal(await conn.getAccountInfo(ammVolumeAccumulatorPda(tester.publicKey)), null, "konto statystyk PumpSwap powinno byc zamkniete");
  assert.equal((await getAccount(conn, d.refs.swapWsol)).amount, 0n, "konto wSOL programu powinno byc puste");
  assert.equal(await conn.getAccountInfo(sessionPda(d.refs.config, tester.publicKey)), null, "konto sesji powinno byc zamkniete");
  assert.equal(await conn.getAccountInfo(userVolumeAccumulatorPda(tester.publicKey)), null, "konto statystyk pump.fun powinno byc zamkniete");
  assert.equal(treasuryGain, feeExpected, "fee od rentu w treasury");
  assert.equal(cfg.totalAccountsClosed.toNumber(), items.length);
  assert.equal(cfg.totalRentLamports.toNumber(), rentTotal);
  assert.equal(BigInt(cfg.totalDusterToUsers.toString()), gotDuster);

  const soldLamports = BigInt(cfg.totalSaleLamports.toString());
  // Caly przychod ze sprzedazy poszedl w DUSTER, wiec saldo SOL zmienia sie tylko o rent, fee i oplaty.
  assert.equal(solAfter - solBefore, rentTotal - feeExpected - dusterRent - fees, "saldo SOL uzytkownika");
  const saleDiffBps = Number(((soldLamports - expectedSale) * 10_000n) / expectedSale);
  const dusterDiffBps = Number(((gotDuster - expectedDuster) * 10_000n) / expectedDuster);
  assert.ok(Math.abs(saleDiffBps) <= 200, `przychod odbiega od wyceny o ${saleDiffBps} bps`);
  assert.ok(Math.abs(dusterDiffBps) <= 200, `DUSTER odbiega od wyceny o ${dusterDiffBps} bps`);

  console.log(`sprzedaz: wycena ${sol(expectedSale)} SOL, faktycznie ${sol(soldLamports)} SOL (${saleDiffBps} bps)`);
  console.log(`DUSTER: wycena ${(Number(expectedDuster) / 1e6).toFixed(2)}, faktycznie ${(Number(gotDuster) / 1e6).toFixed(2)} (${dusterDiffBps} bps)`);
  console.log(`rent odzyskany ${sol(rentTotal)} SOL, fee 5% = ${sol(treasuryGain)} SOL, oplaty sieciowe ${sol(fees)} SOL`);
  console.log(`saldo SOL uzytkownika: ${sol(solBefore)} -> ${sol(solAfter)}`);
  console.log("\nProba generalna zakonczona powodzeniem.");
}

main().catch((e) => {
  console.error("\nBLAD:", (e as Error).message?.slice(0, 5000) ?? e);
  process.exit(1);
});
