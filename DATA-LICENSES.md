# Licencje danych i wag / Data and weight licences

Kod źródłowy: **MIT** (plik `LICENSE`). Dane, pliki pochodne i wagi modeli **nie** są objęte licencją MIT –
każdy zachowuje licencję źródła. Pełna lista z adresami i autorami: [`licenses.json`](licenses.json)
(ta sama lista jest na stronie w zakładce źródeł/licencji).

Source code: **MIT** (`LICENSE`). Datasets, derived files and model weights are **not** MIT – each keeps the
licence of its source. Full list with URLs and authors: [`licenses.json`](licenses.json).

| Ścieżka / path | Źródło / source | Licencja / licence |
|---|---|---|
| `web/public/data/rozbior/*-pdb-*.json.gz`, `test-pdb.json.gz` | UD_Polish-PDB (IPI PAN) | CC BY-NC-SA 4.0 |
| `web/public/data/rozbior/*-lfg-*.json.gz`, `test-lfg.json.gz` | UD_Polish-LFG (IPI PAN) | GPL-3.0 |
| `web/public/data/rozbior/walenty.json.gz` | Walenty (IPI PAN) | CC BY-SA 4.0 |
| `web/public/data/rozbior/morf.json.gz` | Morfeusz 2 / SGJP (BSD-2) + mapa tagów z PDB train | CC BY-NC-SA 4.0 (formy Morfeusza: BSD-2) |
| `web/public/data/rozbior/morf-lfg.json.gz` | Morfeusz 2 / SGJP (BSD-2) + mapa tagów z LFG train | GPL-3.0 (formy Morfeusza: BSD-2) |
| model rozbioru – wariant PDB (baza `myc_rb_models`, `myc-models/rozbior/v1-…`) | wagi uczone tylko na PDB | CC BY-NC-SA 4.0 (domyślny) |
| `web/public/data/rozbior/models/rb-lfg-70793f8d.bin` | wagi uczone tylko na LFG | GPL-3.0 |
| `web/public/data/rozmowa/emo.json.gz` | Słowosieć 4.0 – Emotional Annotations Dictionary (M. Zaśko-Zielińska i in., CLARIN-PL 2018, hdl.handle.net/11321/553) | CC BY 4.0 |
| `web/src/myc/rozmowa/jokes.ts` | żarty autorskie projektu (oznaczone w odpowiedzi „żart autorski”) | MIT |
| `web/public/data/seed/facts.json` | Wikidata / Wikisłownik | CC0 1.0 / CC BY-SA 4.0 |
| `web/public/data/captcha.json` | Fashion-MNIST / EMNIST / OEWN / plWordNet | MIT / public domain / CC BY 4.0 / plWordNet licence |
| `web/public/data/lexicon.json` | Open English WordNet, plWordNet, CILI, VADER | CC BY 4.0 / plWordNet / CC BY 4.0 / MIT |
| `web/public/data/qa.json` | CLINC150 / NAB | CC BY 3.0 / AGPL-3.0 (dane) |
| `web/public/data/lm/*` | polska Wikipedia (tekst), Qwen2.5 (tokenizer) | CC BY-SA 4.0 / Apache-2.0 |
| `web/public/data/ml/*` | UCI HAR, Fashion-MNIST, CLINC150, WordNet | CC BY 4.0 / MIT / CC BY 3.0 / CC BY 4.0 |

Wycofane / withdrawn: model rozbioru v0 (PDB+LFG w jednym pliku wag) – licencje CC BY-NC-SA 4.0 i GPL-3.0 nie dają
się połączyć, więc od 25.10.2026 go nie rozpowszechniamy (warianty PDB i LFG są osobno).

Odpowiedzi kontrolne (gold) nie są częścią repozytorium – są tylko w bazie (`scripts/goldkit.py`,
`scripts/gold_rotate.py`).
