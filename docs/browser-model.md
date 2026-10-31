# Model grzybni w przeglądarce (bez węzłów)

- Czat najpierw odpowiada ze źródeł w przeglądarce (tryb lekki): Wikidata, Wikipedia, pamięć wiedzy, słowniki,
  kalkulator, pytania osobiste. Ta ścieżka nigdy nie potrzebowała węzłów i zostaje bez zmian.
- Do swobodnej rozmowy potrzebny jest model generujący:
  - gdy jakiś węzeł ma cały model, odpowiada węzeł (etykieta „odpowiada: węzeł”);
  - gdy nie ma, użytkownik może jednym przyciskiem uruchomić model w przeglądarce (`web/src/mesh/local.ts`).
    Wtedy etykieta to „odpowiada: przeglądarka”.
- Model w przeglądarce to Qwen2.5-0.5B-Instruct (Apache-2.0) z najnowszym opublikowanym adapterem LoRA grzybni
  (`myc_models`, model `lm`). Pierwsze 8 znaków SHA-256 adaptera musi się zgadzać z nazwą pliku.
  - Adapter jest scalany z wagami q/k/v/o przy wczytywaniu (`qwen.ts: loadShard(..., lora)`). Potem wagi są
    kwantyzowane do int8, a jądro tfjs rozpakowuje je do float32 (zmierzone ok. 4,4 GB RAM całej przeglądarki).
  - Zgodność z Pythonem (`mesh/qwen.py` + `lm.runtime`) sprawdzono na warstwach 0–2: korelacja efektu adaptera
    0,9999, stosunek norm 1,07 (szum int8).
- Wagi (~990 MB bf16) są pobierane zakresami bajtów z Hugging Face i zapisywane w Cache Storage
  (`myc-local-lm-v1`). Przycisk „wyłącz i zwolnij dysk” je usuwa.
- Ta przeglądarka nie staje się węzłem. Używa osobnego Workera i niczego nie ogłasza w sieci.
- Odpowiedzi dalej przechodzą tę samą kontrolę co z węzłów:
  - liczby muszą pochodzić ze źródła;
  - bez źródła odpowiedź dostaje dopisek „(Bez źródła…)”;
  - pytania osobiste i fakty nie trafiają do modelu.
- W bazie tryb ma wartość `local` (`supabase/myc_local_lm.sql`).

## Szybkość (31.10.2026)

- **Pula wątków** (`web/src/mesh/pool.ts`, `mm.worker.ts`): bez WebGPU każda macierz jest dzielona wierszami na
  N wątków roboczych (N = rdzenie − 1, najwyżej 6; `?threads=N` do pomiarów). GitHub Pages nie ustawia COOP/COEP, więc
  wątki WASM (SharedArrayBuffer) są niedostępne – pula działa bez nich. Próba izolacji przez service worker
  (COEP credentialless) działała, ale wątki tfjs-wasm w zbudowanym Workerze się nie uruchamiały, więc ją porzuciliśmy.
- **WebGPU** zostaje pierwszym wyborem (`tfKernel('auto')`); gdy działa, pula nie jest używana.
- **Stały prompt systemowy**: fakty z bazy idą w treści pytania, a historia zawiera dokładnie to, co wysłano/wygenerowano,
  więc pamięć K/V rozmowy jest używana ponownie. Po wczytaniu model od razu liczy prompt systemowy („prompt X s” na karcie).
- **Strumień tokenów** – bez zmian (tokeny pokazywane na bieżąco).
- **Mniejsza kwantyzacja** (int4) nie przyspieszyłaby liczenia, bo tfjs i tak liczy w float32; zmniejszyłaby tylko pobieranie.
  Odłożone.

Pomiar `web/e2e-eval/local-lm.spec.ts` (ten sam komputer, Chromium bez GPU, 8 rdzeni, bez węzłów – osobny pokój sieci):

| | przed | po |
|---|---|---|
| wczytanie (pobranie ~1 GB + przygotowanie) | 83,6 s | 73,9 s (+5,8 s prompt systemowy) |
| „Napisz jedno zdanie o lesie.” – pierwszy token | 39,5 s | 5,0 s |
| tamże – tokeny/s | 1,84 | 7,02 |
| „Opowiedz mi krótko, czym jest grzybnia.” (z faktami) – pierwszy token | 90,7 s | 13,9 s |
| tamże – tokeny/s | 1,83 | 5,18 |

Wyniki: `results/chat_facts/2026-10-312033-local_lm_v1-before-local.json`, `…-after-local.json`.
