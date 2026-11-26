#!/usr/bin/env bash
# Buduje program Duster i kopiuje IDL do klienta TypeScript.
# Klucz programu pochodzi z keys/program-duster.json (poza repozytorium).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f keys/program-duster.json ]; then
  echo "Brak keys/program-duster.json (klucz adresu programu)." >&2
  exit 1
fi

mkdir -p target/deploy src/sdk/idl
cp keys/program-duster.json target/deploy/duster-keypair.json
chmod 600 target/deploy/duster-keypair.json

anchor build

cp target/idl/duster.json src/sdk/idl/duster.json
cp target/types/duster.ts src/sdk/idl/duster.ts
ls -l target/deploy/duster.so | awk '{printf "program: %s bajtow\n", $5}'
