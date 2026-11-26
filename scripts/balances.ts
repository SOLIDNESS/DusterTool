/** Pokazuje adresy i salda SOL portfeli projektu. */
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { connection, loadWallet, RPC_URL, type WalletName } from "./lib/env";

async function main() {
  const names: WalletName[] = ["deployer", "treasury", "crank", "tester"];
  const conn = connection();
  console.log(`RPC: ${new URL(RPC_URL).host}`);
  for (const name of names) {
    const kp = loadWallet(name);
    const lamports = await conn.getBalance(kp.publicKey);
    console.log(`${name.padEnd(9)} ${kp.publicKey.toBase58()}  ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
