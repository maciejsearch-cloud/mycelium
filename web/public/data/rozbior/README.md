# Dane rozbioru zdań (warstwa rozumienia)

Pliki `*-pdb-*.json.gz` / `test-pdb.json.gz`: UD_Polish-PDB (Alina Wróblewska i in., IPI PAN),
https://github.com/UniversalDependencies/UD_Polish-PDB, rev 27235e131fae – licencja **CC BY-NC-SA 4.0**
(https://creativecommons.org/licenses/by-nc-sa/4.0/). Zmiany: konwersja CoNLL-U → JSON (form, lemma, upos, feats, head, deprel).

Pliki `*-lfg-*.json.gz` / `test-lfg.json.gz`: UD_Polish-LFG (Agnieszka Patejuk, Adam Przepiórkowski, IPI PAN),
https://github.com/UniversalDependencies/UD_Polish-LFG, rev 890f3855c915 – licencja **GPL-3.0**. Zmiany: jak wyżej.

`walenty.json.gz`: Walenty – słownik walencyjny języka polskiego (IPI PAN), https://zil.ipipan.waw.pl/Walenty,
wersja 2021-07-12, schematy zweryfikowane – licencja **CC BY-SA 4.0**. Zmiany: schematy → listy pytań (KTO/CO, KOMU/CZEMU…).

Podziały są oficjalne (train / dev / test); test służy wyłącznie do bramki role-F1 (`meta.json` → `eval_files`, `eval_sha`).
Generowanie: `scripts/export_rozbior.py`, `scripts/export_walenty.py`.

## Wagi modelu i leksykony Morfeusza – licencje rozdzielone (25.10.2026)

Wagi uczone na danych dziedziczą ich licencję, a CC BY-NC-SA 4.0 i GPL-3.0 nie dają się połączyć w jednym pliku. Dlatego:

| Plik | Uczone na | Licencja |
|---|---|---|
| model domyślny – baza `myc_rb_models`, `myc-models/rozbior/v1-…` (wariant **PDB**) | tylko UD_Polish-PDB train | **CC BY-NC-SA 4.0** |
| `models/rb-lfg-70793f8d.bin` (wariant **LFG**, przełącznik pod tabelą rozbioru) | tylko UD_Polish-LFG train | **GPL-3.0** |
| `morf.json.gz` | Morfeusz 2 / SGJP (BSD-2) + mapa tagów z PDB train | CC BY-NC-SA 4.0 |
| `morf-lfg.json.gz` | Morfeusz 2 / SGJP (BSD-2) + mapa tagów z LFG train | GPL-3.0 |

Wycofany: model v0 (`rozbior/v0-f324f348.bin`, PDB+LFG razem) – nie jest już rozpowszechniany. Węzły douczają tylko
linię PDB (shardy `train-pdb-*`, `iot_mycelium.mesh.rbwork`). Trening: `python -m iot_mycelium.rozbior.trening --tb pdb|lfg`.
Wyniki na teście UD: `wyniki.json` → `variants`, `results/rozbior/pdb-eval.json`.
