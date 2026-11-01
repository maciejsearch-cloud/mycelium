# Propozycje UX: zakładki, Ucz AI, pytania logiczne, Weryfikuj (25.10.2026)

Analiza `web/src/App.tsx` (main `85a0256`), stron w `web/src/pages/`, `docs/roadmap.md`, `docs/data-provenance.md`,
generatora `src/iot_mycelium/mesh/selfplay.py` i żywej strony (telefon 390×844, zrzuty `ux-audit-*.png`).
Tylko propozycje – bez zmian w kodzie. Uwzględniają prace w toku: czat globalny + rola Developer + Kręgi + wzorce języka,
czat ze źródłami + pamięć wiedzy + każda odpowiedź czatu do Weryfikuj z etykietami, poprawka kategorii w Weryfikuj
(3–6 najlepszych kategorii + własna), destylacja S1 + polska logika S2, okno węzła PC + DirectML.

## Stan obecny (fakty)
- **15 zakładek** w jednym poziomym pasku: Przegląd, Rozmowa, Czat globalny, Ucz AI, Weryfikuj, Zadania, Zostań węzłem,
  Sesja, Wiedza, Taksonomia, Wzrost, Prawdziwe AI, Weryfikacja, Postępy projektu, Konto.
- Na telefonie pasek ma **1812 px szerokości przy ekranie 390 px** (≈ 4,6 ekranu przewijania w bok); Konto jest ostatnie.
- „Weryfikuj” (głosowanie) i „Weryfikacja” (przeliczanie wyników) – prawie ta sama nazwa, inne funkcje.
- Ucz AI: najpierw 4 karty liczb, właściwe zadanie „AI pyta” zaczyna się dopiero pod dolną krawędzią ekranu.
  „AI pyta” to już prosta kolejka niepewności (słowa, intencje, czujnik, fakty), ale bez logiki i bez priorytetu widocznego dla ludzi.
- „Aktywne węzły”: Przegląd pokazuje 4 (24 h, łącznie 17 – węzły z wynikami obliczeń), Zostań węzłem 43 dziś / 112 łącznie
  (każde zdarzenie). Obie liczby są prawdziwe, ale ta sama nazwa przy różnych definicjach myli.
- Zostań węzłem: strona ma ≈ 5300 px wysokości (6 ekranów).
- S2 (24.10, 23:41 CEST): LM v1 rozwiązał 35/160 polskich zadań logicznych (21,9%); sylogizm 4%, negacja 8%,
  sprzeczność 64% – ale w „sprzeczności” odpowiedź zależy od szablonu, więc wynik może być w dużej części zgadywaniem.

## Propozycje (wg priorytetu)

### Nawigacja / zakładki
1. **Dolny pasek z 5 zakładkami + „Więcej”** zamiast 15 w poziomym pasku – na telefonie wszystko ważne jest pod kciukiem i nic nie ucieka w bok.
2. **Połączyć dublujące się strony w podzakładki** (Rozmowa + Czat globalny; Zostań węzłem + Sesja + Węzeł PC; Wiedza + Wzrost + Taksonomia + Prawdziwe AI) – z 15 miejsc robi się 6, a stare adresy `#/…` dalej działają.
3. **Zmienić nazwę „Weryfikacja” na „Dowody”** (przeliczanie wyników, surowe dane) – koniec mylenia z „Weryfikuj”, czyli głosowaniem.
4. **Plakietki z liczbą czekających rzeczy** na Ucz i Weryfikuj (np. „12”) – od razu widać, gdzie jest robota, bez wchodzenia w zakładkę.

### Ucz AI
5. **Na górze „Oczekujące pytania od grzybni”, liczby niżej i zwinięte** – na telefonie pierwsze, co widzisz, to pytanie do odpowiedzi, a nie 4 karty liczb.
6. **Jedna kolejka z priorytetem i linijką „dlaczego pytam”** (np. „model niepewny 52%, 3 węzły się nie zgadzają, kategoria sylogizm ma 4%”) – łączy obecne „AI pyta”, niepewne pytania logiczne, zgłoszenia węzłów testujących i niepewne odpowiedzi czatu.

