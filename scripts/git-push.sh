#!/usr/bin/env bash
# Zapisuje zmiany lokalnie i wysyla na GitHuba czesc publiczna, wylacznie tokenem projektu z keys/github_token.
#
# Na GitHubie jest tylko program on-chain i kod budujacy transakcje (programs/, src/, scripts/).
# Strona (web/), serwer (server/), wdrozenie na VPS (deploy/) i grafiki (assets/) zostaja wylacznie
# w lokalnym repozytorium: lokalna galaz ma pelna historie, a na GitHuba idzie drzewo bez tych katalogow.
#
# Nie korzysta z niczego, co jest ustawione na komputerze: globalna konfiguracja gita,
# zapisane hasla (pek kluczy), gh, klucze SSH sa pomijane. Token nie trafia do .git/config.
# Przed wyslaniem sprawdza pliki skryptem scripts/check-secrets.sh.
# Uzycie: scripts/git-push.sh ["opis zmian"]
#         FRESH_HISTORY=1 scripts/git-push.sh "opis"   zastepuje historie na GitHubie jednym commitem
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_URL="${REMOTE_URL:-https://github.com/SOLIDNESS/DusterTool.git}"
TOKEN_FILE=keys/github_token
[ -f "$TOKEN_FILE" ] || { echo "Brak $TOKEN_FILE"; exit 1; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 TZ=UTC
unset SSH_AUTH_SOCK GH_TOKEN GITHUB_TOKEN GIT_SSH GIT_SSH_COMMAND

bash scripts/check-secrets.sh

# Autor = konto, do ktorego nalezy token (adres noreply GitHuba), a nie ustawienia z komputera.
if ! git config --local user.email >/dev/null; then
  WHO=$(curl -fsS -m 20 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" https://api.github.com/user)
  LOGIN=$(printf '%s' "$WHO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).login))')
  ID=$(printf '%s' "$WHO" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
  git config --local user.name "$LOGIN"
  git config --local user.email "$ID+$LOGIN@users.noreply.github.com"
fi
git config --local commit.gpgsign false
git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "$REMOTE_URL" || git remote add origin "$REMOTE_URL"

MESSAGE="${1:-Update}"
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "$MESSAGE"
fi

# Haslo podaje pomocnik czytajacy plik z tokenem; token nie pojawia sie w argumentach polecen.
ASKPASS=$(mktemp)
trap 'rm -f "$ASKPASS"' EXIT
cat > "$ASKPASS" <<ASK
#!/bin/sh
case "\$1" in
  Username*) echo "x-access-token" ;;
  *) cat "$PWD/$TOKEN_FILE" ;;
esac
ASK
chmod 700 "$ASKPASS"
push_git() { GIT_ASKPASS="$ASKPASS" git -c credential.helper= "$@"; }

# Katalogi, ktore nie trafiaja na GitHuba.
PRIVATE_PATHS=(web server deploy assets)

push_git fetch -q origin main
PARENT=$(git rev-parse -q --verify refs/remotes/origin/main)

# Drzewo publiczne powstaje w osobnym indeksie; katalog roboczy i lokalna galaz zostaja nietkniete.
PUBLIC_INDEX=$(mktemp -u)
trap 'rm -f "$ASKPASS" "$PUBLIC_INDEX"' EXIT
GIT_INDEX_FILE="$PUBLIC_INDEX" git read-tree HEAD
GIT_INDEX_FILE="$PUBLIC_INDEX" git rm -r -q --cached --ignore-unmatch -- "${PRIVATE_PATHS[@]}"
TREE=$(GIT_INDEX_FILE="$PUBLIC_INDEX" git write-tree)
LEAK=$(git ls-tree -r --name-only "$TREE" | grep -E "^($(IFS='|'; echo "${PRIVATE_PATHS[*]}"))/" || true)
if [ -n "$LEAK" ]; then echo "W drzewie publicznym zostaly prywatne katalogi, przerywam" >&2; exit 1; fi

if [ "${FRESH_HISTORY:-}" = 1 ]; then
  # Jednorazowo: nowa historia na GitHubie z samym stanem obecnym (stare commity zawieraly prywatne katalogi).
  COMMIT=$(git commit-tree "$TREE" -m "$MESSAGE")
  push_git push -q --force origin "$COMMIT:refs/heads/main"
  git update-ref refs/remotes/origin/main "$COMMIT"
  echo "GitHub (nowa historia): $(git --no-pager log --oneline -1 "$COMMIT")"
elif [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  echo "GitHub: bez zmian w czesci publicznej"
else
  COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MESSAGE")
  push_git push -q origin "$COMMIT:refs/heads/main"
  git update-ref refs/remotes/origin/main "$COMMIT"
  echo "GitHub: $(git --no-pager log --oneline -1 "$COMMIT")"
fi
# Lokalna galaz ma inna historie niz GitHub, wiec nie moze go sledzic.
git branch --unset-upstream 2>/dev/null || true
echo "lokalnie: $(git --no-pager log --oneline -1)"
