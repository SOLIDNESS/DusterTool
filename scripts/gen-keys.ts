/**
 * Generuje nowe portfele projektu do katalogu keys/ (poza repozytorium).
 *
 * - keys/<nazwa>.json   : format solana-cli (tablica 64 bajtow)
 * - keys/WALLETS.txt    : adresy i klucze prywatne base58 do importu w Phantomie
 *
 * Skrypt nigdy nie czyta ani nie nadpisuje istniejacych kluczy: jesli plik
 * danego portfela juz istnieje, portfel jest pomijany. Na ekran trafiaja
 * wylacznie adresy publiczne.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const KEYS_DIR = path.join(ROOT, "keys");

const WALLETS: { name: string; role: string }[] = [
  { name: "deployer", role: "tworzy token i pool, wdraza program (uprawnienia do aktualizacji)" },
  { name: "treasury", role: "przychody: fee od rentu i nasza polowa oplat z poola; wlasciciel pozycji LP" },
  { name: "crank", role: "bot wywolujacy buyback co godzine; trzyma tylko SOL na oplaty sieciowe" },
  { name: "tester", role: "portfel testowy: kupuje martwe tokeny i wykonuje wymiany" },
];

fs.mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(KEYS_DIR, 0o700);

const created: string[] = [];
for (const w of WALLETS) {
  const file = path.join(KEYS_DIR, `${w.name}.json`);
  if (fs.existsSync(file)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
    console.log(`${w.name.padEnd(9)} ${kp.publicKey.toBase58()}  (juz istnial, pominiety)`);
    continue;
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  created.push(w.name);
  console.log(`${w.name.padEnd(9)} ${kp.publicKey.toBase58()}  (nowy)`);
}

// WALLETS.txt jest zawsze odtwarzany z plikow .json, zeby byl z nimi zgodny.
const lines: string[] = [
  "DUSTER - portfele projektu",
  "Ten plik zawiera klucze prywatne. Nie wysylaj go nikomu i nie wklejaj na czat.",
  "Import w Phantomie: Dodaj / Polacz portfel -> Importuj klucz prywatny -> wklej wartosc 'klucz prywatny'.",
  "",
];
for (const w of WALLETS) {
  const file = path.join(KEYS_DIR, `${w.name}.json`);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  lines.push(`[${w.name}]`);
  lines.push(`rola:           ${w.role}`);
  lines.push(`adres:          ${kp.publicKey.toBase58()}`);
  lines.push(`klucz prywatny: ${bs58.encode(kp.secretKey)}`);
  lines.push("");
}
const walletsFile = path.join(KEYS_DIR, "WALLETS.txt");
fs.writeFileSync(walletsFile, lines.join("\n"), { mode: 0o600 });
fs.chmodSync(walletsFile, 0o600);

console.log(`\nNowe portfele: ${created.length ? created.join(", ") : "brak"}`);
console.log(`Klucze prywatne zapisane w: ${walletsFile}`);
