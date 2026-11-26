/**
 * Wysylka podpisanych transakcji z potwierdzaniem przez odpytywanie.
 * Niepotwierdzone transakcje sa co kilka sekund wysylane ponownie, dopoki ich
 * blockhash jest wazny: pojedyncza wysylka potrafi zaginac po drodze do lidera.
 * Bez WebSocketow, wiec dziala tez przez proxy RPC w przegladarce.
 */
import bs58 from "bs58";
import type { Connection, VersionedTransaction } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SendStatus = "sending" | "confirmed" | "failed" | "expired";

export interface SendUpdate {
  index: number;
  status: SendStatus;
  signature: string;
  /** Surowy blad transakcji (JSON) albo komunikat RPC. */
  error?: string;
}

export const signatureOf = (tx: VersionedTransaction): string => bs58.encode(tx.signatures[0]);

export async function sendAndConfirmAll(
  conn: Connection,
  txs: VersionedTransaction[],
  lastValidBlockHeight: number,
  onUpdate: (u: SendUpdate) => void = () => {},
): Promise<SendUpdate[]> {
  const raws = txs.map((tx) => tx.serialize());
  const sigs = txs.map(signatureOf);
  const results: (SendUpdate | null)[] = txs.map(() => null);
  const pendingIndexes = () => results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
  const finish = (i: number, status: SendStatus, error?: string) => {
    if (results[i]) return;
    results[i] = { index: i, status, signature: sigs[i], error };
    onUpdate(results[i]!);
  };
  const broadcast = async (i: number) => {
    try {
      await conn.sendRawTransaction(raws[i], { skipPreflight: true, maxRetries: 0 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // Ponowna wysylka potwierdzonej transakcji i bledy przejsciowe RPC nic nie znacza.
      if (/already been processed|429|Too Many Requests|fetch|timeout|50\d/i.test(msg)) return;
      finish(i, "failed", msg);
    }
  };

  for (let i = 0; i < raws.length; i++) {
    onUpdate({ index: i, status: "sending", signature: sigs[i] });
    await broadcast(i);
  }

  let lastBroadcast = Date.now();
  while (pendingIndexes().length) {
    await sleep(1200);
    const pending = pendingIndexes();
    try {
      const statuses = await conn.getSignatureStatuses(pending.map((i) => sigs[i]));
      statuses.value.forEach((st, k) => {
        if (!st) return;
        if (st.err) finish(pending[k], "failed", JSON.stringify(st.err));
        else if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") finish(pending[k], "confirmed");
      });
    } catch {
      continue;
    }
    const still = pendingIndexes();
    if (!still.length) break;

    const height = await conn.getBlockHeight("confirmed").catch(() => 0);
    if (height > lastValidBlockHeight) {
      // Ostatnie sprawdzenie: transakcja mogla wejsc w ostatnim waznym bloku.
      await sleep(1500);
      const last = await conn.getSignatureStatuses(still.map((i) => sigs[i])).catch(() => null);
      still.forEach((i, k) => {
        const st = last?.value[k];
        if (st?.err) finish(i, "failed", JSON.stringify(st.err));
        else if (st) finish(i, "confirmed");
        else finish(i, "expired");
      });
      break;
    }
    if (Date.now() - lastBroadcast > 3000) {
      lastBroadcast = Date.now();
      await Promise.all(still.map(broadcast));
    }
  }
  return results as SendUpdate[];
}
