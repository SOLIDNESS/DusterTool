#!/usr/bin/env bash
# Lokalny walidator do proby generalnej: Meteora + pump.fun z mainnetu, nasz program
# i konta przygotowane przez scripts/localnet/pump-prepare.ts. Dodatkowo kopia konta Pyth
# z cena SOL/USD, zeby aplikacja mogla pokazac wartosci w dolarach.
set -euo pipefail
cd "$(dirname "$0")/.."

ARGS_FILE=out/localnet-pump/validator-args.txt
if [ ! -f "$ARGS_FILE" ]; then
  echo "Brak $ARGS_FILE. Uruchom najpierw: npx tsx scripts/localnet/pump-prepare.ts" >&2
  exit 1
fi

DEPLOYER=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(require("./keys/deployer.json"))).publicKey.toBase58())')
PROGRAM_ID=$(node -e 'console.log(require("./src/sdk/idl/duster.json").address)')

EXTRA=()
while IFS= read -r line; do
  [ -n "$line" ] && EXTRA+=("$line")
done < "$ARGS_FILE"

exec solana-test-validator \
  --ledger test-ledger --reset --quiet \
  --mint "$DEPLOYER" \
  --url "${CLONE_RPC_URL:-https://api.mainnet-beta.solana.com}" \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --maybe-clone 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE \
  --bpf-program "$PROGRAM_ID" target/deploy/duster.so \
  --rpc-port 8899 \
  "${EXTRA[@]}"
