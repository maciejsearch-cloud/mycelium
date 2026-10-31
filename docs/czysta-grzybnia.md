# Czysta grzybnia – AI bez gotowego modelu

Zakładka **Rozmowa → Czysta grzybnia** (`#/czysta`, `web/src/pages/Czysta.tsx`). Decyzja właścicielki z 1.11.2026:
odpowiada **wyłącznie** to, czego grzybnia nauczyła się sama albo co zatwierdzili ludzie. Bez modelu językowego
(żadnego Qwena ani adaptera LM v4), bez Wikipedii i Wikidata, bez zewnętrznych modeli i osadzeń.

## Audyt składników (co jest, na czym stoi)

| Składnik | Plik | Dane | W czystej grzybni? |
|---|---|---|---|
| Rozumujący z ról zdania | `src/iot_mycelium/rozbior/logika.py` → port 1:1 `web/src/myc/czysta.ts` | reguły w kodzie (pisane ze znajomością szablonów ćwiczeń) | **tak** |
| Model rozbioru (tagger + parser BiLSTM) | `rozbior/model.py`, `web/src/myc/rozbior.ts` | uczony od zera przez węzły na UD Polish-PDB (CC BY-NC-SA 4.0), wersja wybrana i sprawdzona niezależnym weryfikatorem; opublikowana v3 | **tak** – to własne wagi grzybni, ale dane treningowe to zewnętrzny, ręcznie oznaczony korpus |
| Morfeusz 2 / SGJP (BSD-2) i Walenty | `web/src/myc/morf.ts`, `public/data/rozbior/morf.json.gz`, `walenty.json.gz` | słownik form i schematy czasowników | **tak, tylko jako słownik** (wybór lematu i przypadka spośród form znanych słownikowi; nic nie generuje) |
| Fakty zatwierdzone przez ludzi | `myc_frags` (źródło `owner` / `consensus` / `teach`, status `verified`) | relacje `jest`, `prawdziwe`, `odpowiedz`, `znaczenie` | **tak** |
| Fakty i pary z Ucz AI | `myc_user_questions` + konsensus w przeglądarce (`brain.factDocs`) | prawda wg głosów, próg 80% | **tak** |
| Zatwierdzone znaczenia z czatu | `myc_meanings` (status `approved`) | | **tak** (dziś 0) |
| Formy mówcy ocenione przez ludzi | `myc_speaker_forms` | | tylko licznik na stronie (nie odpowiadają na pytania) |
| Strzępki z Wikidata / Wikisłownika / WordNetu | `myc_frags` (inne źródła) | zewnętrzne | **nie** – pomijane i liczone na stronie |
| Fakty startowe (`data/seed/facts.json`) | Wikidata CC0, Wikisłownik | zewnętrzne | **nie** |
| Taksonomia samoorganizująca | `web/src/myc/taxo.ts` | osadzenia MiniLM (gotowy model) | **nie** – zależy od zewnętrznego modelu osadzeń |
| Model obrazów (Fashion-MNIST) | `web/src/myc/vision.ts` | uczony w sieci | nie w tej zakładce (nie odpowiada na tekst) |
| LM v4 / Qwen, Wikipedia, Wikidata | czat „Rozmowa z AI” | gotowe modele i źródła | **nie** |

## Jak rozumuje (potok)

1. **Wejście i normalizacja** – spacje, `"…"` → `„…”`, pytanie od słowa pytającego dostaje `?`; zdania dzielone po `. ? !`
   (poza cudzysłowem); polecenia „Odpowiedz/Podaj/Wybierz…” pomijane.
2. **Rozbiór** – każde zdanie: tokenizacja → model rozbioru grzybni → słownik Morfeusza i Walentego → analiza
   (`rozbior.ts: analyse`): część mowy, cechy, lemat, drzewo, części zdania, pytania przypadków (kto/co, komu/czemu,
   gdzie, kiedy, jak…). Ten sam potok co w czacie (`rozbiorLive.ts: parseSentence`).
3. **Literały** – zdanie składowe = zbiór tematów słów treści (lemat bez końcowej samogłoski, 5 liter) + biegunowość.
   „nie” przy orzeczeniu odwraca biegunowość; „nieprawda, że X” = ¬X; „wiadomo, że X” = X.
4. **Reguły jeśli–to** – zdanie okolicznikowe (spójnik podrzędny rozpoznany przez model) → A, nadrzędne → B.
   Wnioskowanie: modus ponens i modus tollens do 10 przebiegów (łańcuchy). Nic nie wynika → „nie wiadomo”.
5. **Kwantyfikatory / sylogizmy** – wszystkie/każdy, niektóre/któreś/jakieś, żaden, „nie wszystkie”; kwadrat logiczny;
   „Wszystkie X są Y” = X ⊂ Y; jedyna para przeciwieństw: mały/duży.
6. **Role, zgodność, sprzeczność, aspekt, porządek** – „Kto?” = podmiot w mianowniku (szyk przestawiony: zgoda rodzaju
   orzeczenia), „Komu?” = celownik; dwa zdania w „…” sprzeczne, gdy ten sam literał z przeciwną biegunowością albo
   wykluczające się kwantyfikatory; aspekt dokonany = czynność skończona („przerwać” = nie); „wcześniej niż”, liczby.
