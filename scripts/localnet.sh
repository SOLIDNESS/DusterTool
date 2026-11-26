#!/usr/bin/env bash
# Lokalny walidator z kopia programu Meteora DAMM v2 z mainnetu i naszym programem.
# --mint jest podany jawnie, zeby walidator nie siegal po domyslny klucz solana-cli.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOYER=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(require("./keys/deployer.json"))).publicKey.toBase58())')
PROGRAM_ID=$(node -e 'console.log(require("./src/sdk/idl/duster.json").address)')

exec solana-test-validator \
  --ledger test-ledger --reset --quiet \
  --mint "$DEPLOYER" \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --bpf-program "$PROGRAM_ID" target/deploy/duster.so \
  --rpc-port 8899
