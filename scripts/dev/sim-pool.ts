/**
 * Narzedzie deweloperskie: symuluje na mainnecie utworzenie tokena i poola
 * jednostronnego jedna transakcja, bez podpisow i bez wysylania. Platnikiem
 * w symulacji jest dowolny publiczny adres z saldem SOL (nic z niego nie schodzi).
 *
 * Uzycie: npx tsx scripts/dev/sim-pool.ts <adres z SOL>
 */
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { singleSidedPoolParams, TOKEN_DECIMALS, TOTAL_SUPPLY_RAW } from "../../src/core/pool";
import { connection } from "../lib/env";

async function main() {
  const payer = new PublicKey(process.argv[2]);
  const conn = connection();
  const before = await conn.getBalance(payer);
  const mint = Keypair.generate().publicKey;
  const positionNft = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(mint, payer);
  const cpAmm = new CpAmm(conn);
  const p = singleSidedPoolParams(cpAmm);

  const { tx, pool } = await cpAmm.createCustomPool({
    payer,
    creator: payer,
    positionNft,
    tokenAMint: mint,
    tokenBMint: NATIVE_MINT,
    tokenAAmount: p.tokenAAmount,
    tokenBAmount: p.tokenBAmount,
    sqrtMinPrice: p.sqrtMinPrice,
    sqrtMaxPrice: p.sqrtMaxPrice,
    liquidityDelta: p.liquidityDelta,
    initSqrtPrice: p.initSqrtPrice,
    poolFees: p.poolFees,
    hasAlphaVault: false,
    activationType: p.activationType,
    collectFeeMode: p.collectFeeMode,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: true,
  });

  const instructions = [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: MINT_SIZE,
      lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mint, TOKEN_DECIMALS, payer, null),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint),
    createMintToInstruction(mint, ata, payer, BigInt(TOTAL_SUPPLY_RAW.toString())),
    ...tx.instructions,
  ];
  console.log("instrukcje poola:", tx.instructions.map((i) => i.programId.toBase58().slice(0, 6)).join(" "), "| pool:", pool.toBase58());

  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  let bytes = -1;
  try {
    bytes = vtx.serialize().length;
  } catch (e) {
    console.log("serializacja:", (e as Error).message.slice(0, 100));
  }
  const sim = await conn.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  const after = sim.value.accounts?.[0]?.lamports;
  console.log("bajty:", bytes, "| CU:", sim.value.unitsConsumed, "| blad:", JSON.stringify(sim.value.err));
  if (after != null) console.log("koszt w symulacji (bez oplaty sieciowej):", ((before - after) / 1e9).toFixed(6), "SOL");
  if (sim.value.err) console.log((sim.value.logs ?? []).slice(-14).join("\n"));
}

main().catch((e) => {
  console.error((e as Error).message.slice(0, 1500));
  process.exit(1);
});
