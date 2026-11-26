/**
 * Token i pool jednostronny na Meteora DAMM v2 (mainnet): 100% podazy, cena startowa
 * pump.fun, stale 2% zbierane w SOL, plynnosc zablokowana na stale.
 *
 * Uzycie:
 *   npx tsx scripts/live/setup-token-pool.ts          -> tylko plan, nic nie wysyla
 *   npx tsx scripts/live/setup-token-pool.ts --send   -> wysyla transakcje z portfela 'deployer'
 *
 * Token docelowy dostaje metadane (nazwa, ticker, adres pliku z opisem i obrazem):
 *   DEPLOYMENT=mainnet npx tsx scripts/live/setup-token-pool.ts --name Duster --symbol DUSTER --uri https://duster.lol/token/duster.json
 * Bez --name powstaje token testowy bez metadanych.
 *
 * Skrypt jest wznawialny: postep zapisuje w deployments/<DEPLOYMENT>.json
 * (domyslnie test.json) i pomija kroki, ktore juz sie wykonaly. Klucz adresu tokena
 * lezy w keys/mint-<DEPLOYMENT>.json (po utworzeniu tokena nie daje zadnych uprawnien).
 */
import fs from "node:fs";
import path from "node:path";
import { CpAmm, derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { singleSidedPoolParams, TOKEN_DECIMALS, TOTAL_SUPPLY_RAW } from "../../src/core/pool";
import type { DeploymentFile } from "../../src/core/deployment";
import { DEPLOYMENT_NAME, readDeploymentFile, writeDeploymentFile } from "../lib/deployment";
import { connection, KEYS_DIR, loadWallet } from "../lib/env";

const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

interface TokenInfo {
  name: string;
  symbol: string;
  uri: string;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Metadane z linii polecen; plik pod --uri musi juz byc dostepny i zgadzac sie z nazwa i tickerem. */
async function tokenInfo(): Promise<TokenInfo | null> {
  const name = flag("name");
  if (!name) return null;
  const symbol = flag("symbol");
  const uri = flag("uri");
  if (!symbol || !uri) throw new Error("Do --name potrzebne sa tez --symbol i --uri");
  if (Buffer.byteLength(name) > 32 || Buffer.byteLength(symbol) > 10 || Buffer.byteLength(uri) > 200) throw new Error("Za dluga nazwa, ticker albo adres metadanych");
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Plik metadanych ${uri} nie jest dostepny (HTTP ${res.status})`);
  const json = (await res.json()) as { name?: string; symbol?: string; image?: string };
  if (json.name !== name || json.symbol !== symbol) throw new Error(`Plik metadanych ma inna nazwe lub ticker: ${json.name} / ${json.symbol}`);
  const image = json.image ? await fetch(json.image) : null;
  if (!image?.ok || !(image.headers.get("content-type") ?? "").startsWith("image/")) throw new Error(`Obraz z metadanych nie jest dostepny: ${json.image}`);
  return { name, symbol, uri };
}

/** Instrukcja CreateMetadataAccountV3 programu Metaplex Token Metadata (skladana recznie, bez dodatkowej biblioteki). */
function createMetadataIx(mint: PublicKey, authority: PublicKey, info: TokenInfo): TransactionInstruction {
  const [metadata] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], METADATA_PROGRAM_ID);
  const str = (v: string) => {
    const b = Buffer.from(v, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const data = Buffer.concat([
    Buffer.from([33]), // CreateMetadataAccountV3
    str(info.name),
    str(info.symbol),
    str(info.uri),
    Buffer.from([0, 0]), // seller_fee_basis_points
    Buffer.from([0]), // creators: brak
    Buffer.from([0]), // collection: brak
    Buffer.from([0]), // uses: brak
    Buffer.from([1]), // is_mutable: opis i obraz mozna jeszcze poprawic
    Buffer.from([0]), // collection_details: brak
  ]);
  return new TransactionInstruction({
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Klucz adresu tokena zapisany przed wyslaniem, zeby przerwane uruchomienie dalo sie wznowic. */
function mintKeypair(): Keypair {
  const file = path.join(KEYS_DIR, `mint-${DEPLOYMENT_NAME}.json`);
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

const load = () => readDeploymentFile();
const save = (d: DeploymentFile) => writeDeploymentFile(d);

async function main() {
  const send = process.argv.includes("--send");
  const conn = connection();
  const deployer = loadWallet("deployer");
  const d = load();
  const balance = await conn.getBalance(deployer.publicKey);
  console.log(`deployer ${deployer.publicKey.toBase58()}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`wdrozenie '${DEPLOYMENT_NAME}': mint=${d.mint ?? "-"} pool=${d.pool ?? "-"}`);
  const info = await tokenInfo();
  console.log(info ? `token: ${info.name} (${info.symbol}), metadane ${info.uri}` : "token testowy bez metadanych");
  if (!send) {
    console.log("tryb podgladu: dodaj --send, zeby wyslac transakcje");
    return;
  }
  if (balance < 0.05 * LAMPORTS_PER_SOL) throw new Error("Za malo SOL na portfelu deployer (potrzeba ok. 0,05 SOL)");

  // 1. Token: cala podaz na portfelu deployer, bez mozliwosci dodruku i bez zamrazania kont.
  if (!d.mint) {
    const mint = mintKeypair();
    const ata = getAssociatedTokenAddressSync(mint.publicKey, deployer.publicKey);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
      SystemProgram.createAccount({
        fromPubkey: deployer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN_DECIMALS, deployer.publicKey, null),
      // Metadane musza powstac, zanim zniknie uprawnienie do dodruku.
      ...(info ? [createMetadataIx(mint.publicKey, deployer.publicKey, info)] : []),
      createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata, deployer.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, ata, deployer.publicKey, BigInt(TOTAL_SUPPLY_RAW.toString())),
      createSetAuthorityInstruction(mint.publicKey, deployer.publicKey, AuthorityType.MintTokens, null),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [deployer, mint]);
    d.mint = mint.publicKey.toBase58();
    d.signatures.mint = sig;
    save(d);
    console.log(`token: ${d.mint} (${sig})`);
  }

  // 2. Pool jednostronny z plynnoscia zablokowana na stale.
  if (!d.pool) {
    const cpAmm = new CpAmm(conn);
    const p = singleSidedPoolParams(cpAmm);
    const positionNft = Keypair.generate();
    const { tx, pool, position } = await cpAmm.createCustomPool({
      payer: deployer.publicKey,
      creator: deployer.publicKey,
      positionNft: positionNft.publicKey,
      tokenAMint: new PublicKey(d.mint),
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
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }));
    const sig = await sendAndConfirmTransaction(conn, tx, [deployer, positionNft]);
    d.pool = pool.toBase58();
    d.position = position.toBase58();
    d.positionNftMint = positionNft.publicKey.toBase58();
    d.positionNftAccount = derivePositionNftAccount(positionNft.publicKey).toBase58();
    d.signatures.pool = sig;
    save(d);
    console.log(`pool: ${d.pool} (${sig})`);
  }

  const after = await conn.getBalance(deployer.publicKey);
  console.log(`koszt lacznie: ${((balance - after) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 2000) ?? e);
  process.exit(1);
});
