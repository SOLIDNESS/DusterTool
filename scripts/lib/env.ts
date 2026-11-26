/**
 * Wspolna konfiguracja skryptow: polaczenie RPC i ladowanie portfeli projektu.
 *
 * Portfele sa ladowane WYLACZNIE z katalogu keys/ w projekcie. Skrypty nigdy
 * nie siegaja do domyslnej konfiguracji solana-cli (~/.config/solana).
 */
import { Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const KEYS_DIR = path.join(ROOT, "keys");
export const OUT_DIR = path.join(ROOT, "out");

export type WalletName = "deployer" | "treasury" | "crank" | "tester";

function loadDotEnv(): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(eq + 1).trim();
  }
}
loadDotEnv();

export const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

export function connection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

export function loadWallet(name: WalletName): Keypair {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Brak portfela '${name}' (${file}). Uruchom najpierw: npm run keys`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

export function writeOut(name: string, data: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return file;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