### Pytania logiczne
7. **Dopisać do generatora brakujące rodzaje**: analogie, ciągi liczb i liter, kolejność w czasie i przyczyna→skutek, łańcuchy 2–3 kroków, „nie wszystkie = niektóre nie”, liczebniki z odmianą (2 koty / 5 kotów), aspekt czasownika („czy skończył?”) – każdy ma odpowiedź liczoną programem.
8. **Uczciwy wynik dla każdego rodzaju**: równo tak / nie / nie wiadomo w każdym rodzaju i wynik „zawsze ta sama odpowiedź” obok trafności – dziś 64% w „sprzeczności” może być w dużej części zgadywaniem.
9. **Poziomy trudności i program nauczania**: więcej kroków, zmyłki, przestawiony szyk, nowe imiona i słowa; grzybnia sama daje więcej zadań z poziomu, na którym ma 30–70%, bo tam najszybciej się uczy.
10. **Pytania sprawdzalne automatycznie idą od razu do ćwiczeń, a ludziom trafiają tylko te, których program nie rozstrzygnie** (czy parafraza zachowała sens, analogie „na wyczucie”, zdrowy rozsądek, czy zdanie brzmi po polsku) – ludzie nie tracą czasu na to, co policzy program, a te automatyczne służą jako pytania kontrolne zaufania.

### Weryfikuj
11. **Jedna skrzynka z filtrami w chipach** (rodzaj: czat / znaczenia / wzorce / kategorie / logika / obrazy / błąd modelu; stan: czeka / sporne / zatwierdzone; pewność AI) i duże przyciski Tak / Nie / Nie wiem / Popraw – jeden widok zamiast wielu kart, ten sam co przy odpowiedziach czatu i poprawce kategorii, które już powstają.

### Inne
12. **Jednoznaczne nazwy liczb i krótsza strona węzła**: „węzły liczące (24 h)” zamiast dwóch różnych „aktywnych węzłów”, a Zostań węzłem w zwijanych sekcjach (przeglądarka / PC / zaproś / ranking) – koniec sprzecznych liczb i 6 ekranów przewijania.

## Proponowana struktura zakładek (telefon: dolny pasek)

| Dolny pasek | Co zawiera (podzakładki u góry) | Stare adresy |
|---|---|---|
| **Start** | Przegląd (KPI, etapy, moc) + skrót „masz N pytań” | `#/overview` |
| **Rozmowa** | Rozmowa z AI · Czat globalny · Kręgi | `#/chat`, `#/czat` |
| **Ucz** | Oczekujące pytania od grzybni · Zadania (obrazki, kolejność…) · Tryb nauczyciela | `#/teach`, `#/tasks` |
| **Weryfikuj** | Skrzynka z filtrami · Moje decyzje · Panel Developera (tylko rola Developer) | `#/weryfikuj` |
| **Węzeł** | Ta przeglądarka (sesja) · Węzeł PC (pobierz, aktualizacje) · Zaproś · Ranking | `#/node`, `#/session` |
| **Więcej** ☰ | Postęp (Wzrost, Wiedza, Taksonomia, Prawdziwe AI) · Dowody (dawna Weryfikacja) · Postępy projektu · Konto · Język | `#/growth`, `#/knowledge`, `#/taxonomy`, `#/ai`, `#/verify`, `#/progress`, `#/konto` |

Konto dodatkowo jako ikona w prawym górnym rogu (obok PL/EN). Na komputerze ta sama struktura w bocznym menu (6 grup zamiast 15 pozycji).

## Szczegóły: pytania logiczne z szablonów

Dziś (`selfplay.py`): warunki, sylogizm, negacja, kwantyfikatory, odmiana, sprzeczność, zadanie tekstowe, porządek.

