import { Connection, PublicKey, RpcResponseAndContext, SimulatedTransactionResponse, VersionedTransaction } from "@solana/web3.js";
import { withRetry } from "../../src/core/rpc";

export interface StableSimulation {
  sim: RpcResponseAndContext<SimulatedTransactionResponse>;
  /** Zmiana salda SOL platnika w symulacji; null, gdy symulacja nie zwrocila konta. */
  deltaLamports: number | null;
  /** false, gdy saldo portfela zmienialo sie w trakcie pomiaru mimo powtorzen. */
  stable: boolean;
}

/**
 * Symuluje transakcje i mierzy zmiane salda platnika. Portfele przykladowe z
 * mainnetu bywaja aktywne, wiec pomiar przyjmujemy dopiero wtedy, gdy saldo
 * odczytane przed symulacja i po niej jest takie samo.
 */
export async function simulateStable(
  conn: Connection,
  tx: VersionedTransaction,
  payer: PublicKey,
  attempts = 6,
): Promise<StableSimulation> {
  let before = await withRetry(() => conn.getBalance(payer));
  let last: StableSimulation | null = null;
  for (let i = 0; i < attempts; i++) {
    const sim = await withRetry(() =>
      conn.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: [payer.toBase58()] },
      }),
    );
    const again = await withRetry(() => conn.getBalance(payer));
    const post = sim.value.accounts?.[0]?.lamports;
    const stable = again === before;
    last = { sim, deltaLamports: post !== undefined ? post - before : null, stable };
    if (stable) return last;
    before = again;
  }
  return last!;
}
