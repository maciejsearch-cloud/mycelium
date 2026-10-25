#!/usr/bin/env bash
# Start stałych węzłów grzybni na tym komputerze (idempotentny; do @reboot / przy starcie sesji).
# Zatrzymanie: touch /workspace/projects/myc-nodes/STOP && pkill -f "myc-nodes/supervise.sh"; pkill -f "iot_mycelium.node --join --name box"
D=/workspace/projects/myc-nodes
rm -f "$D/STOP"
# nazwa:wątki – umiarkowane użycie CPU (komputer jest współdzielony; 8 rdzeni, ~2 GB RAM na węzeł)
for spec in box1:3 box2:2; do
  n=${spec%%:*}; t=${spec##*:}
  if pgrep -f "supervise.sh $n " >/dev/null; then echo "$n: już działa"; continue; fi
  setsid nohup "$D/supervise.sh" "$n" "$t" >/dev/null 2>&1 < /dev/null &
  echo "$n: uruchomiony"
done
