# Źródła i licencje danych startowych (seed)

Strona uznania autorstwa dla kategorii i faktów startowych. W aplikacji: **Więcej › Taksonomia › „Kategorie i fakty startowe (seed) – źródła i licencje”**.

| Dane | Źródło | Licencja | Skrypt |
|---|---|---|---|
| Drzewo kategorii (łańcuchy hiperonimów) | [Open English WordNet 2025](https://en-word.net/) | CC BY 4.0 | `scripts/build_seed_taxonomy.py` |
| Polskie nazwy kategorii, znaczenia polskich słów | [plWordNet](https://plwordnet.pwr.wroc.pl/) przez Open Multilingual Wordnet | licencja plWordNet (typu WordNet) | `scripts/build_seed_taxonomy.py` |
| Mapowanie OEWN ↔ PWN 3.0/3.1 | [CILI](https://github.com/globalwordnet/cili) | CC BY 4.0 | `scripts/build_seed_taxonomy.py` |
| Polskie etykiety, P8814 (WordNet 3.1), P279/P171 (podklasa / takson), P910 | [Wikidata](https://www.wikidata.org/) | CC0 1.0 | `scripts/build_seed_taxonomy.py` |
| Kategorie polskiej Wikipedii (przez P910) | [Wikipedia](https://pl.wikipedia.org/) | CC BY-SA 4.0 | `scripts/build_seed_taxonomy.py` |
| Fakty (stolica, kontynent, państwo, język, waluta, autor, twórca, odkrywca, ujście, symbol, liczba atomowa, data urodzenia i nagroda laureatów Nobla) | [Wikidata](https://www.wikidata.org/) | CC0 1.0 | `scripts/build_seed_facts.py` |
| Definicje częstych polskich rzeczowników | [Wikisłownik](https://pl.wiktionary.org/) – autorzy Wikisłownika | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | `scripts/build_seed_facts.py` |

Każdy fakt w `web/public/data/seed/facts.json` ma link do strony źródła (`url`), datę pobrania (`retrieved`) i licencję (`licence`).
Definicje z Wikisłownika są przytaczane z linkiem do hasła (wymóg uznania autorstwa CC BY-SA); zmiany: usunięte znaczniki wiki i kwalifikatory.

## Zaufanie i uczciwa ocena

* Kategorie seed i fakty startowe mają **zaufanie średnie ze źródła** (seed 0,6; Wikidata 0,9; Wikisłownik 0,8), **nie** są złotą etykietą właścicielki. W Weryfikuj można je zatwierdzić, odrzucić albo poprawić.
* Słowo dostaje kategorię seed tylko, gdy **wszystkie jego główne znaczenia** (≤ 2) wskazują tę samą kategorię; inaczej zostaje bez kategorii.
* Budowniczy taksonomii **nie używa mapy seed dla 2174 słów zbioru oceny** (test w `tests/test_taxo.py`) – trafność jest liczona na słowach, których kategorii seed model nie widział. Wersje z drzewem seed mają w ustawieniach `seed: 1` (to już nie jest grupowanie całkiem bez nadzoru).
* Fakty pokrywające się z zestawem bramki LM (`web/public/data/lm/eval.bin`, wszystkie wiersze; skrót sha256 po normalizacji albo wspólny 8-gram) albo odpowiadające na pytanie z `benchmarks/chat_facts/chat_facts_v1.json` są wykluczone.

## Rozbiór zdań (warstwa rozumienia: części mowy, części zdania, pytania przypadków)

Licencje sprawdzone 25.10.2026 w plikach LICENSE/README repozytoriów źródłowych. W aplikacji: **AI › „Rozumienie zdań”** oraz `licenses.json`.

| Dane | Źródło | Licencja | Zmiany | Skrypt |
|---|---|---|---|---|
| Drzewa zależności, części mowy, cechy (`*-pdb-*.json.gz`) | [UD_Polish-PDB](https://github.com/UniversalDependencies/UD_Polish-PDB) (z Polish Dependency Bank 2.0), Alina Wróblewska i in., IPI PAN, rev `27235e131fae` | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | CoNLL-U → JSON (form, lemma, upos, feats, head, deprel), oficjalne podziały train/dev/test | `scripts/export_rozbior.py` |
| Drzewa zależności, części mowy, cechy (`*-lfg-*.json.gz`) | [UD_Polish-LFG](https://github.com/UniversalDependencies/UD_Polish-LFG), Agnieszka Patejuk, Adam Przepiórkowski, IPI PAN, rev `890f3855c915` | [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) | jak wyżej | `scripts/export_rozbior.py` |
| Schematy walencyjne czasowników → pytania (KTO/CO, KOMU/CZEMU, Z KIM…) (`walenty.json.gz`) | [Walenty](https://zil.ipipan.waw.pl/Walenty), IPI PAN, wersja 2021-07-12 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | schematy → listy pytań przypadków | `scripts/export_walenty.py` |
| Punkt odniesienia (tylko pomiar, model nie jest rozpowszechniany) | [spaCy pl_core_news_sm 3.8.0](https://spacy.io/models/pl) | GPL-3.0 | – | `scripts/rozbior_baseline.py` |
| Lematy i cechy fleksyjne (`morf.json.gz`: leksykon przeglądarki + mapa tagów NKJP → UD) | [Morfeusz 2](http://morfeusz.sgjp.pl/) (`morfeusz2` 1.99.15) z danymi fleksyjnymi SGJP i Polimorf. Program i Polimorf: IPI PAN; dane SGJP: Zygmunt Saloni, Włodzimierz Gruszczyński, Marcin Woliński, Robert Wołosz, Danuta Skowrońska | [BSD 2-klauzulowa](http://morfeusz.sgjp.pl/doc/license/) | formy wygenerowane dla lematów z TRAIN UD (≥ 2 wystąpienia), lemat zapisany jako reguła względem formy; mapa tag → UD liczona tylko na TRAIN | `scripts/export_morf.py` |

* **Wagi modelu rozbioru grzybni** (`rozbior/v*.bin`) są uczone m.in. na UD_Polish-PDB, więc dziedziczą warunki **CC BY-NC-SA 4.0** (bez użytku komercyjnego, na tych samych warunkach). Wariant **bez danych NC** (`rb-lfg`, tylko UD_Polish-LFG train): wagi na **GPL-3.0** (dziedziczone po LFG), wolno używać komercyjnie przy zachowaniu GPL; Walenty (CC BY-SA 4.0) służy tylko do pytań, nie do wag; Morfeusz BSD-2. Wyniki: `results/rozbior/lfg-eval.json`.
* **Uczciwa ocena:** zbiór testowy UD (3 942 zdania, 11 310 ról) nigdy nie trafia do treningu; odcisk sha w `meta.json` (`eval_sha`) i w `myc_eval_sets` ('rozbior'). Publikacja wersji tylko po niezależnym przeliczeniu (inny węzeł z innego IP albo weryfikator CI).

* **Morfeusz 2 / SGJP – nota (wymóg BSD-2):** Copyright © Instytut Podstaw Informatyki PAN (program Morfeusz 2, dane Polimorf); © Zygmunt Saloni, Włodzimierz Gruszczyński, Marcin Woliński, Robert Wołosz, Danuta Skowrońska (dane fleksyjne SGJP). Redystrybucja i używanie są dozwolone pod warunkiem zachowania noty copyrightowej, listy warunków i oświadczenia o wyłączeniu odpowiedzialności (pełny tekst: http://morfeusz.sgjp.pl/doc/license/). OPROGRAMOWANIE I DANE SĄ DOSTARCZONE „TAKIE, JAKIE SĄ”, BEZ JAKICHKOLWIEK GWARANCJI.
