#!/usr/bin/env bash
# Wdrozenie programu Duster. Uzywa WYLACZNIE kluczy projektu z keys/:
#   keys/deployer.json        placi i zostaje wlascicielem aktualizacji (upgrade authority)
#   keys/program-duster.json  adres programu
#   keys/program-buffer.json  konto robocze wgrywania (tworzone tu; pozwala wznowic przerwane wgrywanie)
# solana-cli dostaje wlasny plik konfiguracyjny z projektu, wiec nie czyta ~/.config/solana.
#
#   bash scripts/live/deploy-program.sh status
#   bash scripts/live/deploy-program.sh deploy          pokazuje koszty i polecenie
#   bash scripts/live/deploy-program.sh deploy --send   wgrywa program (albo aktualizuje istniejacy)
#   bash scripts/live/deploy-program.sh buffers         niedokonczone konta robocze
#   bash scripts/live/deploy-program.sh close-buffers --send   odzyskuje z nich SOL
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${RPC_URL:-}" ] && [ -f .env ]; then
  RPC_URL=$(sed -n 's/^RPC_URL=//p' .env | tail -1)
fi
if [ -z "${RPC_URL:-}" ]; then
  echo "Ustaw RPC_URL (w .env albo w srodowisku)." >&2
  exit 1
fi

CMD=${1:-status}
SEND=0
for arg in "$@"; do [ "$arg" = "--send" ] && SEND=1; done

SO=target/deploy/duster.so
DEPLOYER_KEY=keys/deployer.json
PROGRAM_KEY=keys/program-duster.json
BUFFER_KEY=keys/program-buffer.json
PRIORITY=${PRIORITY_MICROLAMPORTS:-20000}

for f in "$SO" "$DEPLOYER_KEY" "$PROGRAM_KEY"; do
  [ -f "$f" ] || { echo "Brak pliku $f" >&2; exit 1; }
done

# Konfiguracja solana-cli tylko dla projektu.
mkdir -p out
CONFIG=out/solana-cli.yml
cat > "$CONFIG" <<EOF
json_rpc_url: "$RPC_URL"
websocket_url: ""
keypair_path: "$PWD/$DEPLOYER_KEY"
address_labels: {}
commitment: confirmed
EOF
chmod 600 "$CONFIG"
sol() { solana -C "$CONFIG" --url "$RPC_URL" --keypair "$DEPLOYER_KEY" "$@"; }

DEPLOYER=$(solana-keygen pubkey "$DEPLOYER_KEY")
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEY")
IDL_ID=$(node -e 'console.log(require("./src/sdk/idl/duster.json").address)')
if [ "$PROGRAM_ID" != "$IDL_ID" ]; then
  echo "Adres z $PROGRAM_KEY ($PROGRAM_ID) rozni sie od adresu w IDL ($IDL_ID). Przebuduj program: npm run build:program" >&2
  exit 1
fi

SIZE=$(wc -c < "$SO" | tr -d ' ')
lamports_for() { sol rent "$1" --lamports | sed -n 's/.*: \([0-9]*\) lamports.*/\1/p' | tail -1; }
DATA_RENT=$(lamports_for $((SIZE + 45)))
BUFFER_RENT=$(lamports_for $((SIZE + 37)))
PROGRAM_RENT=$(lamports_for 36)
BALANCE=$(sol balance "$DEPLOYER" --lamports | awk '{print $1}')
fmt() { awk -v l="$1" 'BEGIN{printf "%.4f", l/1e9}'; }

EXISTS=0
if sol program show "$PROGRAM_ID" >/dev/null 2>&1; then EXISTS=1; fi

status() {
  echo "RPC:        ${RPC_URL%%\?*}"
  echo "program:    $PROGRAM_ID ($SIZE bajtow)"
  echo "deployer:   $DEPLOYER, saldo $(fmt "$BALANCE") SOL"
  if [ "$EXISTS" = 1 ]; then
    echo "stan:       program jest juz w sieci (deploy = aktualizacja)"
    sol program show "$PROGRAM_ID" | sed 's/^/            /'
    echo "koszt:      chwilowo $(fmt "$BUFFER_RENT") SOL na konto robocze (wraca po aktualizacji) + oplaty transakcyjne"
  else
    echo "stan:       programu nie ma jeszcze w sieci"
    echo "koszt:      depozyt staly $(fmt $((DATA_RENT + PROGRAM_RENT))) SOL + oplaty za ok. $((SIZE / 1000 + 5)) transakcji"
    echo "            w trakcie wgrywania potrzebne lacznie ok. $(fmt $((DATA_RENT + PROGRAM_RENT + 30000000))) SOL na portfelu deployer"
  fi
}

case "$CMD" in
  status)
    status
    ;;
  deploy)
    status
    NEED=$((DATA_RENT + PROGRAM_RENT + 30000000))
    [ "$EXISTS" = 1 ] && NEED=$((BUFFER_RENT + 10000000))
    if [ "$BALANCE" -lt "$NEED" ]; then
      echo "Za male saldo deployera: potrzeba ok. $(fmt "$NEED") SOL." >&2
      [ "$SEND" = 1 ] && exit 1
    fi
    if [ "$SEND" != 1 ]; then
      echo "Tryb podgladu. Dodaj --send, zeby wgrac program."
      exit 0
    fi
    if [ ! -f "$BUFFER_KEY" ]; then
      solana-keygen new --no-bip39-passphrase --silent --outfile "$BUFFER_KEY" >/dev/null
      chmod 600 "$BUFFER_KEY"
    fi
    sol program deploy "$SO" \
      --program-id "$PROGRAM_KEY" \
      --buffer "$BUFFER_KEY" \
      --fee-payer "$DEPLOYER_KEY" \
      --upgrade-authority "$DEPLOYER_KEY" \
      --with-compute-unit-price "$PRIORITY" \
      --max-sign-attempts 60 \
      --use-rpc
    # Konto robocze zostalo zuzyte; kolejne wgrywanie dostanie nowe.
    rm -f "$BUFFER_KEY"
    sol program show "$PROGRAM_ID"
    ;;
  buffers)
    sol program show --buffers --buffer-authority "$DEPLOYER"
    ;;
  close-buffers)
    sol program show --buffers --buffer-authority "$DEPLOYER" || true
    if [ "$SEND" != 1 ]; then
      echo "Tryb podgladu. Dodaj --send, zeby zamknac konta robocze i odzyskac SOL."
      exit 0
    fi
    sol program close --buffers --authority "$DEPLOYER_KEY" --recipient "$DEPLOYER"
    rm -f "$BUFFER_KEY"
    ;;
  *)
    echo "Nieznane polecenie: $CMD (status | deploy | buffers | close-buffers)" >&2
    exit 1
    ;;
esac