7. **Wiedza od ludzi** (gdy w pytaniu nie ma przesłanek): para pytanie→odpowiedź o tych samych słowach treści; fakt
   o tych samych słowach dla „Czy…?” (prawda / NIEPRAWDA wg ludzi); reguły i fakty z wiedzy jako przesłanki;
   pytanie otwarte → fakt zawierający wszystkie słowa pytania, odpowiedź = pozostałe słowa faktu.
8. **Odpowiedź** – krótka (tak / nie / nie wiadomo / imię / słowa faktu), źródło, metoda, pewność (średnia pewność
   łuków rozbioru × zgoda ludzi), pełny ślad i rozbiór. Brak dopasowania → „nie wiem, bo …” z listą braków.

## Czego nie ma

Arytmetyki (zadania tekstowe, liczebniki: 0%), analogii i ciągów (0%), wiedzy o świecie poza zatwierdzoną przez ludzi,
synonimów (poza mały/duży), logiki „lub” między zdaniami i przyczyny jako osobnego operatora, swobodnej rozmowy.
Reguły pisano ze znajomością szablonów ćwiczeń – na przeformułowanych pytaniach wynik spada (pomiar
`scripts/logika_eval.py`: 58,9% na parafrazach przy modelu v0).

## Jak się uczy (progi z kodu – `web/src/myc/czystaZasady.ts`, pilnuje `web/scripts/czysta-check.mjs`)

- Fakt / para z Ucz AI liczy się, gdy konsensus Dawida–Skene'a daje ≥ 80% (`FACT_CONF`) i jest ≥ 1 głos.
  Apriori trafności osoby Beta(2, 1), właścicielki Beta(8, 1); pytania kontrolne co 5. odpowiedź, waga ×2.
- Odpowiedź tej zakładki trafia do Weryfikuj (kategoria „czysta grzybnia”, `act = czysta`). Zatwierdzona / odrzucona przy
  ≥ 3 głosach i pewności ≥ 95% / ≤ 5%; głos właścicielki rozstrzyga od razu. Waga głosu osoby: (trafne + 3)/(wszystkie + 4),
  55–90%. Poprawka staje się wiedzą (strzępek `odpowiedz`), gdy suma wag zgodnych poprawek ≥ ln(0,9/0,1).
- Na odpowiedź na własne pytanie się nie głosuje (baza: `own`) – wtedy poprawka idzie do Ucz AI jako para pytanie→odpowiedź.
- „Dodaj fakt albo regułę” = `brain.teach('fact', …)` → Ucz AI → Weryfikuj. Reguła to zwykłe zdanie („Jeśli…, to…”).
- Mówca w czacie globalnym: awans przy ≥ 20 ocenionych wpisach poziomu i ≥ 70% „sensowne”; forma wyuczona przy ≥ 2 osobach
  z tą samą poprawką i ≥ 2/3 zgłoszeń.
- Prywatność: przełącznik nauki (`myc.train`) – wyłączony = nic nie jest zapisywane; e-maile, telefony, linki, imiona
  są wycinane (`answers.ts: scrub`).

## Jak uczyć logicznie

Dobrze: jedno zdanie = jedna myśl; reguły „Jeśli A, to B.” z tymi samymi słowami co fakty; klasy „Wszystkie X są Y.”;
wykluczenia „Żaden X nie …”; pytania otwarte uczy fakt z odpowiedzią („Stolica Polski to Warszawa.”); stałe słownictwo.
Unikać: kilku myśli w zdaniu, pytań jako faktów, zaimków bez nazwy, opinii i żartów, danych osobowych.
Postęp: to samo pytanie po zatwierdzeniu faktu (w śladzie pojawia się „fakt” i źródło), liczniki na stronie, tabela wyników.

## Pomiar (1.11.2026, `scripts/czysta_eval.py`, wynik `results/czysta/2026-11-01-0014.json`)

Model rozbioru v3 (`v3-dc3648e4.bin`, ten sam co na stronie), zbudowana strona w Chromium (Playwright), nauka wyłączona.

- **320 zadań logicznych** (selfplay seed 2, te same co pomiar LM v1): **204/320 = 63,7%**, 106 × „nie wiem”, 10 błędnych.
  Odpowiedzi identyczne z rozumującym w Pythonie na tym samym modelu (0 różnic). Wcześniejsze 65,9% liczono na modelu v0.
  Per typ: sylogizm 30/30, łańcuch 25/25, porządek 25/25, aspekt 24/24, kwantyfikatory 19/19, nie wszystkie 14/14,
  warunki 10/10, sprzeczność 9/9, negacja 8/8, przyczyna 12/15, odmiana 17/29, kolejność w czasie 11/18;
  analogia 0/31, zadanie tekstowe 0/28, liczebniki 0/21, ciąg 0/14.
- **chat_facts_v1 (40 pytań o fakty)**: **4/40 trafne**, 36 × „nie wiem”, 0 błędnych. Grzybnia zna tylko fakty
  zatwierdzone przez ludzi: stolice Australii, Łotwy i Japonii oraz „Co to jest grzybnia?”. Dla porównania czat z modelem
  i Wikipedią: 40/40.
