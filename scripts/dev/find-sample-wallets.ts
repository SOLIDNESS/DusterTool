/**
 * Narzedzie deweloperskie: znajduje na mainnecie publiczne portfele, ktore
 * trzymaja resztki tokenow pump.fun. Sluza wylacznie jako dane do odczytu i
 * symulacji (niczego nie podpisujemy w ich imieniu).
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { connection, sleep, writeOut } from "../lib/env";

async function main() {
  const conn = connection();
  const sigs = await conn.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 40 });
  console.log(`podpisy: ${sigs.length}`);

  const payers = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    try {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const keys = tx?.transaction.message.staticAccountKeys;
      if (keys?.length) payers.add(keys[0].toBase58());
    } catch (e) {
      console.log(`pomijam ${s.signature.slice(0, 8)}: ${(e as Error).message.slice(0, 80)}`);
    }
    await sleep(250);
    if (payers.size >= 15) break;
  }
  console.log(`portfele: ${payers.size}`);

  const rows: { wallet: string; spl: number; t22: number; nonZero: number }[] = [];
  for (const p of payers) {
    const owner = new PublicKey(p);
    try {
      const [a, b] = await Promise.all([
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const all = [...a.value, ...b.value];
      const nonZero = all.filter((x) => x.account.data.parsed.info.tokenAmount.amount !== "0").length;
      rows.push({ wallet: p, spl: a.value.length, t22: b.value.length, nonZero });
    } catch (e) {
      console.log(`blad dla ${p.slice(0, 8)}: ${(e as Error).message.slice(0, 80)}`);
    }
    await sleep(400);
  }
  rows.sort((x, y) => y.nonZero - x.nonZero);
  console.table(rows);
  console.log(`zapisano: ${writeOut("sample-wallets.json", rows)}`);
}

main().catch((e) => {
  console.error((e as Error).message?.slice(0, 500) ?? e);
  process.exit(1);
});
