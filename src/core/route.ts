/**
 * Zamiana waluty kwotowania na SOL.
 *
 * Czesc tokenow pump.fun jest sparowana nie z SOL, tylko z innym tokenem (USDC, PUMP, akcje
 * tokenizowane, inny token pump.fun). Sprzedaz takiego tokena na pump.fun daje te walute, wiec
 * zeby na koncu byl SOL, w tej samej transakcji zamieniamy ja przez agregator Jupiter.
 *
 * Kwota waluty jest znana dopiero w chwili wykonania, dlatego uzywamy "token ledger" Jupitera:
 * instrukcja `ledger` zapamietuje saldo konta przed sprzedaza, a `swap` zamienia dokladnie tyle,
 * ile od tamtej chwili przybylo. Konto wraca wiec do salda sprzed wymiany.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";

export const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const JUPITER_API = "https://lite-api.jup.ag/swap/v1";
/** Stale konta programu Jupiter obecne w kazdej zamianie; trafiaja do naszej tabeli adresow. */
export const JUPITER_EVENT_AUTHORITY = new PublicKey("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");

export interface RouteQuote {
  inputMint: PublicKey;
  /** Kwota wejsciowa, dla ktorej policzono wycene. */
  inAmount: bigint;
  /** Oczekiwany wynik w lamportach (wSOL). */
  outLamports: bigint;
  /** Nazwy gield na trasie, do podgladu. */
  labels: string[];
  /** Odpowiedz agregatora, potrzebna do zlozenia instrukcji. */
  raw: unknown;
}

export interface RouteInstructions {
  /** Zapamietuje saldo konta waluty; musi stac przed sprzedaza tokena. */
  ledger: TransactionInstruction;
  /** Zamienia na wSOL to, co przybylo na koncie waluty od instrukcji `ledger`. */
  swap: TransactionInstruction;
  lookupTables: AddressLookupTableAccount[];
}

export interface RouteLimits {
  /** Limit kont na trase; mniejszy daje prostsza (krotsza w bajtach) trase, czasem z gorszym kursem. */
  maxAccounts?: number;
  /** Tylko trasy przez jedna gielde. */
  directOnly?: boolean;
}

export interface Router {
  /** Wycena zamiany `amount` tokena `inputMint` na SOL; null, gdy nie ma trasy. */
  quote(inputMint: PublicKey, amount: bigint, limits?: RouteLimits): Promise<RouteQuote | null>;
  /**
   * Instrukcje zamiany dla wyceny. Wynik trafia na konto wSOL wlasciciela (musi istniec),
   * waluta jest brana z jego konta ATA (tez musi istniec). null, gdy trasy nie da sie zlozyc.
   */
  instructions(quote: RouteQuote, owner: PublicKey): Promise<RouteInstructions | null>;
}

export interface JupiterOptions {
  baseUrl?: string;
  /** Dopuszczalny poslizg zamiany w punktach bazowych. */
  slippageBps?: number;
  /** Limit kont na trase: zamiana musi sie zmiescic w transakcji obok sprzedazy i programu Duster. */
  maxAccounts?: number;
  fetch?: typeof fetch;
}

interface RawInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toInstruction(raw: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(raw.data, "base64"),
  });
}

