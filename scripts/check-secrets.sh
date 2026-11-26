#!/usr/bin/env bash
# Sprawdza pliki, ktore trafiaja do repozytorium (sledzone i nowe, bez ignorowanych),
# pod katem kluczy prywatnych, tokenow, kluczy API, adresow serwera i sciezek z dysku.
# Zwraca blad, gdy cos znajdzie. Uruchamiany automatycznie przez scripts/git-push.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

FILES=$(mktemp)
trap 'rm -f "$FILES"' EXIT
{ git ls-files; git ls-files --others --exclude-standard; } | sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done > "$FILES"
FAIL=0

check() { # opis, wzorzec, [wzorzec wyjatkow]
  local hits
  hits=$(xargs rg -n -H --no-heading -e "$2" < "$FILES" 2>/dev/null | { [ -n "${3:-}" ] && rg -v -e "$3" || cat; } | cut -c1-160)
  if [ -n "$hits" ]; then
    echo "ZNALEZIONO: $1"; echo "$hits" | head -10; FAIL=1
  fi
}

# Pliki, ktorych w repozytorium nie moze byc wcale.
BAD=$(rg -e '(^|/)(keys|out|target|node_modules)/' -e '(^|/)\.env($|\.)' -e '\.pem$' -e 'id_(rsa|ed25519)' -e 'keypair.*\.json$' -e 'WALLETS' "$FILES" | rg -v '\.env\.example$')
if [ -n "$BAD" ]; then echo "ZNALEZIONO: pliki z sekretami na liscie do repozytorium"; echo "$BAD"; FAIL=1; fi

check "klucz prywatny Solany (tablica 64 bajtow)" '\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]'
# Pliki wdrozen zawieraja podpisy transakcji, ktore wygladaja jak klucze (ta sama dlugosc);
# to, ze nie sa kluczami projektu, sprawdza nizej porownanie z keys/.
check "klucz prywatny Solany (base58)" '\b[1-9A-HJ-NP-Za-km-z]{85,90}\b' '^(package-lock\.json|Cargo\.lock|deployments/[A-Za-z0-9_-]+\.json):'
check "token GitHuba" 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
check "klucz API w adresie RPC" 'api-key=[A-Za-z0-9-]{12,}|helius-rpc\.com/\?|\.quiknode\.pro/[a-z0-9]{16,}'
check "klucz prywatny SSH/PEM" 'BEGIN [A-Z ]*PRIVATE KEY'
check "adres IP (poza lokalnymi)" '\b(?:\d{1,3}\.){3}\d{1,3}\b' '127\.0\.0\.1|0\.0\.0\.0|1\.2\.3\.4|^(package-lock\.json|Cargo\.lock):|check-secrets\.sh|^deploy/cloudflare-ips\.txt:'
check "sciezka z katalogu domowego" '/Users/[A-Za-z]|/home/[a-z]+/' 'check-secrets\.sh'

# Rzeczy podane w .env i keys/ nie moga sie powtorzyc w zadnym pliku repozytorium.
for src in .env keys/github_token keys/vps_host; do
  [ -f "$src" ] || continue
  while read -r secret; do
    [ ${#secret} -ge 8 ] || continue
    if xargs rg -l -F -e "$secret" < "$FILES" >/dev/null 2>&1; then echo "ZNALEZIONO: wartosc z $src w plikach repozytorium"; FAIL=1; fi
  done < <(rg -o -e '[A-Za-z0-9_-]{20,}' -e '(\d{1,3}\.){3}\d{1,3}' "$src" | sort -u)
done

# Zaden klucz prywatny z keys/ (w zapisie base58) nie moze wystapic w plikach repozytorium.
if ls keys/*.json >/dev/null 2>&1; then
  while read -r secret; do
    [ ${#secret} -ge 80 ] || continue
    if xargs rg -l -F -e "$secret" < "$FILES" >/dev/null 2>&1; then echo "ZNALEZIONO: klucz prywatny z keys/ w plikach repozytorium"; FAIL=1; fi
  done < <(node -e '
    const fs = require("fs");
    const bs58 = require("bs58").default ?? require("bs58");
    for (const f of fs.readdirSync("keys").filter((n) => n.endsWith(".json"))) {
      try {
        const a = JSON.parse(fs.readFileSync("keys/" + f, "utf8"));
        if (Array.isArray(a) && a.length === 64) console.log(bs58.encode(Uint8Array.from(a)));
      } catch {}
    }
  ')
fi

if [ "$FAIL" = "0" ]; then echo "sekrety: czysto ($(wc -l < "$FILES" | tr -d ' ') plikow sprawdzonych)"; fi
exit "$FAIL"
