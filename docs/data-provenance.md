# Pochodzenie danych (data provenance) – 2026-10-24

Zasada: w UI pokazujemy **tylko** liczby z zapisanych pomiarów. Brak danych = „—” / „brak danych”, nigdy zero zastępcze ani wartość wymyślona.
Pod każdą liczbą na kartach KPI jest linia **(i)** ze źródłem, czasem pomiaru (Europe/Amsterdam, CEST/CET) i statusem:

| Status w UI | Znaczenie |
|---|---|
| **sprawdzone niezależnie** | wynik przeliczył ktoś inny niż zgłaszający: zaufany weryfikator GitHub Actions (`myc_ci_evals`, `myc_rebase_lm`) albo inny węzeł z innego IP (`myc_finalize`) |
| **zapis w bazie** | wiersze/agregaty Supabase z prawdziwych zdarzeń (odpowiedzi, wyniki, głosy); liczone przez SQL lub w przeglądarce tym samym kodem |
| **deklarowane przez węzły, bez niezależnej kontroli** | wartość podaje sam węzeł (czas obliczeń `ms`, szacunek FLOP, próbki, trafność z przeglądarki) |
| **nagrany przebieg, bez niezależnej kontroli** | plik z prawdziwego przebiegu (`snapshot.json`: `generated_at`, `git`, `machine`, `synthetic: false`) |
| (bez statusu) | policzone teraz w tej przeglądarce/na tym urządzeniu |

Filtr wiarygodności (`web/src/myc/provenance.ts`, `web/src/myc/dashboard.ts`): wiersze z NaN/Infinity, ujemnymi godzinami/FLOP,
trafnością poza 0–100%, `accepted > results` albo perpleksją < 1 nie są pokazywane. Stan bazy 24.10.2026: 140 wierszy `myc_node_stats`, 0 nieprawdopodobnych.

## Usunięte / zmienione (dlaczego)

| Było | Problem | Teraz |
|---|---|---|
| „IQ grzybni (na żywo)” 133,9 (Przegląd), „IQ” (Ucz AI), „Cel: IQ” + „następny próg” (Wzrost), „IQ x” w kanale aktywności, wykresy „IQ w czasie” | `iqFrom = 40 + 120 × średnia(intencje, czujnik, wiedza)` – wymyślona skala udająca IQ; średnia ~78% dawała „geniusza”. „Wiedza” to nawet nie trafność modelu, tylko odsetek pytań-faktów potwierdzonych przez ludzi. „Następny próg” = zaokrąglenie do 5 – cel bez znaczenia | „Testy w przeglądarce”: intencje x% (n=300), czujnik y% (n=220, trafność zbalansowana), fakty potwierdzone z% (n=22+pytania nauczycieli) – osobno, z n. Wykres: te trzy wartości w % z zapisanych wierszy. `iqFrom` usunięte; nowe wiersze zapisują `iq: null` i `n_intent/n_sensor/n_knowledge`. Kolumna `myc_growth.iq` i stare `acc.iq` zostają w bazie (zgodność), nie są wyświetlane. Strażnik `check-authenticity` blokuje powrót „IQ” w UI |
| KPI „IQ” liczone od razu przy starcie | wynik modelu startowego **przed** wczytaniem odpowiedzi z bazy (np. 0% faktów) pokazywany jako „na żywo” | ponowne przeliczenie po synchronizacji; do tego czasu ostatni zapisany pomiar z datą |
| „Mycelium Benchmark Score” 69,4 + wykres „MBS w czasie” | prawdziwy przebieg, ale jeden (17.10), bez daty i commita w UI; wykres z 1 punktem sugerował trend | „Benchmark (ai-bench, nagrany)” z datą, commitem i opisem skali (0 = losowo, 100 = ideał); zamiast wykresu – wyniki 4 zadań, dopóki nie ma ≥ 2 przebiegów. (data nagrania także w pasku bocznym: „Dane z: …”) |
| „Trafność LM (2000 pyt.)” | gdy brak `eval_n`, etykieta i tak mówiła 2000 | n tylko z `meta.eval_n`; 250 wyłącznie dla zbioru v1 |
| „Zysk z federacji” | znak „+” wpisany na sztywno | znak z wyniku |
| Wkład węzłów: „Czas obliczeń”, „Aktualizacje”, „Węzły z wynikami” | sumy tylko z 40 pierwszych węzłów (`limit=40`); błąd bazy pokazywany jako 0; „CUDA/DirectML: jeszcze brak” wpisane na sztywno | wszystkie węzły; błąd = „—”; CUDA/DirectML liczone z `myc_backend_contrib` |
| „Aktywne węzły dziś” (Zostań węzłem) | brał pierwszy dzień z listy (mógł być wczorajszy); błąd = 0 | wiersz z dzisiejszą datą (Amsterdam); błąd = „—” |
| Wykres „Trafność modeli: przed i po” (Wiedza) | mieszał oceny z przeglądarki i z crona Pythona (inny podział danych) | tylko oceny z przeglądarki na tym samym `qa.json` |

