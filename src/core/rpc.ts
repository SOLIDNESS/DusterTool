/** Pomocnicze funkcje RPC: paczkowanie zapytan i ponawianie przy limitach. */
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ponawia wywolanie przy bledach przejsciowych (limity RPC, timeouty). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 600): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      const transient = /429|Too Many Requests|timeout|ETIMEDOUT|ECONNRESET|fetch failed|503|502/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

/** getMultipleAccountsInfo dla dowolnej liczby adresow (limit RPC to 100 na zapytanie). */
export async function getAccountsChunked(
  conn: Connection,
  keys: PublicKey[],
  chunkSize = 100,
  pauseMs = 150,
): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const infos = await withRetry(() => conn.getMultipleAccountsInfo(chunk));
    out.push(...infos);
    if (i + chunkSize < keys.length && pauseMs > 0) await sleep(pauseMs);
  }
  return out;
}
