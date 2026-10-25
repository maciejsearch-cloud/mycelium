#!/usr/bin/env bash
# Co 2 min: jeśli nadzorca zniknął (np. po restarcie komputera), uruchom start.sh ponownie.
while true; do
  [ -e /workspace/projects/myc-nodes/STOP ] || /workspace/projects/myc-nodes/start.sh >/dev/null 2>&1
  /workspace/projects/myc-nodes/lm_dispatch.sh >/dev/null 2>&1
  sleep 120
done
