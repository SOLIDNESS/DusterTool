#!/usr/bin/env bash
# Przygotowuje lokalny walidator (npm run localnet:pump) do testow aplikacji w przegladarce:
# zasila portfele projektu, tworzy token i pool testowy, konfiguruje program, robi zakup,
# stake i pierwszy buyback. Wynik trafia do deployments/local.json.
set -euo pipefail
cd "$(dirname "$0")/../.."

export RPC_URL=http://127.0.0.1:8899 DEPLOYMENT=local
WEB_TESTER=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(require("./out/localnet-pump/tester.json"))).publicKey.toBase58())')

for _ in $(seq 1 90); do
  curl -s -m 2 "$RPC_URL" -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"' && break
  sleep 1
done

rm -f deployments/local.json
WEB_TESTER="$WEB_TESTER" node -e '
const {Connection,Keypair,PublicKey,LAMPORTS_PER_SOL}=require("@solana/web3.js");
const key=(n)=>Keypair.fromSecretKey(Uint8Array.from(require("./keys/"+n+".json"))).publicKey;
(async()=>{
  const c=new Connection(process.env.RPC_URL,"confirmed");
  for (const [k,n] of [[key("deployer"),20],[key("crank"),2],[key("tester"),5],[new PublicKey(process.env.WEB_TESTER),0.05]]) {
    const s=await c.requestAirdrop(k,n*LAMPORTS_PER_SOL);
    await c.confirmTransaction({signature:s,...(await c.getLatestBlockhash())});
  }
})()'
npx tsx scripts/live/setup-token-pool.ts --send | tail -2
ALT_SAMPLE_WALLET="$WEB_TESTER" npx tsx scripts/live/duster.ts init --send | tail -1
npx tsx scripts/live/duster.ts buy 2 --send | tail -1
npx tsx scripts/live/duster.ts stake 500000 --send | tail -1
npx tsx scripts/live/duster.ts buyback --send | tail -1
echo "gotowe: portfel testowy aplikacji $WEB_TESTER"
