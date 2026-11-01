# Testy szkolne v1 (klasy 1–7)

Prawdziwe zadania ze szkoły podstawowej, przepisane z **Zintegrowanej Platformy Edukacyjnej** ([zpe.gov.pl](https://zpe.gov.pl), MEN).
Żadne zadanie nie jest wymyślone ani wygenerowane – każde ma w polu `source` adres materiału, numer ćwiczenia i licencję.

* `szkolne_v1.json` – **zamrożony zestaw testowy** (191 zadań, zamrożony 2026-11-01 przed jakąkolwiek zmianą reguł).
  Suma SHA-256 pilnowana w `tests/test_szkolne.py`. Na tym zestawie nie wolno stroić reguł – tylko mierzyć.
* `szkolne_dev_v1.json` – zestaw do rozwijania (101 zadań, inne ćwiczenia z tych samych lub innych materiałów).
* Podział po ćwiczeniach: wszystkie podpunkty jednego ćwiczenia są w tej samej części (test albo dev).
* Pomiar: `scripts/szkolne_eval.py` (czysta grzybnia bez przeglądarki, w przeglądarce, albo czat z LM grzybni w przeglądarce).

## Liczba zadań

| klasa | test | dev |
|---|---|---|
| 1 | 14 | 3 |
| 2 | 13 | 7 |
| 3 | 36 | 10 |
| 1-3 | 0 | 8 |
| 4 | 34 | 24 |
| 5 | 25 | 17 |
| 6 | 18 | 11 |
| 7 | 16 | 10 |
| 4-8 | 35 | 11 |

Kategorie w teście: zadania_tekstowe 38, arytmetyka 37, jednostki 27, ulamki 20, geometria 18, czesci_mowy 18, liczba 11, przypadki 10, rodzaj 10, logika_ciagi 2.

## Skąd klasa

* **Klasy 1–3** – metryczka materiału ZPE („Poziom edukacyjny, klasa: szkoła podstawowa, klasa N”). „1-3” = materiał dla całego etapu.
* **Klasy 4, 5, 6** – e-podręcznik Politechniki Łódzkiej „Odkryj, zrozum, zastosuj…”, osobne książki dla klas IV, V i VI
  (wykaz MEN: [e-podręczniki do kształcenia ogólnego](https://podreczniki.men.gov.pl/e-podr%C4%99czniki-do-kszta%C5%82cenia-og%C3%B3lnego)).
  Przypisanie konkretnej książki ZPE do klasy jest **wywnioskowane** z jej treści (np. „Klasa IVa” w zadaniach klasy 4, walce i stożki w klasie 6).
* **Klasa 7** – ta sama seria, część dla I klasy gimnazjum (7. rok nauki; ZPE pokazuje ją dziś w „Liceum”). To przybliżenie
  obecnej klasy 7, nie podręcznik do klasy 7 nowej podstawy.
* **Polski „4-8”** – materiały ZPE dla szkoły podstawowej IV–VIII bez dokładnej klasy (Contentplus.pl). Brak osobnego polskiego dla klasy 7.
* Arkusze CKE (sprawdzian szóstoklasisty, egzamin ósmoklasisty) **nie są** w zestawie – nie mają otwartej licencji.

## Jak przepisano

* Treść polecenia i zadania słowo w słowo (poprawione tylko błędy wyciągania tekstu z PDF: ligatury „ti/ft”, przesunięte „%”).
* Zadania wyboru: zostaje samo pytanie, bez opcji. Ćwiczenia z listą (np. „Przyporządkuj rzeczowniki…”) dają jedno zadanie
  na element: polecenie + jeden wyraz (`source.verbatim: false` = tak złożone).
* Złote odpowiedzi wpisane ręcznie i sprawdzone obliczeniem; `gold` = lista alternatyw, każda to lista elementów, które
  wszystkie muszą być w odpowiedzi.
* `source.pdf_line` – wiersz w tekście PDF z `https://zpe.gov.pl/pdf/<id>` (pdftotext), żeby łatwo znaleźć zadanie.

## Licencja

Zadania pochodzą z materiałów na licencjach CC BY-SA 3.0 (Eduexpert Sp. z o.o., klasy 1–3) i CC BY 3.0
(Zespół autorski Politechniki Łódzkiej; Contentplus.pl sp. z o.o.), udostępnionych na zpe.gov.pl. Ten zestaw jako całość
udostępniamy na **CC BY-SA 3.0** z uznaniem autorstwa jak niżej. Ćwiczenia tekstowe z e-podręcznika PŁ nie mają osobnej
stopki – zasoby tej książki są oznaczone CC BY 3.0; nie użyto żadnego zasobu oznaczonego CC BY NC.

## Źródła

| id ZPE | tytuł | klasa (metryczka / podstawa) | autor | licencja | test | dev |
|---|---|---|---|---|---|---|
| [PFPVqqWkC](https://zpe.gov.pl/pdf/PFPVqqWkC) | Zabawy na śniegu | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 3 | 0 |
| [P10rJTW6D](https://zpe.gov.pl/pdf/P10rJTW6D) | Kolorowa jesień | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 2 | 0 |
| [PVVBR6NWh](https://zpe.gov.pl/pdf/PVVBR6NWh) | Palma wielkanocna | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 9 | 0 |
| [P77zRy79k](https://zpe.gov.pl/pdf/P77zRy79k) | Matematyczne łamigłówki | szkoła podstawowa, klasa 2 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 2 | 0 |
| [P10q68cup](https://zpe.gov.pl/pdf/P10q68cup) | Tabliczka mnożenia na wesoło | szkoła podstawowa, klasa 2 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 9 | 6 |
| [PmDN4FyDD](https://zpe.gov.pl/pdf/PmDN4FyDD) | Budujemy dom – figury geometryczne | szkoła podstawowa, klasa 2 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 2 | 0 |
| [P174sFoPG](https://zpe.gov.pl/pdf/P174sFoPG) | Matematyczne wyzwania | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 8 | 4 |
| [PG6eZXwfo](https://zpe.gov.pl/pdf/PG6eZXwfo) | Kolejność działań matematycznych | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 4 | 4 |
| [PnIeL5v9B](https://zpe.gov.pl/pdf/PnIeL5v9B) | Mierzymy obwody figur geometrycznych | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 1 | 1 |
| [PW0SlLytM](https://zpe.gov.pl/pdf/PW0SlLytM) | Jednostki czasu | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 5 | 0 |
| [P13Wi6WG2](https://zpe.gov.pl/pdf/P13Wi6WG2) | Jednostki wagi | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 1 | 0 |
| [POrwi6vr](https://zpe.gov.pl/pdf/POrwi6vr) | Jednostki pojemności | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 2 | 0 |
| [P5rLLIBK4](https://zpe.gov.pl/pdf/P5rLLIBK4) | Więcej, mniej, tyle samo | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 1 | 0 |
| [PVhQ7bdUA](https://zpe.gov.pl/pdf/PVhQ7bdUA) | Rozpoznaję części mowy | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 14 | 0 |
| [PEc4RsM3J](https://zpe.gov.pl/b/odkryj-zrozum-zastosuj/PEc4RsM3J) | Odkryj, zrozum, zastosuj… (e-podręcznik PŁ, klasa IV) | klasa 4 (wg tytułu e-podręcznika) | Zespół autorski Politechniki Łódzkiej | CC BY 3.0 | 34 | 24 |
| [P4KexLAYo](https://zpe.gov.pl/b/odkryj-zrozum-zastosuj/P4KexLAYo) | Odkryj, zrozum, zastosuj… (e-podręcznik PŁ, klasa V) | klasa 5 (wg tytułu e-podręcznika) | Zespół autorski Politechniki Łódzkiej | CC BY 3.0 | 25 | 17 |
| [P80Mb74Qq](https://zpe.gov.pl/b/odkryj-zrozum-zastosuj/P80Mb74Qq) | Odkryj, zrozum, zastosuj… (e-podręcznik PŁ, klasa VI) | klasa 6 (wg tytułu e-podręcznika) | Zespół autorski Politechniki Łódzkiej | CC BY 3.0 | 18 | 11 |
| [PMMNZskur](https://zpe.gov.pl/b/odkryj-zrozum-zastosuj/PMMNZskur) | Odkryj, zrozum, zastosuj… (e-podręcznik PŁ, klasa I gimnazjum = 7. rok nauki) | klasa 7 (wg tytułu e-podręcznika) | Zespół autorski Politechniki Łódzkiej | CC BY 3.0 | 16 | 10 |
| [P1CapaYal](https://zpe.gov.pl/pdf/P1CapaYal) | Bez czasownika ani rusz | Szkoła podstawowa IV–VIII (bez klasy) | Contentplus.pl sp. z o.o. | CC BY 3.0 | 10 | 0 |
| [P11XfRiFg](https://zpe.gov.pl/pdf/P11XfRiFg) | Bez owijania rzeczownika w bawełnę | Szkoła podstawowa IV–VIII (bez klasy) | Contentplus.pl sp. z o.o. | CC BY 3.0 | 10 | 0 |
| [P1C3PVn1x](https://zpe.gov.pl/pdf/P1C3PVn1x) | Płeć a rodzaj gramatyczny wyrazów | Szkoła podstawowa IV–VIII (bez klasy) | Contentplus.pl sp. z o.o. | CC BY 3.0 | 15 | 8 |
| [Pvopzw5cl](https://zpe.gov.pl/pdf/Pvopzw5cl) | Rozśpiewana I klasa | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 1 |
| [PkcRyVagS](https://zpe.gov.pl/pdf/PkcRyVagS) | Popularne drzewa w Polsce | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 1 |
| [P3cbQvjSK](https://zpe.gov.pl/pdf/P3cbQvjSK) | Pieczemy świąteczne pierniki | szkoła podstawowa, klasa 1 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 1 |
| [PKylwaI7t](https://zpe.gov.pl/pdf/PKylwaI7t) | Sól i rośliny | szkoła podstawowa, klasa 2 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 1 |
| [PBKGKBo88](https://zpe.gov.pl/pdf/PBKGKBo88) | Jednostki długości | szkoła podstawowa, klasa 3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 1 |
| [P1GyZczYZ](https://zpe.gov.pl/pdf/P1GyZczYZ) | Części mowy | szkoła podstawowa, klasa 1‐3 | Eduexpert Sp. z o.o. | CC BY-SA 3.0 | 0 | 8 |
| [P6VZVKStu](https://zpe.gov.pl/pdf/P6VZVKStu) | Przymiotnik – blisko rzeczownika | Szkoła podstawowa IV–VIII (bez klasy) | Contentplus.pl sp. z o.o. | CC BY 3.0 | 0 | 3 |

## Pomiary

Wyniki pomiarów są w `results/szkolne/` (jeden plik na pomiar, z odpowiedzią i werdyktem dla każdego zadania).
`python3 scripts/szkolne_publish.py` przenosi je do `web/public/data/szkolne/wyniki.json`, a widok „Testy szkolne”
w zakładce Czysta grzybnia pokazuje wyniki według klas i kategorii oraz zadania z przyciskiem „Rozwiąż tutaj” (tok rozumowania).
