/**
 * Transakcje w formacie v1 (do 4096 bajtow, do 64 kont wpisanych wprost, bez tabel adresow).
 *
 * Uzywamy ich tam, gdzie portfel dopisuje do podpisywanej transakcji wlasne instrukcje kontrolne
 * i potrzebuje na nie miejsca (Phantom, program Lighthouse): w v0 nie mieszcza sie one obok
 * sprzedazy i portfel pokazuje ostrzezenie, ze nie moze sprawdzic transakcji.
 *
 * Roznice wzgledem v0, ktore maja tu znaczenie:
 *  - limit jednostek obliczen i limit wczytanych danych kont sa polami transakcji i trzeba je
 *    ustawic (domyslnie 0); instrukcje ComputeBudget nic nie robia, wiec je pomijamy,
 *  - oplata priorytetowa to laczna kwota w lamportach, a nie cena za jednostke.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { ComputeBudgetProgram, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";

export const V1_MAX_BYTES = 4096;
export const V1_MAX_ACCOUNTS = 64;
/** Najwyzsze limity sieci: do symulacji, zanim znamy faktyczne zuzycie. */
export const MAX_COMPUTE_UNITS = 1_400_000;
export const MAX_LOADED_DATA_BYTES = 64 * 1024 * 1024;

export interface V1Limits {
  computeUnitLimit: number;
  /** Limit lacznego rozmiaru danych kont wczytywanych przez transakcje, w bajtach. */
  loadedAccountsDataSizeLimit: number;
  /** Laczna oplata priorytetowa w lamportach. */
  priorityFeeLamports: bigint;
}

const isBudget = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);

/**
 * Budzet zapisany w instrukcjach ComputeBudget (tak opisuja go paczki planu, wspolne dla obu
 * formatow): limit jednostek i cena za jednostke w mikrolamportach.
 */
export function budgetOf(instructions: TransactionInstruction[]): { units: number; microLamports: number } {
  let units = 200_000;
  let microLamports = 0;
  for (const ix of instructions) {
    if (!isBudget(ix)) continue;
    const data = Buffer.from(ix.data);
    if (data[0] === 2) units = data.readUInt32LE(1);
    if (data[0] === 3) microLamports = Number(data.readBigUInt64LE(1));
  }
  return { units, microLamports };
}

export const priorityFee = (units: number, microLamports: number): bigint => BigInt(Math.ceil((units * microLamports) / 1_000_000));

/** Limity v1 odpowiadajace budzetowi z instrukcji ComputeBudget; dane kont bez ograniczenia. */
export function limitsOf(instructions: TransactionInstruction[]): V1Limits {
  const { units, microLamports } = budgetOf(instructions);
  return { computeUnitLimit: units, loadedAccountsDataSizeLimit: MAX_LOADED_DATA_BYTES, priorityFeeLamports: priorityFee(units, microLamports) };
}

function toKitInstruction(ix: TransactionInstruction) {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner
        ? k.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : k.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}

/** Niepodpisana transakcja v1 w postaci gotowej do przekazania portfelowi. */
export function compileV1(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  recentBlockhash: string,
  limits: V1Limits = limitsOf(instructions),
): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayer(address(payer.toBase58()), m),
    // Wysokosc bloku nie trafia do transakcji; waznosc pilnuje wysylajacy.
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(recentBlockhash), lastValidBlockHeight: 0n }, m),
    (m) => setTransactionMessageConfig(limits, m),
    (m) => appendTransactionMessageInstructions(instructions.filter((ix) => !isBudget(ix)).map(toKitInstruction), m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

/** Sygnatura (identyfikator) podpisanej transakcji v1. */
export function signatureOfV1(signed: Uint8Array): string {
  return getSignatureFromTransaction(getTransactionDecoder().decode(signed) as Parameters<typeof getSignatureFromTransaction>[0]);
}

/** Blockhash wpisany w podpisana transakcje v1 (portfel moze go podmienic przed podpisem). */
export function blockhashOfV1(signed: Uint8Array): string {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(signed).messageBytes);
  return (message as unknown as { lifetimeToken: string }).lifetimeToken;
}

/** Konta transakcji: wszystkie rozne adresy (z programami i platnikiem) oraz ile z nich jest zapisywalnych. */
export function accountsOf(instructions: TransactionInstruction[], payer: PublicKey): { accounts: number; writable: number } {
  const keys = new Map<string, boolean>([[payer.toBase58(), true]]);
  for (const ix of instructions) {
    if (isBudget(ix)) continue;
    const program = ix.programId.toBase58();
    if (!keys.has(program)) keys.set(program, false);
    for (const k of ix.keys) {
      const key = k.pubkey.toBase58();
      keys.set(key, (keys.get(key) ?? false) || k.isWritable);
    }
  }
  let writable = 0;
  for (const w of keys.values()) if (w) writable++;
  return { accounts: keys.size, writable };
}

/** Rozmiar transakcji v1 i jej konta; null, gdy nie da sie jej zlozyc. */
export function measureV1(instructions: TransactionInstruction[], payer: PublicKey): { bytes: number; accounts: number; writable: number } | null {
  try {
    const bytes = compileV1(instructions, payer, PublicKey.default.toBase58(), { computeUnitLimit: 1, loadedAccountsDataSizeLimit: 1, priorityFeeLamports: 1n }).length;
    return { bytes, ...accountsOf(instructions, payer) };
  } catch {
    return null;
  }
}

export interface V1Simulation {
  err: unknown;
  logs: string[];
  units: number;
  loadedBytes: number;
  /** Liczba zagniezdzonych wywolan programow (CPI) we wszystkich instrukcjach. */
  inner: number;
}

/**
 * Symulacja transakcji v1. Idzie surowym zapytaniem RPC: klient web3.js 1.x nie sklada
 * transakcji w tym formacie. Blockhash podmienia RPC, podpis nie jest sprawdzany.
 */
export async function simulateV1(conn: Connection, instructions: TransactionInstruction[], payer: PublicKey): Promise<V1Simulation> {
  const probe = compileV1(instructions, payer, PublicKey.default.toBase58(), {
    computeUnitLimit: MAX_COMPUTE_UNITS,
    loadedAccountsDataSizeLimit: MAX_LOADED_DATA_BYTES,
    priorityFeeLamports: 0n,
  });
  const res = await fetch(conn.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [Buffer.from(probe).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true }],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { error?: { message?: string }; result?: { value: { err: unknown; logs?: string[]; unitsConsumed?: number; loadedAccountsDataSize?: number; innerInstructions?: { instructions: unknown[] }[] | null } } };
  if (body.error || !body.result) throw new Error(body.error?.message ?? "RPC error");
  const v = body.result.value;
  const inner = (v.innerInstructions ?? []).reduce((s, g) => s + g.instructions.length, 0);
  return { err: v.err ?? null, logs: v.logs ?? [], units: v.unitsConsumed ?? 0, loadedBytes: v.loadedAccountsDataSize ?? 0, inner };
}
