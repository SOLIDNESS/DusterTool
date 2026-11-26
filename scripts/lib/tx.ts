import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { withRetry } from "../../src/core/rpc";
import { sendAndConfirmAll } from "../../src/core/send";

export interface RunResult {
  sent: boolean;
  signature?: string;
  unitsConsumed?: number;
  bytes: number;
  error?: string;
  logs: string[];
}

/**
 * Sklada transakcje, zawsze ja najpierw symuluje, a wysyla tylko wtedy, gdy
 * `send` jest true i symulacja przeszla. Pierwszy podpisujacy placi oplate.
 */
export async function simulateOrSend(
  conn: Connection,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  opts: { send: boolean; lookupTables?: AddressLookupTableAccount[]; label?: string },
): Promise<RunResult> {
  const { blockhash, lastValidBlockHeight } = await withRetry(() => conn.getLatestBlockhash());
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(opts.lookupTables ?? []);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const bytes = tx.serialize().length;

  const sim = await withRetry(() => conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: !opts.send }));
  const logs = sim.value.logs ?? [];
  const label = opts.label ? `${opts.label}: ` : "";
  if (sim.value.err) {
    const error = JSON.stringify(sim.value.err);
    console.log(`${label}symulacja odrzucona: ${error}`);
    console.log("  " + logs.slice(-8).join("\n  "));
    return { sent: false, bytes, error, logs, unitsConsumed: sim.value.unitsConsumed };
  }
  if (!opts.send) {
    console.log(`${label}symulacja OK (${bytes} bajtow, ${sim.value.unitsConsumed} CU). Dodaj --send, zeby wyslac.`);
    return { sent: false, bytes, logs, unitsConsumed: sim.value.unitsConsumed };
  }

  const [res] = await sendAndConfirmAll(conn, [tx], lastValidBlockHeight);
  const signature = res.signature;
  if (res.status !== "confirmed") {
    const error = res.error ?? "nie potwierdzono przed wygasnieciem blockhasha";
    console.log(`${label}transakcja ${signature} nieudana: ${error}`);
    return { sent: true, signature, bytes, error, logs };
  }
  console.log(`${label}wyslano: ${signature}`);
  return { sent: true, signature, bytes, logs, unitsConsumed: sim.value.unitsConsumed };
}

export const hasFlag = (name: string) => process.argv.includes(`--${name}`);
export const positional = () => process.argv.slice(2).filter((a) => !a.startsWith("--"));
