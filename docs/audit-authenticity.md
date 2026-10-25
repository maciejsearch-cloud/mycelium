# Audyt autentyczności (2026-10-18)

Cel: każda liczba, wykres, węzeł, zadanie i wynik w UI pochodzi z prawdziwych obliczeń albo zapisanych rekordów;
brak danych = pusty stan („—”, „brak danych jeszcze”). Dane syntetyczne – tylko w testach.

Przeszukano (Python i web): `Math.random`, `mock`, `fake`, `dummy`, `demo`, `placeholder`, `simulat*/symul*`, `stub`,
`synthetic`, `TODO/FIXME`, `setTimeout`/`setInterval`, liczby zastępcze (`?? 0`, `|| 0`), liczby wpisane na sztywno w tekstach.

## Znalezione i naprawione

| # | Plik:linia (przed) | Problem | Naprawa |
|---|---|---|---|
| 1 | `web/src/myc/session.ts:175` | odłamek danych losowany `Math.random` | przydział deterministyczny (węzeł + runda); w kolejnym PR – przydział z kolejki zadań `myc_jobs` |
| 2 | `web/src/myc/brain.ts:420` | eksploracja wzrostu na `Math.random` (nieodtwarzalna) | `seededRng(węzeł:krok)` (mulberry32) – odtwarzalna |
| 3 | `web/src/pages/Tasks.tsx:137` | klasa w siatce obrazków losowana | klasa z największą liczbą nieocenionych obrazków (aktywne uczenie) |
| 4 | `web/src/pages/Tasks.tsx:141` | bez modelu ranking obrazków = `Math.random()` (udawana pewność) | bez modelu brak rankingu (0), kolejność z ziarna |
| 5 | `web/src/pages/RealAI.tsx:17` | brak metryki pokazywany jako `0.0%` / `0.000` | „—” |
| 6 | `web/src/pages/RealAI.tsx:142` | brak punktu FedProx/DP rysowany jako 0% | `null` (przerwa na wykresie) |
| 7 | `web/src/pages/Knowledge.tsx:144` | brak zgodności węzła pokazywany jako 0% | „—” |
| 8 | `web/src/pages/Teach.tsx:350` | „ok. 89% zamiast 67%” wpisane na sztywno | liczone z priorów konsensusu (`OWNER_PRIOR`, `PRIOR`) |
| 9 | `web/src/pages/Session.tsx:42`, `supabase/myc_schema.sql:323` | próbki = `n × 8` (stała liczba epok na sztywno) | węzeł zapisuje faktyczną liczbę przetworzonych próbek (`metrics.samples`, potem kolumna `samples`) |
| 10 | `web/public/data/snapshot.json`, `scripts/export_frontend_data.py:215` | publiczny snapshot zawierał sekcje zadań-zabawek na generowanych danych (XOR itp.: `tasks`, `benchmarks`, `evolution`, `curves`, `agents`, `slots`, `iq`) – nieużywane w UI | usunięte z publicznego snapshotu i typów; tylko z `--legacy` lokalnie |
| 11 | `scripts/export_frontend_data.py:164` | eksport nie odrzucał wyników na danych syntetycznych | eksport kończy się błędem, gdy `synthetic: true` |
| 12 | `web/llm-test.mjs`, `web/verify-*.mjs` (nieśledzone) | jednorazowe skrypty próbne w katalogu aplikacji | usunięte |
| 13 | brak strażnika w CI | nic nie blokowało powrotu `Math.random`/mocków | `web/scripts/check-authenticity.mjs` (w `npm run lint`) + `tests/test_authenticity.py` |

## Sprawdzone i pozostawione (z uzasadnieniem)

- `web/src/myc/store.ts:85`, `brain.ts:381` – `crypto.randomUUID`/`getRandomValues` do identyfikatorów (dozwolone).
- `session.ts:242`, `compute.worker.ts:7` – `setTimeout` to przerwy cyklu pracy (oszczędzanie CPU/temperatury), nie udawany postęp.
- `brain.ts:526` – `?? 0.5` to apriori dla pytania bez odpowiedzi, używane tylko do kolejności pytań (nie wyświetlane jako wynik).
- `src/iot_mycelium/ai/datasets.py:435+` – generatory `_synthetic_*`: wyłącznie dla testów/CI (`IOT_MYCELIUM_SYNTHETIC=1`); `history.py` i eksport odrzucają takie przebiegi; test pilnuje, że nikt poza `datasets.py` ich nie wywołuje.
- `src/iot_mycelium/iot_orchestrator.py` – polecenie CLI `simulate` (test obciążenia lokalnego); jego wyniki nie trafiają do UI ani bazy.
- `memory.py`, `universal_agent.py`, `optimized_agent.py` – losowa inicjalizacja wag (z ziarnem) – standard, nie dane.

Razem: **13 znalezisk naprawionych**, 6 sprawdzonych i świadomie pozostawionych.
