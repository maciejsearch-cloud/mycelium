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

7a. **Liczby, ciągi, liczebniki, analogie** (`web/src/myc/czystaLiczby.ts`, każda reguła trafia do śladu):
   - liczebniki słowami → cyfry (tabela słów albo lemat `num` ze słownika Morfeusza; „dwadzieścia trzy” = 23);
   - arytmetyka: + − × ÷, „plus/minus/razy/podzielić przez”, nawiasy, „P% z N” – bezpieczny parser (shunting-yard, bez eval);
   - zadania tekstowe z ról zdania: stan na osobę (podmiot z rozbioru), „miał/ma/było” = stan, „dostał/kupił”, „od X” =
     przybywa, „dał/oddał/zjadł”, odbiorca w celowniku, „za N zł” = ubywa, „po N” = mnożenie, „k-krotnie”,
     „o N więcej/mniej”. Bezpieczniki: każda liczba z treści musi zostać użyta, nie można oddać czegoś, czego się nie
     miało, wynik nie może być ujemny, dwie liczby na jednym czasowniku przy dwóch czasownikach w zdaniu – inaczej „nie wiem”;
   - ciągi (≥ 4 wyrazy): stała różnica, stały iloraz, stała druga różnica, przeplot miejsc parzystych/nieparzystych;
   - liczebnik + rzeczownik: 1 → l. poj. mianownik; końcówka 2–4 (bez 12–14) → l. mn. mianownik; reszta → l. mn.
     dopełniacz; formę wybiera słownik (tylko formy lematu z nawiasu);
   - analogie A : B = C : ?: (1) odmiana – A i B to ten sam lemat, słownik mówi, która cecha się zmienia (liczba,
     przypadek, stopień), ta sama zmiana dla C; (2) relacja z zatwierdzonego faktu – słowa między A i B w fakcie od ludzi
     („Pszczoła mieszka w ulu.”) i opcja, która z C daje fakt tej samej relacji. Tabela relacji generatora ćwiczeń
     (`selfplay.REL`) **nie** jest wczytywana – to byłoby uczenie pod test.

## Model rozbioru – pochodzenie i licencja

Sieć BiLSTM MYCRB2 (~4 MB), wytrenowana od zera przez węzły grzybni na korpusie UD Polish-PDB (IPI PAN), licencja danych
CC BY-NC-SA 4.0 – wagi traktujemy tak samo (niekomercyjnie, z podaniem źródła, na tych samych warunkach). Wersja trafia na
stronę po sprawdzeniu przez niezależnego weryfikatora. Model zawiera tylko rozbiór, żadnej wiedzy o świecie. Taksonomia
MiniLM pozostaje poza czystą grzybnią. Etykiety „X to y.” z trójek `jest` są w wiedzy, ale przełącznik „Tylko fakty-zdania”
je pomija.

## Czego nie ma

Analogii znaczeniowych (dom, młode, narzędzie, przeciwieństwo) bez zatwierdzonych faktów-zdań; zadań z ułamkami,
przeliczaniem jednostek i wieloma krokami; ciągów krótszych niż 4 wyrazy i innych wzorów; wiedzy o świecie poza zatwierdzoną
przez ludzi; synonimów (poza mały/duży); logiki „lub” między zdaniami; swobodnej rozmowy. Reguły (także liczbowe i listy
czasowników zysku/straty) pisano ze znajomością szablonów ćwiczeń – stąd osobny sprawdzian na pytaniach przeformułowanych.

### Jak nauczyć analogii – „Naucz relacji” (od 1.11.2026)

