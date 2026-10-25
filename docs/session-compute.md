# Sesja: rozproszone obliczenia w przeglądarkach

**Przepływ:** wersja v0 (inicjalizacja) → runda (zadania w `myc_jobs`) → węzły pobierają zadania (`myc_claim`, dzierżawa 3 min,
maks. 5 prób) → liczą w Web Workerach → oddają wynik (`myc_submit`) → dowolny węzeł agreguje i publikuje v+1 (`myc_publish`).
Baza pilnuje, żeby runda i wersja powstały tylko raz (blokada doradcza, numer wersji = ostatnia + 1).

**Backendy (TF.js 4.22):** wątek GPU próbuje WebGPU, potem WebGL. Wątki CPU używają WASM z SIMD.
Każdy z N wątków działa na osobnym rdzeniu, więc wielowątkowość daje pula workerów. Wariant „threaded” WASM
wymaga SharedArrayBuffer (COOP/COEP), czego GitHub Pages nie ustawia. Celowo nie używamy shimu coi-serviceworker,
bo wymusza COEP także na Supabase i Hugging Face. Brakujące w WASM jądro `Conv2DBackpropFilter` jest w `web/src/compute/wasmConvGrad.ts`.

**Zadania:** `train` (odłamek, E epok, Adam, FedProx μ), `hparam` (lr ×0,5 i ×2), `eval` (odłożony test), `label`
(predykcje dla nieocenionej puli obrazków z zadań captcha), `verify` (co czwarta aktualizacja sprawdzana na innym węźle).

**Kompresja:** top-k (fashion 50%, reszta 25%) + int8 ze skalą na tensor. Deklarowana trafność dotyczy aktualizacji po kompresji.

**Walidacja przy agregacji:** przycięcie normy do 2× mediany, kosinus do mediany po współrzędnych < 0 → odrzucenie,
ponowny pomiar na walidacji (spadek > 3 pkt → odrzucenie), deklaracja ≠ pomiar (> 6 pkt) → odrzucenie,
niezgodna weryfikacja krzyżowa (> 4 pkt) → odrzucenie. Potrzeba ≥ 3 przyjętych. Średnia ważona liczbą próbek (FedAvg),
krok serwera 1,0 albo 0,5 wybierany na walidacji. Wagi trafiają do Supabase Storage (`myc-models`, ścieżki adresowane treścią).

**Dane** (`scripts/export_ml_shards.py` → `web/public/data/ml`): Fashion-MNIST (24×1000 trening, walidacja 1000, test 2000 z t10k),
UCI HAR (oficjalny podział osób), CLINC150 (osadzenia zdań MiniLM-L6, q8), słowniki (osadzenia wielojęzycznego MiniLM-L12
+ trigramy znaków 512 + język). Osadzenia liczy `web/scripts/export-embeddings.mjs` (transformers.js, ten sam ONNX co w przeglądarce).
Architektury są w `meta.json` (`arch`), a wersja modelu zapisuje swoje `arch`; węzeł bierze zadania tylko dla zgodnej architektury.

**Węzeł nasienny:** `scripts/seed_train.py` (PyTorch, CPU) trenuje nową architekturę na tych samych odłamkach
(AdamW, OneCycle, wygładzanie etykiet, augmentacja obrazów), wybiera epokę po walidacji, `web/scripts/verify-seed.mjs`
sprawdza wagi w TF.js, a `myc_publish_seed` (tylko właściciel bazy) publikuje je przez tę samą bramkę.
Etykiety słów pochodzą z hiperonimów WordNetu, więc cechy hiperonimów byłyby przeciekiem etykiety – celowo ich nie używamy.

**Bramka bez regresji (serwer, `supabase/myc_gate.sql`):** węzeł najpierw rezerwuje wersję v+1 atomowo
(`myc_reserve`, compare-and-swap na ostatniej wersji, rezerwacja 3 min), dopiero potem agreguje, wysyła wagi
(najpierw `myc_weights_exist`, więc bez duplikatów) i publikuje przez `myc_publish_v2`. Baza przyjmuje wersję tylko, gdy
trafność na stałym odłożonym teście (liczba próbek + sha256 etykiet z `myc_eval_sets`) jest ≥ trafności bieżącej wersji
(tolerancja 0). Odrzucone kandydatury są w `myc_model_rejections`, aktualizacje rundy zostają odrzucone, a węzły
ogłaszają kolejną rundę tej samej wersji na następnych odłamkach. Stara `myc_publish` jest usunięta.
`myc_sweep` (pg_cron co 5 min) zwraca wygasłe dzierżawy do puli i wygasza zadania starych wersji.

**Niezależna ocena (`supabase/myc_verify.sql`):** agregator nie publikuje – zgłasza kandydata (`myc_propose`).
Baza tworzy zadania `reeval`; węzeł inny niż zgłaszający i z innego IP (skrót IP z nagłówka) liczy trafność wag
kandydata na stałym teście. Wersja powstaje, gdy ocenią ją ≥ 2 węzły z różnych IP albo zaufany węzeł
(`.github/workflows/verify.yml`, co godzinę, numpy, klucz `MYC_VERIFIER_KEY`, w bazie tylko sha256). Liczy się
najniższy zweryfikowany wynik; rozbieżność z deklaracją > 1 pkt → odrzucenie; potem bramka bez regresji.
Identyfikatory weryfikatorów są w `myc_models.verifiers` i `myc_candidate_evals`. Kandydat bez oceny przez 6 h wygasa.

**Znane ograniczenia:** agregator to przeglądarka. Kilka węzłów jednej osoby z różnych IP (np. VPN) mogłoby się zmówić przy weryfikacji – zaufany cron jest
niezależny, ale nie wymagany. W headless Chromium WebGPU (SwiftShader)
nie przydziela buforów, więc działa zapas WebGL.
