#!/usr/bin/env bash
# Nadzorca jednego węzła grzybni: restart po awarii z narastającą przerwą (max 5 min).
# Samonaprawa: gdy brak środowiska (np. po wymianie komputera), tworzy venv z torch (CPU) i websockets.
# Użycie: supervise.sh <nazwa> <wątki>
set -u
NAME="$1"; THREADS="${2:-2}"
D=/workspace/projects/myc-nodes
REPO=/workspace/projects/iot-agents-mycelium
VENV=$D/venv
LOG=$D/logs/$NAME.log
STOP=$D/STOP
export MYC_CACHE=$D/cache
# limit RAM na węzeł: 2–4 GB = trening w mikro-paczkach (szczyt ok. 2,9 GB), < 2 GB = bez treningu
mkdir -p "$D/logs" "$MYC_CACHE"
ensure_env() {
  [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import torch, websockets" 2>/dev/null && return 0
  # jeden instalator naraz (flock), reszta czeka
  (
    flock 9
    [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import torch, websockets" 2>/dev/null && exit 0
    echo "[$(date '+%F %T %Z')] instaluję środowisko węzła" >> "$LOG"
    python3 -m venv "$VENV" && nice -n 10 "$VENV/bin/pip" install -q --index-url https://download.pytorch.org/whl/cpu torch >> "$LOG" 2>&1 \
      && nice -n 10 "$VENV/bin/pip" install -q websockets >> "$LOG" 2>&1
  ) 9> "$D/.install.lock"
}
child=
# zatrzymanie nadzorcy zatrzymuje też węzeł
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
delay=5
while [ ! -e "$STOP" ]; do
  start=$(date +%s)
  if ensure_env; then
    echo "[$(date '+%F %T %Z')] start $NAME (threads=$THREADS)" >> "$LOG"
    cd "$REPO" && PYTHONPATH="$REPO/src" OMP_NUM_THREADS=$THREADS MKL_NUM_THREADS=$THREADS nice -n 10 \
      "$VENV/bin/python" -m iot_mycelium.node --join --name "$NAME" --threads "$THREADS" --max-ram-gb "${MYC_MAX_RAM_GB:-3}" >> "$LOG" 2>&1 &
    child=$!
    wait "$child"
    rc=$?
  else
    rc=99
  fi
  echo "[$(date '+%F %T %Z')] exit $NAME rc=$rc" >> "$LOG"
  [ -e "$STOP" ] && break
  if [ $(( $(date +%s) - start )) -gt 600 ]; then delay=5; else delay=$(( delay * 2 > 300 ? 300 : delay * 2 )); fi
  sleep "$delay"
  [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 5000000 ] && tail -c 2000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
done
