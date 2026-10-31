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
    kwantyzowane do int8 (ok. 0,6 GB RAM).
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