Karta „Naucz relacji” w zakładce: rodzaj relacji (dom, młode, narzędzie, przeciwieństwo, część, produkt), budowa zdania
(„X mieszka w Y.”, „Młode X to Y.”, „X używa Y.”, „Przeciwieństwem X jest Y.”, „X jest częścią Y.”, „X daje Y.”) i pole na
jedno pełne zdanie. Zdanie jest sprawdzane wzorem i idzie przez `brain.teach('fact')` do Ucz AI → Weryfikuj (zgoda na naukę
obowiązuje). Rozumujący używa go dopiero po konsensusie (≥ 80%). Analogia porównuje **ramę zdania**: pozostałe słowa
(lematy ze słownika, bez kolejności) i możliwe przypadki A i B – „Niedźwiedź mieszka w gawrze.” i „W żeremiu mieszka bóbr.”
mają tę samą ramę. Przykłady w interfejsie są celowo spoza słownictwa ćwiczeń (`selfplay.REL`); `czysta-check` pilnuje,
żeby słowa z tej tabeli nie trafiły do kodu rozumującego.

**Pytania od grzybni** (`supabase/myc_rel.sql`, tabela `myc_rel_questions`, odczyt publiczny, zapis tylko funkcjami):
- **samouk** (`src/iot_mycelium/mesh/relacje.py`, `scripts/relacje_samouk.py`, wywoływane też na początku
  `scripts/samouk_run.py`): z ćwiczeń analogii (nowe ziarno) bierze tylko rodzaj relacji i słowo pytane, np. „Gdzie
  mieszka lis?” – nigdy drugiej strony ani odpowiedzi (test `tests/test_relacje.py`);
- **mówca** (`myc_rel_speaker_tick`, pg_cron co 10 min): (1) z faktu-zdania „X mieszka w Y.” / „X używa Y.” / „X daje Y.”,
  który potwierdził ktoś poza autorem, proponuje „Kto jeszcze mieszka w Y?”; (2) zadaje najstarsze niezadane pytanie
  w czacie globalnym jako „Grzybnia AI”, najwyżej jedno na 30 minut i tylko gdy mówca jest włączony.
- Limity: 30 propozycji na proponującego na dobę, 500 pytań w pokoju. Odpowiedzi nie są zapisywane w tej tabeli
  i nic nie jest zatwierdzane automatycznie – odpowiedź to zwykłe zdanie w Weryfikuj.
- Uczciwie: samouk pyta o słowa z ćwiczeń analogii, więc gdy ludzie odpowiedzą i zatwierdzą, wynik analogii na selfplay
  będzie mierzył wiedzę przekazaną przez ludzi, nie uogólnianie.

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

Potwierdzenie na żywo (1.11.2026 00:41, https://maciejsearch-cloud.github.io/demo/mycelium/, wylogowana przeglądarka,
nauka wyłączona): te same liczby – logika 204/320, fakty 4/40 (0 błędnych); `results/czysta/2026-11-01-0041.json`.
Tabela na stronie czyta `web/public/data/czysta/wyniki.json` z tego pomiaru.

## Pomiar reguł liczbowych (1.11.2026)

Uczciwość: zestaw 38 pytań przeformułowanych (`results/czysta/parafrazy-liczby-v1.json`) zamrożono i wypchnięto **przed**
pierwszą linijką kodu reguł; reguły rozwijano tylko na losowaniu seed 11; seed 2 (pomiar) i seed 7 (sprawdzian) oraz
parafrazy tylko mierzono. Wyjątek, opisany wprost: po pierwszym pomiarze dodano bezpieczniki zadań tekstowych – mogą tylko
zamienić odpowiedź na „nie wiem”, nie podnoszą trafności (wynik bez nich: `results/czysta/po-liczby-bez-bezpiecznikow-2026-11-01.json`).

| zestaw | przed (`przed-liczby-2026-11-01.json`) | po (`2026-11-01-0105.json`, przeglądarka) |
|---|---|---|
| 320 zadań (seed 2) | 204/320 = 63,7% | **267/320 = 83,4%** |
| 320 zadań, nowe losowanie (seed 7) | 207/320 = 64,7% | **273/320 = 85,3%** |
| 38 pytań przeformułowanych | 0/38 | **27/38** (2 błędne, 9 × „nie wiem”) |
| chat_facts_v1 | 4/40 | 4/40 (0 błędnych) |

