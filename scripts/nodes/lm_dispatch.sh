#!/usr/bin/env bash
# Przyspieszenie niezależnej oceny: gdy czeka kandydat modelu językowego, uruchom od razu weryfikator w GitHub Actions
# (repozytorium demo, publiczne – darmowe minuty) zamiast czekać na cron. Jeden przebieg na kandydata.
D=/workspace/projects/myc-nodes
id=$(curl -fsS "https://agortpieeygmcttjwjfx.supabase.co/rest/v1/myc_candidates?model=eq.lm&status=eq.pending&select=id" \
  -H "apikey: sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P" 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin); print(r[0]['id'] if r else '')" 2>/dev/null)
[ -z "$id" ] && exit 0
[ "$(cat $D/.lm_dispatched 2>/dev/null)" = "$id" ] && exit 0
busy=$(bash -lc 'gh run list -R maciejsearch-cloud/demo --workflow mycelium-lm-verify.yml --json status --jq "[.[]|select(.status!=\"completed\")]|length"' 2>/dev/null)
[ "${busy:-0}" != "0" ] && exit 0
bash -lc 'gh workflow run mycelium-lm-verify.yml -R maciejsearch-cloud/demo' >/dev/null 2>&1 && echo "$id" > $D/.lm_dispatched
