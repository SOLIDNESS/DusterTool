/** Narzedzie deweloperskie: wlasciciel, rozmiar i flaga executable podanych kont. */
import { PublicKey } from "@solana/web3.js";
import { connection } from "../lib/env";

async function main() {
  const conn = connection();
  const keys = process.argv.slice(2).map((k) => new PublicKey(k));
  const infos = await conn.getMultipleAccountsInfo(keys);
  keys.forEach((k, i) => {
    const a = infos[i];
    console.log(k.toBase58(), a ? `owner=${a.owner.toBase58()} exec=${a.executable} len=${a.data.length} lamports=${a.lamports}` : "brak");
  });
}
main();
