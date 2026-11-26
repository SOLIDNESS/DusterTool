/**
 * Bot buybacku. Co godzine wywoluje instrukcje `buyback` programu Duster:
 * odbiera oplaty z poola, przekazuje polowe do treasury, a za druga polowe
 * odkupuje DUSTER dla stakujacych. Bot niczym nie zarzadza i nie trzyma
 * srodkow poza SOL na oplaty sieciowe; te sama instrukcje moze wywolac kazdy.
 *
 * Zmienne srodowiskowe:
 *   RPC_URL                  adres RPC
 *   CRANK_KEYPAIR            sciezka do klucza bota (domyslnie keys/crank.json)
 *   DEPLOYMENT               nazwa wdrozenia (domyslnie 'test')
 *   MIN_CLAIM_LAMPORTS       ponizej tej kwoty nie warto robic transakcji (domyslnie 0,002 SOL)
 *   PRIORITY_MICROLAMPORTS   oplata priorytetowa (domyslnie 20000)
 */
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { planBuyback } from "../core/buyback";
import { parseDeployment } from "../core/deployment";
import { sendAndConfirmAll } from "../core/send";

// Katalog projektu: bot uruchamiamy z niego (takze w wersji zbudowanej do dist/).
const ROOT = process.cwd();
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const KEYPAIR = process.env.CRANK_KEYPAIR ?? path.join(ROOT, "keys", "crank.json");
const DEPLOYMENT = process.env.DEPLOYMENT ?? "test";
const MIN_CLAIM = BigInt(process.env.MIN_CLAIM_LAMPORTS ?? 2_000_000);
const PRIORITY = Number(process.env.PRIORITY_MICROLAMPORTS ?? 20_000);
const ONCE = process.argv.includes("--once");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6);

async function tick(conn: Connection, crank: Keypair): Promise<number> {
  const d = parseDeployment(JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", `${DEPLOYMENT}.json`), "utf8")));
  const plan = await planBuyback(conn, d, crank.publicKey, { computeUnitPriceMicroLamports: PRIORITY });
  if (plan.config.paused) {
    log("program wstrzymany, czekam");
    return 600;
  }
  if (plan.waitSecs > 0) {
    log(`nastepny buyback za ${plan.waitSecs} s (do odebrania ${sol(plan.claimableLamports)} SOL)`);
    return plan.waitSecs + 5;
  }

  // Nie palimy oplat na puste transakcje: czekamy, az uzbiera sie sensowna kwota.
  const worthIt = plan.claimableLamports >= MIN_CLAIM || plan.spendLamports >= MIN_CLAIM;
  if (!worthIt) {
    log(`za malo do odebrania (${sol(plan.claimableLamports)} SOL), sprawdze za 10 min`);
    return 600;
  }

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: crank.publicKey, recentBlockhash: blockhash, instructions: plan.instructions }).compileToV0Message(),
  );
  tx.sign([crank]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    log(`symulacja odrzucona: ${JSON.stringify(sim.value.err)} | ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    return 120;
  }
  const [res] = await sendAndConfirmAll(conn, [tx], lastValidBlockHeight);
  const signature = res.signature;
  if (res.status !== "confirmed") {
    log(`transakcja ${signature} nieudana: ${res.error ?? "nie potwierdzono na czas"}`);
    return 120;
  }
  log(
    `buyback ${signature}: odebrano ${sol(plan.claimableLamports)} SOL, odkup za ${sol(plan.spendLamports)} SOL, ok. ${(Number(plan.expectedDuster) / 1e6).toFixed(2)} DUSTER`,
  );
  return plan.config.buybackInterval.toNumber() + 5;
}

async function main() {
  const crank = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR, "utf8"))));
  const conn = new Connection(RPC_URL, "confirmed");
  log(`bot buybacku: portfel ${crank.publicKey.toBase58()}, wdrozenie '${DEPLOYMENT}'`);
  for (;;) {
    let waitSecs = 120;
    try {
      waitSecs = await tick(conn, crank);
    } catch (e) {
      log(`blad: ${(e as Error).message.slice(0, 300)}`);
    }
    if (ONCE) return;
    await sleep(Math.min(waitSecs, 3600) * 1000);
  }
}

main();