## Każda wyświetlana liczba → źródło → status

### Przegląd
| Metryka | Źródło | Status |
|---|---|---|
| Aktywne węzły (24 h / 1 h / łącznie) | widok `myc_node_contrib` (z `myc_results`), `last_at` | zapis w bazie |
| Wniesiona moc (h, CPU/GPU, PFLOP), „Skąd pochodzi moc” | widok `myc_backend_contrib`: suma `ms` i `flops` zgłoszonych z wynikiem | deklarowane przez węzły (FLOP = szacunek analityczny × próbki; prawdopodobieństwo sprawdzone: max ~243 GFLOP/s na CPU) |
| „wykorzystane x%” | `accepted/results`; accepted = wynik wszedł do wersji opublikowanej przez `myc_finalize` | sprawdzone niezależnie (bramka) |
| Model językowy v1, perpleksja 32,82 | `myc_models` (lm), `meta.ppl`, `meta.rebased[-1]` (weryfikator „gh-actions-lm”, torch-f32-x8, 24.10.2026 20:38 CEST) | sprawdzone niezależnie |
| Trafność LM 35,6% (712/2000) | `myc_models.acc`, `meta.correct`, `meta.eval_n` (zbiór v2, sha 9bebb6f4…) | sprawdzone niezależnie |
| Strzępki / pojęcia / tematy / zweryfikowane | RPC `myc_frag_stats` | zapis w bazie („zweryfikowane” = zatwierdzone głosami) |
| Do weryfikacji | `buildQueue()` w przeglądarce z wierszy bazy | zapis w bazie |
| Benchmark (ai-bench) 69,4, liniowy 65,6, wyniki 4 zadań | `snapshot.json` → `ai` (`generated_at` 2026-10-17T20:21:44Z, `git` a0d5680, `synthetic: false`) | nagrany przebieg |
| Testy w przeglądarce (intencje/czujnik/fakty, n) | `brain.evaluate()` na `qa.json` (test: 300 intencji CLINC150, 220 okien NAB) po synchronizacji; inaczej ostatni wiersz `myc_node_stats` (label `przegladarka`/`wzrost`) | liczone lokalnie / deklarowane przez węzły |
| Wykres trafności w czasie | `myc_node_stats` (kind browser, label `przegladarka`/`wzrost`), `acc.intent/sensor/knowledge` × 100 | deklarowane przez węzły |
| Mapa grzybni | `myc_answers`, `myc_growth`, konsensus | zapis w bazie |
| Etapy rozwoju 13/30 | `web/scripts/roadmap.json` (= docs/roadmap.md) odhaczane ręcznie | stan planu, nie pomiar (opisane w UI) |
| „Dane z: …” w pasku bocznym | `snapshot.json.generated_at` | nagrany przebieg |

