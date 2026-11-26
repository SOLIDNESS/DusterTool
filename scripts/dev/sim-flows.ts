/**
 * Narzedzie deweloperskie: symuluje sprzedaz jednego tokena i wypisuje zmiane
 * salda SOL kazdego konta w transakcji, zeby zobaczyc dokad ida lamporty.
 * Uzycie: npx tsx scripts/dev/sim-flows.ts <portfel> <poczatek minta> [...]
 */
import { PublicKey } from "@solana/web3.js";
import { batchWrappers, buildItem, planBatches, saleOptions, toTransaction } from "../../src/core/convert";
import { withRetry } from "../../src/core/rpc";
import { scanWallet } from "../../src/core/scan";
import { connection, sleep } from "../lib/env";

async function main() {
  const owner = new PublicKey(process.argv[2]);
  const prefixes = process.argv.slice(3);
  const conn = connection();
  const scan = await scanWallet(conn, owner);
  const short = prefixes.includes("short");
  const picked = scan.accounts.filter(
    (x) =>
      (x.kind === "curve" || (short && x.kind === "worthless" && x.sellAmount > 0n)) &&
      (short ? x.sellCostLamports > 0n : prefixes.some((p) => x.mint.toBase58().startsWith(p))),
  );
  for (const a0 of picked) {
    // Pozycje odrzucone przez prog oplacalnosci tez chcemy zmierzyc, wiec traktujemy je jak sprzedawalne.
    const a = { ...a0, kind: "curve" as const };
    const item = await buildItem(a, saleOptions(scan, 2));
    if (!item) continue;
    const [batch] = planBatches([item], {
      owner,
      treasury: owner,
      rentFeeBps: 0,
      computeUnitLimit: 400_000,
      computeUnitPriceMicroLamports: 0,
      wrappers: await batchWrappers(scan),
    });
    const { blockhash } = await withRetry(() => conn.getLatestBlockhash());
    const tx = toTransaction(batch, owner, blockhash);
    const keys = tx.message.staticAccountKeys;
    // Portfel przykladowy bywa aktywny, wiec pomiar przyjmujemy tylko wtedy,
    // gdy salda sprzed i po symulacji sa identyczne (nic sie nie zmienilo w trakcie).
    let before = await withRetry(() => conn.getMultipleAccountsInfo(keys));
    let sim = null as Awaited<ReturnType<typeof conn.simulateTransaction>> | null;
    let stable = false;
    for (let attempt = 0; attempt < 6 && !stable; attempt++) {
      sim = await withRetry(() =>
        conn.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: "base64", addresses: keys.map((k) => k.toBase58()) },
        }),
      );
      const again = await withRetry(() => conn.getMultipleAccountsInfo(keys));
      stable = (again[0]?.lamports ?? 0) === (before[0]?.lamports ?? 0);
      if (!stable) before = again;
    }
    if (!sim) continue;
    if (!stable) console.log("  uwaga: salda zmienialy sie w trakcie pomiaru");
    const ownerDelta = (sim.value.accounts?.[0]?.lamports ?? 0) - (before[0]?.lamports ?? 0);
    const expected = Number(a.quoteLamports) + a.rentLamports - 5000;
    console.log(`\n${a.mint.toBase58()} roznica wzgledem wyceny ${ownerDelta - expected} | wycena netto ${a.quoteLamports} koszt ${a.sellCostLamports} rent konta ${a.rentLamports} blad ${JSON.stringify(sim.value.err)}`);
    keys.forEach((k, i) => {
      const pre = before[i];
      const post = sim.value.accounts?.[i];
      const preL = pre?.lamports ?? 0;
      const postL = post?.lamports ?? 0;
      const preLen = pre?.data.length ?? 0;
      const postLen = post ? Buffer.from(post.data[0], "base64").length : 0;
      if (preL !== postL || preLen !== postLen) {
        console.log(`  ${k.toBase58().padEnd(44)} ${String(postL - preL).padStart(12)} lamportow | bajty ${preLen} -> ${postLen} | wlasciciel ${(post?.owner ?? pre?.owner.toBase58() ?? "").toString().slice(0, 8)}`);
      }
    });
    await sleep(400);
  }
}

main().catch((e) => {
  console.error((e as Error).stack?.slice(0, 1500) ?? e);
  process.exit(1);
});
