#!/usr/bin/env bash
# Weryfikacja programu Duster (verified build): explorery pokazuja wtedy, ze program w sieci
# zostal zbudowany z publicznego kodu na GitHubie.
#
# Program w sieci musi byc co do bajtu taki sam jak wynik budowania w obrazie Dockera
# (solana-verify), dlatego do wdrozenia idzie plik z `build`, a nie z `anchor build`.
# Po kazdej aktualizacji programu trzeba przejsc te kroki od nowa.
#
#   bash scripts/live/verify-program.sh build            buduje w Dockerze kod, ktory jest na GitHubie,
#                                                        i podstawia wynik jako target/deploy/duster.so
#   bash scripts/live/deploy-program.sh deploy --send    wgrywa ten plik (aktualizacja programu)
#   bash scripts/live/verify-program.sh submit           pokazuje, co zostanie wyslane
#   bash scripts/live/verify-program.sh submit --send    zapisuje w sieci dane weryfikacji (podpisuje
#                                                        keys/deployer.json) i zleca sprawdzenie OtterSec
#   bash scripts/live/verify-program.sh status
#
# Uzywa wylacznie kluczy projektu. solana-verify dostaje pusty katalog domowy, zeby nie siegal
# po konfiguracje ani klucze solana-cli z komputera.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${RPC_URL:-}" ] && [ -f .env ]; then
  RPC_URL=$(sed -n 's/^RPC_URL=//p' .env | tail -1)
fi
[ -n "${RPC_URL:-}" ] || { echo "Ustaw RPC_URL (w .env albo w srodowisku)." >&2; exit 1; }

CMD=${1:-status}
SEND=0
for arg in "$@"; do [ "$arg" = "--send" ] && SEND=1; done

REPO_URL="${REPO_URL:-https://github.com/SOLIDNESS/DusterTool}"
LIBRARY=duster
# Sciezka bezwzgledna: solana-verify przechodzi do sklonowanego repo, zanim otworzy klucz.
DEPLOYER_KEY="$PWD/keys/deployer.json"
PROGRAM_ID=$(node -e 'console.log(require("./src/sdk/idl/duster.json").address)')
SRC=out/verify-src
SO=target/deploy/duster.so

# Adres Dockera ustalamy przed podmiana katalogu domowego.
DOCKER_HOST=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)}
export DOCKER_HOST
VERIFY_HOME="$PWD/out/verify-home"
mkdir -p "$VERIFY_HOME"
verify() { HOME="$VERIFY_HOME" solana-verify "$@"; }
hide_key() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=<x>/g'; }

# Commit, ktory jest na GitHubie (tam trafia drzewo bez czesci prywatnej, wiec rozni sie od lokalnego).
remote_commit() { git ls-remote "$REPO_URL" refs/heads/main | cut -f1; }
onchain_hash() { verify get-program-hash -u "$RPC_URL" "$PROGRAM_ID" 2>&1 | hide_key | tail -1; }

case "$CMD" in
  build)
    COMMIT=$(remote_commit)
    [ -n "$COMMIT" ] || { echo "Nie moge odczytac galezi main z $REPO_URL" >&2; exit 1; }
    git cat-file -e "$COMMIT^{commit}" 2>/dev/null || git fetch -q "$REPO_URL" main
    git cat-file -e "$COMMIT^{commit}" 2>/dev/null || COMMIT=FETCH_HEAD
    echo "kod: $REPO_URL @ $(git rev-parse "$COMMIT")"
    rm -rf "$SRC" && mkdir -p "$SRC"
    git archive "$COMMIT" | tar -x -C "$SRC"
    (cd "$SRC" && verify build --library-name "$LIBRARY") 2>&1 | tail -4
    # solana-verify zostawia obok losowy klucz; nie jest nam potrzebny.
    rm -f "$SRC/target/deploy/$LIBRARY-keypair.json"
    mkdir -p target/deploy
    cp "$SRC/target/deploy/$LIBRARY.so" "$SO"
    echo "zbudowano:  $(verify get-executable-hash "$SO") ($(wc -c < "$SO" | tr -d ' ') bajtow) -> $SO"
    echo "w sieci:    $(onchain_hash)"
    ;;

  submit)
    COMMIT=$(remote_commit)
    LOCAL=$(verify get-executable-hash "$SO")
    CHAIN=$(onchain_hash)
    DEPLOYER=$(solana-keygen pubkey "$DEPLOYER_KEY")
    echo "program:    $PROGRAM_ID"
    echo "kod:        $REPO_URL @ $COMMIT"
    echo "zbudowano:  $LOCAL"
    echo "w sieci:    $CHAIN"
    if [ "$LOCAL" != "$CHAIN" ]; then
      echo "Program w sieci rozni sie od zbudowanego. Najpierw: verify-program.sh build, potem deploy-program.sh deploy --send." >&2
      exit 1
    fi
    if [ "$SEND" != 1 ]; then
      echo "Zgodne. Dodaj --send, zeby zapisac dane weryfikacji w sieci (podpisuje $DEPLOYER) i zlecic sprawdzenie."
      exit 0
    fi
    # solana-verify zawsze czyta plik konfiguracyjny solana-cli; dostaje projektowy, nie ten z komputera.
    verify verify-from-repo --skip-build -y -u "$RPC_URL" -k "$DEPLOYER_KEY" --config "$PWD/out/solana-cli.yml" \
      --program-id "$PROGRAM_ID" --library-name "$LIBRARY" --commit-hash "$COMMIT" "$REPO_URL" 2>&1 | hide_key
    verify remote submit-job -u "$RPC_URL" --program-id "$PROGRAM_ID" --uploader "$DEPLOYER" 2>&1 | hide_key
    ;;

  status)
    echo "w sieci:    $(onchain_hash)"
    [ -f "$SO" ] && echo "lokalnie:   $(verify get-executable-hash "$SO")"
    echo "OtterSec:   $(curl -fsS -m 20 "https://verify.osec.io/status/$PROGRAM_ID" || echo niedostepne)"
    ;;

  *)
    echo "Uzycie: $0 build | submit [--send] | status" >&2
    exit 1
    ;;
esac