### Pozostałe zakładki
| Zakładka | Metryka | Źródło | Status |
|---|---|---|---|
| Ucz AI | test intencji / czujnik / fakty (n) | `brain.evaluate()` | lokalnie |
| Ucz AI | moje odpowiedzi, poznane fakty, węzły | `myc_answers` + konsensus | zapis w bazie |
| Ucz AI | tabela „tylko start / z odpowiedziami” | `learnNow()`: model na zestawie startowym vs z etykietami od ludzi, ten sam test | lokalnie |
| Wiedza | fakty, pewność konsensusu, odpowiedzi, węzły, wykresy replay | `myc_answers` (odtworzenie konsensusu w czasie) | zapis w bazie |
| Wiedza / Wzrost | trafność kontrolna | RPC `myc_gold_stats`, `myc_gold_daily` (odpowiedzi kontra ukryte odpowiedzi `myc_gold`) | zapis w bazie |
| Wiedza | trafność modeli przed/po | `myc_node_stats` (przeglądarka) | deklarowane przez węzły |
| Wzrost | przyjęte/odrzucone ulepszenia, oś wzrostu | `myc_growth` | zapis w bazie |
| Weryfikuj | kolejka, dziś, „AI miało rację” | `buildQueue`, `myc_review_labels` | zapis w bazie |
| Zadania | model obrazów / liter | trafność na stałej próbce testowej Fashion-MNIST / EMNIST z `captcha.json`, w przeglądarce | lokalnie |
| Sesja | ta karta | pomiar w tej karcie | lokalnie |
| Sesja | mój wkład, miejsce, wykresy na godzinę | RPC `myc_compute_stats` | deklarowane przez węzły |
| Sesja | seria dni | dni z sesją zapisane w localStorage | lokalnie |
| Sesja / Weryfikacja | trafność modeli globalnych w wersjach | `myc_models` (bramka `myc_finalize`: ≥ 1 zaufany lub ≥ 2 inne IP) | sprawdzone niezależnie |
| Weryfikacja | ocenione ponownie w CI | `myc_ci_evals` (GitHub Actions przelicza z wag, link do przebiegu) | sprawdzone niezależnie |
| Weryfikacja | odrzucone wersje | `myc_model_rejections` | zapis w bazie |
| Weryfikacja | próbki w ostatniej godzinie | `myc_results.samples` | deklarowane przez węzły |
| Weryfikacja / Model językowy | wersja, perpleksja, trafność definicji | `myc_models` (lm) | sprawdzone niezależnie |
| Model językowy | wytrenowane tokeny | suma `samples` wyników LM | deklarowane przez węzły |
| Wkład węzłów | wykorzystane/odrzucone, godziny, GPU | `myc_node_contrib`, `myc_backend_contrib`, `myc_daily_contrib` | wykorzystane: sprawdzone; godziny: deklarowane |
| Zostań węzłem | online teraz | przekaźnik mesh (na żywo) | zapis/żywe |
| Zostań węzłem | aktywne dziś, łącznie, wykres, polecenia | RPC `myc_node_daily`, `myc_referrals` | zapis w bazie |
| Taksonomia | wersja, trafność (odłożone), NMI, grupy | RPC `myc_tax_list` (metryki zapisane przy publikacji) | zapis w bazie |
| Konto | punkty, polecenia, urządzenia | RPC konta (po stronie serwera) | zapis w bazie |
| Prawdziwe AI | wszystkie liczby | `snapshot.json` → `ai` (jeden przebieg `ai-bench`) | nagrany przebieg |
| Postępy projektu | PR-y, commity | `progress.json` z `git log` przy buildzie (`web/scripts/gen-progress.mjs`) | zapis (git) |

## Pliki `web/public/data/`
| Plik | Pochodzenie | Pole pochodzenia |
|---|---|---|
| `snapshot.json` | `scripts/export_frontend_data.py` z przebiegu `ai-bench` | `generated_at`, `ai.git`, `ai.machine`, `ai.synthetic=false`; eksport odrzuca `synthetic: true` |
| `progress.json` | `git log` przy buildzie | `generated_at`, `branch` (plik nie jest w repo) |
| `qa.json` | `scripts/export_qa_seed.py`: CLINC150 + NAB machine_temperature, zestawy startowe/testowe z jawnym ziarnem 42, pule kontrolne z tajnego `MYC_GOLD_SEED` (`scripts/goldkit.py`); 22 zdania-fakty wpisane ręcznie (prawdę ustala konsensus ludzi + ukryte `myc_gold`) | `version` |
| `captcha.json` | `scripts/export_captcha.py`: Fashion-MNIST, EMNIST, plWordNet/WordNet; zestawy startowe/testowe ziarno 11, pule kontrolne z tajnego `MYC_GOLD_SEED` | `sources` |
| `lexicon.json`, `register.json`, `taxo/`, `ml/` | eksporty ze słowników/zbiorów otwartych | `sources` / `source`, `license`, `built` |
| `lm/` | Polska Wikipedia 20231101.pl, tokenizer Qwen2.5-0.5B@7ae5576 | `source`, `license`, `parquet_sha256`, `split` |

## Pozostawione świadomie
- `src/iot_mycelium/ai/growth.py` (cron Pythona) nadal liczy `iq_from` jako wewnętrzny skalarny cel do akceptacji zmian i zapisuje go w `acc.iq` – w UI nie jest pokazywany.
- `seededRng` (eksploracja konfiguracji), `engine.worker.ts` (tasowanie próbek) – losowość treningu, nie wyświetlane dane.
- Trafność z przeglądarki zgłasza sam węzeł; zbiór testowy jest publiczny i stały, więc każdy może ją powtórzyć, ale nie ma jeszcze niezależnego przeliczenia (oznaczone w UI).
