# Zadania wielokierunkowe – podział na typy w Ucz AI

Ucz AI → „Oczekujące pytania od grzybni” ma rząd chipów: **Mieszane, Logiczne, Matematyczne, Wzrokowe, Analityczne,
Językowe, Inne**. Liczba przy chipie to prawdziwa liczba czekających pytań tego typu dla tego węzła (te same listy co
kolejka, `brain.pendingByType()`). Wybór zapamiętuje przeglądarka (`localStorage.myc_teach_type`).
Pusta kolejka typu = uczciwy komunikat „Brak czekających zadań typu …”, bez zapełniania czymkolwiek innym.

| Typ | Skąd zadania | Identyfikatory | Kto zna odpowiedź |
|---|---|---|---|
| Logiczne | `scripts/selfplay_run.py` (generator v2, 16 kategorii) | `l` + 8 hex | ludzie (pytania „dla ludzi”) albo program (kontrolne, `myc_gold`) |
| Matematyczne | `scripts/zadania_run.py` → `iot_mycelium.mesh.zadania` (arytmetyka, ułamki, procenty, równania, zadania tekstowe; poziomy 1–3) | `m` + 8 hex | program (`myc_gold`) |
| Analityczne | jw., tabele z prawdziwych faktów Wikidata (CC0) z `web/public/data/seed/facts.json` – liczba atomowa, data urodzenia, kontynent; odpowiedź wynika tylko z tabeli | `a` + 8 hex | program (`myc_gold`) |
| Wzrokowe | (1) obrazy z testu Fashion-MNIST, których nie ma w żadnym publicznym pliku z etykietami (odłamki `data/ml/fashion` val/test, `captcha.json`) – etykieta tylko w `myc_gold`; (2) obrazy z puli `captcha.json`, przy których model obrazów w przeglądarce jest najmniej pewny: „Czy to jest {klasa}?” | `v` + 8 hex; `cg#####k#` | (1) program; (2) ludzie |
| Językowe | kategorie słów (lexicon) + linki do rozbioru zdania i znaczeń w Weryfikuj | `w…` | ludzie |
| Inne | intencje (CLINC150), czujniki (NAB), fakty, pytania nauczycieli | `i…`, `s…`, `k…`, `u…` | ludzie |

## Pytania kontrolne

* W trybie mieszanym i w typach z pytaniami „dla ludzi” (logiczne, wzrokowe…) co ok. 5. pytanie (`CONTROL_EVERY`)
  jest kontrolne; typy kontrolne idą na przemian (logiczne, matematyczne, analityczne, wzrokowe).
* Matematyczne i analityczne są w całości sprawdzalne programem – cała kolejka tych typów to zadania kontrolne
  (od poziomu 1), więc każda odpowiedź liczy się do zaufania węzła.
* Poprawne odpowiedzi są tylko w `myc_gold` (ładowane przez `scripts/gold_rotate.py` z lokalnego `.gold/`, pule losowane z tajnego `MYC_GOLD_SEED`; plików gold nie ma w repo), nigdy w plikach
  wysyłanych do przeglądarki. `queue.json` ma tylko pytania, odpowiedzi do wyboru i wyniki modelu.

## Trafność według typu (karta pod kolejką)

* **Model** – zawsze z liczbą prób n i strategią „zawsze ta sama odpowiedź”:
  logiczne = `per_category` z `data/logic/queue.json` (LM, generator v2); matematyczne i analityczne = LM grzybni,
  wybór 1 z 4 (rozkład log-prob na odpowiedziach, `scripts/zadania_run.py`); wzrokowe = regresja softmax 196→10 na 200
  obrazach startowych (ten sam model co „tylko start” w przeglądarce); językowe = rozbiór zdania, role-F1 na teście UD
  (`data/rozbior/wyniki.json`); inne = trafność intencji na teście CLINC150 policzona w tej przeglądarce.
  Brak pomiaru = „brak pomiaru”.
* **Ludzie** – odpowiedzi wszystkich węzłów na pytaniach kontrolnych, `myc_gold_by_type` (klucz = pierwsza litera
  identyfikatora; `c?` dla zadań captcha). Brak odpowiedzi = „brak odpowiedzi”.

## Dokąd trafiają odpowiedzi (dane treningowe per typ)

* **Logiczne** – pytania dla ludzi → konsensus (Dawid-Skene ważony zaufaniem) → sporne do Weryfikuj, zatwierdzone do
  pamięci wiedzy; kontrolne → zaufanie węzła; zadania z wynikiem programu → odłamek SFT logiki (`sft-logic-*`), tylko
  przez bramkę 2000 pytań.
* **Matematyczne, analityczne** – odpowiedzi ludzi → zaufanie węzła (`myc_gold_stats`) i trudność zadań dla ludzi
  (porównanie z modelem). Same zadania z odpowiedzią programu są zapisywane w `results/zadania/<data>-sft.jsonl`
  (z polem `model_ok`) jako kandydat na odłamek SFT – do treningu LM wejdą osobnym krokiem i tylko przez bramkę.
  Odpowiedź „pytanie jest złe” oznacza zadanie do sprawdzenia.
* **Wzrokowe** – „Czy to jest …?” → etykiety obrazów z konsensusu (`labelledVision`) → model obrazów w przeglądarce
  („Ucz teraz” w Zadaniach) i sesje FedAvg; obrazy kontrolne (`v…`) → zaufanie węzła.
* **Językowe** – kategorie słów → model słów (`WordAgent`); rozbiór i znaczenia (Weryfikuj) → trening rozbioru i pamięć
  znaczeń.
* **Inne** – intencje i czujniki → modele w przeglądarce („Ucz teraz”); fakty → pamięć wiedzy.

## Bramka LM

Zadania nie pokrywają się ze zbiorem bramki 2000 pytań: `scripts/zadania_run.py` odrzuca pytania o tym samym
`sha256(norm(tekst))` co dowolny wiersz `web/public/data/lm/eval.bin` albo dzielące z nim 8-gram słów (jak
`selfplay_run.py`). Zbiór bramki nie jest zmieniany.

## Odświeżanie

```
MYC_CACHE=… PYTHONPATH=src python scripts/zadania_run.py --per-kind 24 --images 100
# potem w bazie: supabase/myc_zadania.sql (raz), potem MYC_GOLD_SEED=… python scripts/gold_rotate.py --plan / --apply
```
