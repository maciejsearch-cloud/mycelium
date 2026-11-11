# Audyt wkładu węzłów (24.10.2026)

Źródło: wyłącznie zapisane dane – tabele `myc_results`, `myc_jobs`, `myc_models`, `myc_model_rejections`,
`myc_node_stats`, `myc_candidates` (Supabase, stan na 24.10.2026 ok. 20:20 CEST) oraz logi węzłów box1/box2.
Nic nie jest szacowane z symulacji. Zapytania: `docs/contribution-audit.sql`; na żywo: Weryfikacja → „Wkład węzłów” (widoki `supabase/myc_contrib.sql`).

## Najważniejsze liczby

| | wartość |
|---|---|
| wyniki zadań (wszystkie modele) | 10 472 |
| aktualizacje treningu/hiperparametrów | 8 986, z czego **przyjęte 1 151 (12,8%)**, odrzucone 7 804, oczekujące 31 |
| czas obliczeń zapisany przez węzły | 34,3 h (przeglądarki 32,9 h, węzły Python 1,3 h¹) |
| od 19.10: aktualizacje odrzucone / przyjęte | **6 664 / 78** – 30,8 h obliczeń przeglądarek, które dały łącznie +0,5 pkt proc. trafności |
| GPU | WebGPU w przeglądarkach: 2 010 wyników, 1,0 h, przyjęte tylko 59 (2,9%). CUDA/DirectML: **nigdy** (węzły Python liczą na CPU) |

¹ `ms` węzłów Python mierzy samo obliczenie zadania (ok. 51 s na zadanie treningu LM); wolumen lepiej widać w FLOP:
box1 2 331 TFLOP, box2 1 988 TFLOP (zapis w `myc_results.flops`).

## Węzły / urządzenia

Baza nie zapisuje typu urządzenia (brak user-agenta), więc przypisanie do „PC / telefon” jest częściowo pośrednie.

| węzeł | co to jest (wg danych) | backend | wyniki | przyjęte / odrzucone aktualizacje | czas | wkład do opublikowanych wersji |
|---|---|---|---|---|---|---|
| f5eff02e | przeglądarka, 18.10 (pierwszy dzień) | wasm, webgl | 812 | 648 / 55 | 0,65 h | **największy**: 648 aktualizacji we wszystkich 4 modelach obrazowych/tekstowych |
| cb33797d | przeglądarka „przegladarka/zadania/wzrost”, 18–24.10 (przeglądarka właściciela – jej rozmowy z czatem 24.10) | wasm, webgpu | 3 336 | 181 / 2 598 | 1,8 h | 181 aktualizacji, głównie 18.10 |
| 4a575785 | przeglądarka, 18–19.10 | wasm, webgpu | 879 | 45 / 720 | 0,5 h | 45 |
| **6651f4a4** | przeglądarka działająca 19–22.10, gdy komputer agentów był wyłączony → najpewniej Twój PC albo telefon | wasm, webgpu | 4 945 | **49 / 4 243** | **29,5 h** | 49 aktualizacji, ale wersje po 19.10 dały tylko +0,09 pkt (har) i +0,28 pkt (words) |
| 1a5438e4 | **box1** (węzeł Python na komputerze agentów) | cpu | 48 | 7 / 39 (LM) | 2 331 TFLOP | 7 z 12 aktualizacji w LM v1 |
| 1bed8dae | **box2** | cpu | 40 | 5 / 33 (LM) | 1 988 TFLOP | 5 z 12 aktualizacji w LM v1 + 1 niezależna ocena (v2) |
| 11 innych | krótkie sesje przeglądarek 18–19.10 | wasm/webgl/webgpu | 373 | 216 / 86 | 0,6 h | razem 216 |
| **Twój stały węzeł PC (MyceliumNode.exe)** | – | – | **0** | **0** | **0** | **brak śladu w bazie**: żadnej dzierżawy zadania, wyniku ani statystyki. Węzeł albo nie dotarł do pętli zadań (np. pobieranie modelu 988 MB, błąd startu), albo działał tylko jako czat. Do sprawdzenia: strona stanu `http://localhost:8765` na PC. |
| telefon | nie da się odróżnić – brak typu urządzenia w danych | | | | | |

Węzeł Python `c830fd26` (cron „python-cron”, GitHub Actions) zapisuje tylko statystyki odpowiedzi (50 wpisów), nie trenuje.

## Postęp modeli i skąd się wziął

| model | v0 → ostatnia wersja | kiedy powstał postęp |
|---|---|---|
| fashion | 11,8% → 90,75% (v52) | 51 z 53 wersji 18.10; od 19.10 +0,0 pkt |
| har | 17,6% → 95,77% (v52) | 49 wersji 18.10; od 19.10 +0,09 pkt |
| intent | 0,5% → 92,77% (v44) | 44 wersje 18.10; od 19.10 **0 nowych wersji** mimo 4 046 odrzuconych aktualizacji |
| words | 3,7% → 56,91% (v45) | 43 wersje 18.10; od 19.10 +0,46 pkt |
| lm | v0 32,8% / perpleksja 40,7 → v1 33,6% / 32,8 | v1 z 12 aktualizacji box1+box2 (19.10); od tego czasu 72 aktualizacje odrzucone |

Linia FedAvg: aktualizacja jest „przyjęta” (`myc_results.status = accepted`) tylko, gdy weszła do opublikowanej wersji
(`myc_finalize`). Prawie cały postęp modeli obrazowo-tekstowych pochodzi z 18.10 (1 073 przyjęte aktualizacje
tego dnia, głównie f5eff02e i cb33797d). Postęp LM pochodzi w 100% z box1 i box2.

## Zmarnowana praca

1. **Trening modeli na plateau** – fashion/har/intent/words po 18.10 prawie nie rosną, a przeglądarki dalej trenują
   je w kółko: od 19.10 6 664 odrzucone aktualizacje i 30,8 h obliczeń na +0,5 pkt. Największy przypadek: węzeł
   6651f4a4 – 29,5 h, 99% odrzuceń (`regression`).
2. **LM: rundy bez publikacji** – 72 aktualizacje LM odrzucone, 0 nowych wersji od 19.10. Przyczyny (naprawione w PR #51):
   rezerwacja publikacji (3 min) wygasała w trakcie oceny kandydata (`no reservation` w logach box2), a test 250 pytań był
   za mały, by wykazać poprawę (perpleksja 30,7–31,6 vs 32,8, ale trafność −1–2 pytania = szum).
3. **WebGPU prawie bezużyteczne** – 2 010 wyników na GPU, tylko 59 przyjętych (2,9%), bo trafiały w modele na plateau.
4. **Stały węzeł PC nie pracuje** – 0 zadań; cała moc „stałego węzła” to dziś tylko box1/box2.
5. **Powtórne oceny** – zadania `eval` (pomiar bieżącej wersji) liczone wielokrotnie przez te same przeglądarki
   (np. intent v43: 463 oceny tej samej wersji).
6. **Brak typu urządzenia** – nie da się uczciwie rozdzielić wkładu PC i telefonu.
