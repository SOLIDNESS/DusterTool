/**
 * Wspolne narzedzia testow na lokalnym walidatorze. Wszystko tutaj dziala
 * wylacznie z RPC 127.0.0.1 i jednorazowymi kluczami.
 */
import { BN } from "@coral-xyz/anchor";
import { CpAmm, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
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
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { singleSidedPoolParams, TOKEN_DECIMALS, TOTAL_SUPPLY_RAW } from "../../src/core/pool";
import { dusterProgram, initializeIx, poolRefs, type PoolRefs } from "../../src/sdk/duster";

export const LOCAL_RPC = "http://127.0.0.1:8899";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function localConnection(): Promise<Connection> {
  const conn = new Connection(LOCAL_RPC, "confirmed");
  assert.notEqual(await conn.getGenesisHash(), MAINNET_GENESIS, "to jest mainnet, przerywam");
  return conn;
}

export async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(
    lookupTables,
  );
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) {
    const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    throw new Error(`Transakcja odrzucona: ${JSON.stringify(res.value.err)}\n${(info?.meta?.logMessages ?? []).join("\n")}`);
  }
  return sig;
}

export const withCu = (ixs: TransactionInstruction[], units = 600_000) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs];

export async function airdrop(conn: Connection, to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

export interface LocalDuster {
  cpAmm: CpAmm;
  mint: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  positionNftAccount: PublicKey;
  refs: PoolRefs;
}

/** Token testowy, pool jednostronny jak na mainnecie i inicjalizacja programu. */
export async function setupLocalDuster(conn: Connection, admin: Keypair, treasury: PublicKey): Promise<LocalDuster> {
  const mint = Keypair.generate();
  const adminAta = getAssociatedTokenAddressSync(mint.publicKey, admin.publicKey);
  await sendTx(
    conn,
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN_DECIMALS, admin.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, adminAta, admin.publicKey, BigInt(TOTAL_SUPPLY_RAW.toString())),
    ],
    [admin, mint],
  );

  const cpAmm = new CpAmm(conn);
  const pp = singleSidedPoolParams(cpAmm);
  const positionNft = Keypair.generate();
  const created = await cpAmm.createCustomPool({
    payer: admin.publicKey,
    creator: admin.publicKey,
    positionNft: positionNft.publicKey,
    tokenAMint: mint.publicKey,
    tokenBMint: NATIVE_MINT,
    tokenAAmount: pp.tokenAAmount,
    tokenBAmount: pp.tokenBAmount,
    sqrtMinPrice: pp.sqrtMinPrice,
    sqrtMaxPrice: pp.sqrtMaxPrice,
    liquidityDelta: pp.liquidityDelta,
    initSqrtPrice: pp.initSqrtPrice,
    poolFees: pp.poolFees,
    hasAlphaVault: false,
    activationType: pp.activationType,
    collectFeeMode: pp.collectFeeMode,
    activationPoint: null,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    isLockLiquidity: true,
  });
  await sendTx(conn, withCu(created.tx.instructions), [admin, positionNft]);

  const refs = poolRefs(mint.publicKey, created.pool);
  const program = dusterProgram(conn);
  await sendTx(
    conn,
    withCu([
      await initializeIx(program, admin.publicKey, refs, created.position, {
        treasury,
        rentFeeBps: 500,
        stakerShareBps: 5000,
        buybackIntervalSecs: 3600,
        releaseDurationSecs: 3600,
        maxBuybackLamports: new BN(10 * LAMPORTS_PER_SOL),
        minStake: new BN(1_000_000_000),
      }),
    ]),
    [admin],
  );
  return {
    cpAmm,
    mint: mint.publicKey,
    pool: created.pool,
    position: created.position,
    positionNftAccount: derivePositionNftAccount(positionNft.publicKey),
    refs,
  };
}

/** Tworzy tabele adresow i czeka, az bedzie mozna jej uzyc. */
export async function createLookupTable(conn: Connection, authority: Keypair, addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
  const unique = [...new Map(addresses.map((a) => [a.toBase58(), a])).values()];
  const slot = await conn.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  });
  await sendTx(conn, [createIx], [authority]);
  for (let i = 0; i < unique.length; i += 20) {
    await sendTx(
      conn,
      [
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: authority.publicKey,
          payer: authority.publicKey,
          addresses: unique.slice(i, i + 20),
        }),
      ],
      [authority],
    );
  }
  // Nowe wpisy sa dostepne od kolejnego slotu.
  await sleep(1500);
  const res = await conn.getAddressLookupTable(table);
  assert.ok(res.value, "tabela adresow nie powstala");
  assert.equal(res.value.state.addresses.length, unique.length);
  return res.value;
}
