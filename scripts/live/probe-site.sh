#!/usr/bin/env bash
# Sprawdza z zewnatrz, czy strona nie wydaje plikow ani danych, ktorych nie powinna:
# pliki spoza katalogu strony, ustawienia serwera, klucz dostawcy RPC, mapy zrodel.
# Uzycie: scripts/live/probe-site.sh [https://duster.lol] [adres IP serwera, gdy DNS jeszcze nie dziala]
set -uo pipefail
BASE="${1:-https://duster.lol}"
IP="${2:-}"
HOST=$(printf '%s' "$BASE" | sed -E 's#^https?://([^/:]+).*#\1#')
OPTS=(-s -m 15 --path-as-is)
[ -n "$IP" ] && OPTS+=(--resolve "$HOST:443:$IP")
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
FAIL=0

echo "=== naglowki bezpieczenstwa"
curl "${OPTS[@]}" -I "$BASE/" | grep -iE "^(HTTP/|content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|permissions-policy)" | cut -c1-150

echo "=== proby pobrania plikow, ktorych strona nie moze wydac"
for u in "/.env" "/../.env" "/..%2f.env" "/..%2f..%2f..%2fetc%2fduster%2fduster.env" "/%2e%2e/%2e%2e/etc/passwd" \
  "/assets/../../deployments/test.json" "/assets/..%2f..%2f..%2f..%2fetc%2fduster%2fduster.env" "/keys/crank.json" \
  "/etc/duster/crank.json" "/dist/server.js" "/dist/crank.js" "/.git/config" "/api/env" "/VERSION" "/deploy/duster.env.example"; do
  code=$(curl "${OPTS[@]}" -o "$TMP" -w '%{http_code}' "$BASE$u")
  # Aplikacja jednostronicowa: nieznana sciezka bez rozszerzenia dostaje index.html, to nie jest wyciek.
  if grep -qiE "RPC_URL|api-key|helius|root:x:|BEGIN OPENSSH|secretKey|fromSecretKey|\[[0-9]{1,3}(,[0-9]{1,3}){63}\]" "$TMP"; then
    verdict="WYCIEK"; FAIL=1
  elif [ "$code" = "200" ] && grep -q "<div id=\"root\">" "$TMP"; then
    verdict="ok (strona glowna)"
  elif [ "$code" = "200" ]; then
    verdict="UWAGA: 200 z inna trescia"; FAIL=1
  else
    verdict="ok"
  fi
  printf "  %-58s %s  %s\n" "$u" "$code" "$verdict"
done

echo "=== mapy zrodel i klucze w plikach strony"
ASSETS=$(curl "${OPTS[@]}" "$BASE/" | grep -oE '/assets/[A-Za-z0-9_.-]+\.(js|css)' | sort -u)
for a in $ASSETS; do
  curl "${OPTS[@]}" -o "$TMP" "$BASE$a"
  hits=$(grep -ciE "helius|api-key=|ghp_|sourceMappingURL|VITE_DEV_WALLET" "$TMP")
  keys=$(grep -cE "\[[0-9]{1,3}(,[0-9]{1,3}){63}\]" "$TMP")
  map=$(curl "${OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE$a.map")
  [ "$hits" != "0" ] || [ "$keys" != "0" ] || [ "$map" = "200" ] && FAIL=1
  printf "  %-44s podejrzane wpisy: %s, tablice kluczy: %s, mapa zrodel: %s\n" "$a" "$hits" "$keys" "$map"
done

echo "=== /api/config (publiczne adresy wdrozenia, nic wiecej)"
curl "${OPTS[@]}" "$BASE/api/config" | cut -c1-300; echo

rpc() { curl "${OPTS[@]}" -X POST "$BASE/api/rpc" -H 'content-type: application/json' "$@" | cut -c1-160; }
echo "=== proxy RPC"
echo "  bez naglowka Origin:  $(rpc -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}')"
echo "  obcy Origin:          $(rpc -H 'origin: https://evil.example' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}')"
echo "  nasz Origin:          $(rpc -H "origin: $BASE" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}')"
echo "  zakazana metoda:      $(rpc -H "origin: $BASE" -d '{"jsonrpc":"2.0","id":1,"method":"getProgramAccounts","params":[]}')"
echo "  blad od dostawcy:     $(rpc -H "origin: $BASE" -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["x"]}')"
for probe in '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["x"]}' '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"bogus"}]}' '[{"jsonrpc":"2.0","id":1,"method":"getSlot"},{"jsonrpc":"1.0","method":"getVersion"}]'; do
  if rpc -H "origin: $BASE" -d "$probe" | grep -qiE "api-key|helius"; then echo "  WYCIEK adresu dostawcy w odpowiedzi na: $probe"; FAIL=1; fi
done

[ "$FAIL" = "0" ] && echo "WYNIK: brak wyciekow" || echo "WYNIK: SA PROBLEMY (patrz wyzej)"
exit "$FAIL"
