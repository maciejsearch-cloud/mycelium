#!/usr/bin/env bash
# Strażnik ścieżek: każdy zasób w index.html musi zaczynać się od /demo/mycelium/ (build z BASE=/demo/mycelium/).
# Użycie: check_demo_base.sh <ścieżka/do/index.html | URL>   (URL: dodatkowo sprawdza, że zasoby zwracają 200)
set -euo pipefail
src=${1:?index.html albo URL}
base=/demo/mycelium/
if [[ $src == http* ]]; then html=$(curl -fsSL "$src"); else html=$(cat "$src"); fi
refs=$(grep -oE '(src|href)="[^"]+"' <<<"$html" | sed -E 's/^(src|href)="//; s/"$//' | grep -vE '^(https?:|data:|#|mailto:)' || true)
[ -n "$refs" ] || { echo "BŁĄD: brak zasobów w index.html" >&2; exit 1; }
bad=$(grep -vE "^($base|\./[^/])" <<<"$refs" || true)
if [ -n "$bad" ]; then echo "BŁĄD: ścieżki bez $base (build bez BASE?):" >&2; echo "$bad" >&2; exit 1; fi
if [[ $src == http* ]]; then
  origin=$(sed -E 's#^(https?://[^/]+).*#\1#' <<<"$src")
  for r in $(grep -E '^/.*\.(js|css)$' <<<"$refs"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$origin$r"); [ "$code" = 200 ] || { echo "BŁĄD: $r → $code" >&2; exit 1; }
  done
fi
echo "OK: $(wc -l <<<"$refs") ścieżek z $base"