Per typ (seed 2 → po): zadanie tekstowe 0/28 → 28/28, liczebniki 0/21 → 21/21, ciąg 0/14 → 14/14, analogia 0/31 → 0/31
(w wiedzy nie ma jeszcze zatwierdzonych faktów-relacji; analogie ćwiczeń są znaczeniowe, nie odmiany). Seed 7: zadanie
tekstowe 20/21 (1 × „nie wiem”), liczebniki 24/24, ciąg 22/22, analogia 0/31. Parafrazy: arytmetyka 6/6, liczebniki 7/8,
ciąg 5/8, zadanie tekstowe 5/10, analogia 4/6 (tylko analogie odmiany: liczba, przypadek, stopień). Dwie błędne odpowiedzi
na parafrazach to zadania tekstowe: „…dostała jeszcze pięć od mamy” (liczba bez rzeczownika przypisana do „mamy”) i zdanie
z dwoma czasownikami i odbiorcą „Oli”.

Potwierdzenie na żywo (1.11.2026 01:23 CET, https://maciejsearch-cloud.github.io/demo/mycelium/, wylogowana przeglądarka,
nauka wyłączona): identycznie – seed 2 267/320, seed 7 273/320, parafrazy 27/38, fakty 4/40 (0 błędnych);
`results/czysta/2026-11-01-0123.json`. Tabela na stronie czyta `web/public/data/czysta/wyniki.json` z tego pomiaru.

## Relacje i rozszerzone zadania tekstowe (1.11.2026)

Uczciwość: zestaw v2 (16 przeformułowanych zadań tekstowych, `results/czysta/parafrazy-zadania-v2.json`) zamrożono
i wypchnięto przed kodem; reguły rozwijano tylko na nowym zestawie `results/czysta/dev-zadania-v2.json` (12 zadań,
12/12 po zmianach) i na losowaniu seed 11. v1 pozostał czystym sprawdzianem. Po pierwszym pomiarze dodano trzy
bezpieczniki, które mogą tylko zamienić odpowiedź na „nie wiem” („po” bez liczby, krotność bez stanu, porównanie stopniem
wyższym); pierwszy pomiar: `results/czysta/po-relacje-pierwszy-pomiar-2026-11-01.json`.

Nowe reguły zadań: odcinki zdania (przecinek, „i/a/oraz/ale”) – liczba należy do czasownika swojego odcinka, odcinek bez
czasownika („a od taty 5 jabłek”) dziedziczy poprzedni; „od X” tylko w odcinku liczby; rzeczownik w wyrażeniu przyimkowym
nie jest liczoną rzeczą; czasowniki ruchu z przedrostkiem (od-/u-/wy- ubywa, przy-/do- przybywa); zniknięcie rzeczy
liczonej („piłki pękły”); pierwsza wzmianka = stan początkowy; tożsamość rzeczy i osób wg słownika (rozbiór bywa
niespójny: „kredek”/„kredka”).

| zestaw | przed (`przed-relacje-2026-11-01.json`) | pierwszy pomiar po | po bezpiecznikach (`2026-11-01-0217.json`, przeglądarka) |
|---|---|---|---|
| v2 – 16 zadań tekstowych | 8/16 (5 błędnych) | 14/16 (2 błędne) | **14/16** (0 błędnych, 2 × „nie wiem”) |
| v1 – 38 pytań | 27/38 (2 błędne) | 30/38 (1 błędne) | **30/38** (0 błędnych) |
| 320 zadań seed 2 / seed 7 | 267 / 273 | 267 / 273 | 267 / 273 |

Analogie na selfplay: nadal 0/31 – w wiedzy nie ma jeszcze zatwierdzonych zdań-relacji; zaczną działać po odpowiedziach
ludzi na pytania i konsensusie w Weryfikuj.
