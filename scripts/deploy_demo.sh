#!/usr/bin/env bash
# Wdrożenie demo: build z BASE=/demo/mycelium/, strażnik ścieżek, pull repo demo, podmiana plików (node/ zostaje), push.
# Użycie: scripts/deploy_demo.sh [katalog repo demo=/workspace/projects/demo]
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
demo=${1:-/workspace/projects/demo}
rev=$(git -C "$here" rev-parse --short HEAD)
python3 "$here/scripts/p71_chain.py" || echo "p71: saldo zostaje z poprzedniego pliku (źródła niezgodne/niedostępne)"
(cd "$here/web" && BASE=/demo/mycelium/ npm run build)
"$here/scripts/check_demo_base.sh" "$here/web/dist/index.html"
git -C "$demo" pull -q --rebase
dst="$demo/mycelium"
find "$dst" -mindepth 1 -maxdepth 1 ! -name node -exec rm -rf {} +
(cd "$here/web/dist" && find . -mindepth 1 -maxdepth 1 ! -name node -exec cp -r {} "$dst/" \;)
"$here/scripts/check_demo_base.sh" "$dst/index.html"
git -C "$demo" add -A mycelium
git -C "$demo" commit -qm "mycelium: build $rev" || { echo "bez zmian"; exit 0; }
git -C "$demo" -c http.version=HTTP/1.1 push -q
echo "wdrożono $rev"