| Rodzaj | Przykład szablonu | Sprawdzanie |
|---|---|---|
| Analogia | „ptak : gniazdo = pszczoła : ?” z relacji WordNet/Wikidata | automat, gdy relacja z bazy; człowiek, gdy relacja „na wyczucie” |
| Ciąg | „2, 4, 8, 16, ?”, „a, c, e, ?” | automat |
| Kolejność w czasie | „Ala wyszła przed Olą, Ola przed Tomkiem. Kto ostatni?” | automat |
| Przyczyna → skutek | „Spadł deszcz, więc ulica jest mokra. Ulica jest mokra – czy na pewno padało?” (nie wiadomo) | automat dla form logicznych; człowiek dla zdrowego rozsądku |
| Łańcuch 2–3 kroków | warunek + sylogizm + negacja w jednym | automat |
| Kwantyfikator z przeczeniem | „Nie wszystkie X są Y. Czy niektóre X nie są Y?” | automat |
| Liczebniki | „Ile to: dwa … (kot)?” → „koty”; „pięć … (kot)?” → „kotów” | automat (słownik form) |
| Aspekt / czas | „Jan pisał list. Czy skończył go pisać?” (nie wiadomo) | automat |
| Parafraza | model przepisuje zadanie innymi słowami | człowiek: „czy sens jest ten sam?” |

Zasady: równy rozkład odpowiedzi w każdym rodzaju; wynik „zawsze ta sama odpowiedź” obok trafności; ta sama ochrona
przed przeciekiem co dziś (hash + 8-gramy kontra zbiór bramki); do treningu tylko przez bramkę 2000 pytań.

## Szczegóły: „Oczekujące pytania od grzybni” (Ucz AI)

**Źródła kolejki**
1. Pytania, których model jest najmniej pewny: mała różnica prawdopodobieństw między odpowiedziami albo różne wyniki kilku prób / kilku węzłów.
2. Pytania logiczne, których program nie rozstrzygnie (tabela wyżej, kolumna „człowiek”).
3. Rozbieżności zgłoszone przez węzły testujące (S3) i niepewne odpowiedzi czatu (dziś w Weryfikuj typ `chat`, priorytet 0,9).
4. Dotychczasowe „AI pyta” (słowa, intencje, czujnik, fakty, wpisy nauczycieli).

**Priorytet** = niepewność × wpływ (ile podobnych pytań, jak słaby jest dany rodzaj, np. sylogizm 4%) × świeżość;
pytania już mające rozstrzygnięcie spadają. Specjalizacje kręgów (Etap K, plasterek 3) podbijają pytania z ich dziedziny.

**Na telefonie**: jedna karta – pytanie, chip z rodzajem, linijka „dlaczego pytam”, przyciski Tak / Nie / Nie wiadomo /
„Pytanie jest złe” + pole „popraw” i wybór kategorii (ten sam komponent co w poprawce kategorii: 3–6 propozycji + własna).

**Ważenie zaufaniem**: głos waży tyle, ile globalne zaufanie (dziś: trafność na pytaniach kontrolnych, ≥ 85% przy ≥ 30
odpowiedziach = zaufany współtwórca); głos właściciela = wzorzec. Co ~5. pytanie to pytanie sprawdzalne automatycznie
(kontrolne) – zaufanie liczy się z prawdziwych odpowiedzi, bez osobnego wysiłku. Rozstrzygnięcie, gdy suma wag i zgodność
przekroczą próg (np. ≥ 80% zgodności); przy sporze → Weryfikuj (stan „sporne”).

**Dokąd trafia**: zatwierdzone → (a) pamięć wiedzy (czat korzysta od razu), (b) odłamek ćwiczeń S2 (JSONL, ta sama
deduplikacja), (c) błędy modelu → zestaw „nigdy więcej” (osobny, obok bramki). Nigdy do zbioru bramki 2000 pytań.
Każda liczba w tej sekcji z bazy, ze źródłem pod spodem (zasady `docs/data-provenance.md`).

## Kolejność wdrożenia (propozycja)
1. Dolny pasek + podzakładki + zmiana nazwy „Weryfikacja” → „Dowody” (same zmiany UI, stare adresy działają).
2. Ucz AI: kolejka na górze, priorytet i „dlaczego pytam”.
3. Generator: równy rozkład odpowiedzi + wynik „zawsze ta sama odpowiedź”, potem nowe rodzaje i poziomy.
4. Weryfikuj: jedna skrzynka z filtrami (razem z pracą nad odpowiedziami czatu i kategoriami).
5. Porządki w liczbach i strona węzła.