export function jupiterRouter(conn: Connection, opts: JupiterOptions = {}): Router {
  const base = opts.baseUrl ?? JUPITER_API;
  const slippageBps = opts.slippageBps ?? 300;
  const maxAccounts = opts.maxAccounts ?? 24;
  const doFetch = opts.fetch ?? fetch;
  const tables = new Map<string, Promise<AddressLookupTableAccount | null>>();

  /** Zapytanie z ponawianiem przy limicie zapytan; null przy kazdej innej odmowie. */
  async function call(url: string, init?: RequestInit): Promise<unknown | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, init);
      } catch {
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return res.json().catch(() => null);
    }
    return null;
  }

  function loadTable(address: string): Promise<AddressLookupTableAccount | null> {
    let cached = tables.get(address);
    if (!cached) {
      cached = conn
        .getAddressLookupTable(new PublicKey(address))
        .then((r) => r.value)
        .catch(() => null);
      tables.set(address, cached);
    }
    return cached;
  }

  return {
    async quote(inputMint, amount, limits = {}) {
      if (amount <= 0n) return null;
      const query = new URLSearchParams({
        inputMint: inputMint.toBase58(),
        outputMint: NATIVE_MINT.toBase58(),
        amount: amount.toString(),
        slippageBps: String(slippageBps),
        swapMode: "ExactIn",
        maxAccounts: String(limits.maxAccounts ?? maxAccounts),
        restrictIntermediateTokens: "true",
        ...(limits.directOnly ? { onlyDirectRoutes: "true" } : {}),
      });
      const raw = (await call(`${base}/quote?${query}`)) as { outAmount?: string; routePlan?: { swapInfo?: { label?: string } }[] } | null;
      if (!raw?.outAmount) return null;
      const outLamports = BigInt(raw.outAmount);
      if (outLamports <= 0n) return null;
      return { inputMint, inAmount: amount, outLamports, labels: (raw.routePlan ?? []).map((p) => p.swapInfo?.label ?? "?"), raw };
    },

    async instructions(quote, owner) {
      const request = async (useSharedAccounts: boolean) => {
        const res = (await call(`${base}/swap-instructions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            quoteResponse: quote.raw,
            userPublicKey: owner.toBase58(),
            // wSOL zostaje na koncie uzytkownika: zamyka je (i odtwarza, jesli istnialo) otoczka paczki.
            wrapAndUnwrapSol: false,
            useTokenLedger: true,
            useSharedAccounts,
            dynamicComputeUnitLimit: false,
          }),
        })) as {
          tokenLedgerInstruction?: RawInstruction | null;
          setupInstructions?: RawInstruction[];
          swapInstruction?: RawInstruction;
          cleanupInstruction?: RawInstruction | null;
          addressLookupTableAddresses?: string[];
        } | null;
        if (!res?.swapInstruction || !res.tokenLedgerInstruction) return null;

        // Odpowiedzi z zewnatrz nie ufamy na slowo: przyjmujemy tylko instrukcje programu Jupiter,
        // w ktorych jedynym podpisujacym jest wlasciciel. Instrukcje przygotowawcze moga wylacznie
        // zakladac jego konta wSOL lub waluty (te i tak zakladamy sami, wiec je pomijamy); kazda inna
        // oznacza trase, ktora zostawilaby w portfelu nowe konto, i taka trase odrzucamy.
        const ledger = toInstruction(res.tokenLedgerInstruction);
        const swap = toInstruction(res.swapInstruction);
        for (const ix of [ledger, swap]) {
          if (!ix.programId.equals(JUPITER_PROGRAM_ID)) return null;
          if (ix.keys.some((k) => k.isSigner && !k.pubkey.equals(owner))) return null;
        }
        if (ledger.keys.some((k) => k.isSigner)) return null;
        if (res.cleanupInstruction) return null;
        for (const raw of res.setupInstructions ?? []) {
          const ix = toInstruction(raw);
          const createsOwnAccount =
            ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
            ix.keys.length >= 4 &&
            ix.keys[2].pubkey.equals(owner) &&
            (ix.keys[3].pubkey.equals(NATIVE_MINT) || ix.keys[3].pubkey.equals(quote.inputMint));
          if (!createsOwnAccount) return null;
        }
        return { ledger, swap, tables: res.addressLookupTableAddresses ?? [] };
      };
      // Najpierw zamiana prosto miedzy kontami uzytkownika: ma najmniej kont, a miejsca w transakcji
      // jest malo. Trasa przez kilka gield wymagalaby jednak kont posrednich w portfelu, wiec wtedy
      // korzystamy z kont posrednich nalezacych do Jupitera.
      const res = (await request(false)) ?? (await request(true));
      if (!res) return null;
      const { ledger, swap } = res;

      const loaded = await Promise.all(res.tables.map(loadTable));
      if (loaded.some((t) => t === null)) return null;
      return { ledger, swap, lookupTables: loaded as AddressLookupTableAccount[] };
    },
  };
}
