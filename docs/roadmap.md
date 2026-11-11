# Mapa rozwoju Mycelium AI (od 24.10.2026)

Kolejność wynika z audytu wkładu węzłów (`docs/contribution-audit.md`): najpierw przestajemy marnować moc,
potem kierujemy ją tam, gdzie daje mierzalny postęp. Każdy etap kończy się liczbą na stałym teście, nie deklaracją.

## Etap A (nadrzędny) – grzybnia warstwowa: każde pytanie przechodzi przez węzły rozumienia, rozumowania i odpowiedzi
Wizja właściciela (24.10): odpowiedź ma być prawdziwa i oparta na źródłach, a nie „ładnie brzmiąca”. Bez cenzury –
słowa wulgarne/potoczne dostają tylko etykietę rejestru; o treści odpowiedzi decyduje to, co mówią źródła.
Każda warstwa to rola, którą może wziąć dowolny węzeł (przeglądarka, box, PC); wynik warstwy ma typ, autora (węzeł) i źródła.

| Warstwa | Wejście → wyjście | Co liczy (dziś dostępne) | Gdzie |
|---|---|---|---|
| 1. Rozumienie | pytanie → `Understanding {lang, intent, reaction, entities[], words{słowo: znaczenie, rejestr, źródło}}` | model intencji (v43, 92,8%), wykrywanie reakcji, encje z Wikidata, `register.json` (Wikisłownik), zatwierdzone znaczenia z czatu | przeglądarka (lekkie) |
| 2. Rozumowanie | Understanding → `Evidence[] {tekst, źródło, wynik}` | wyszukiwanie w strzępkach (+ embeddingi), fakty Wikidata, kalkulator, wnioskowanie 1–2 kroki po relacjach strzępków, sprawdzanie sprzeczności (dwa źródła mówią co innego → oba odrzucone, pytanie do Weryfikuj) | przeglądarka / box |
| 3. Odpowiedź | Understanding + Evidence → `Answer {tekst, zdania[] → źródła}` | generowanie: LM grzybni (Qwen2.5-0.5B + LoRA) warunkowany dowodami; weryfikacja: każde zdanie musi mieć pokrycie w dowodach, inaczej jest usuwane albo oznaczone „bez źródła”; brak dowodów → „nie wiem” + prośba o wyjaśnienie | box / PC (GPU) |

**Rozproszenie modelu.** Gdy LM urośnie (0,5B → 1,5B/3B), warstwa 3 dzieli model na k odłamków warstw (pipeline parallel,
jak istniejąca siatka 12 odłamków): żądanie przechodzi odłamek i → i+1 przez Realtime, wiele pytań naraz w mikro-partiach,
by wszystkie węzły pracowały. Przydział odłamków według zmierzonej przepustowości, każdy odłamek na ≥ 2 węzłach
(zapas i wyrywkowe przeliczenie stanów ukrytych przez zaufany węzeł – nieuczciwy węzeł traci zaufanie).

**Miary (stały zbiór testowy, sha256).** 300 pytań z odpowiedziami i źródłami (Wikidata/Wikisłownik/strzępki) + 100 bez
źródła: odsetek odpowiedzi popartych źródłem, trafność, odsetek trafnych „nie wiem”, odsetek zmyśleń (zdanie bez pokrycia).

**Plasterki.**
1. W przeglądarce: `pipeline.ts` z trzema typowanymi warstwami (obecne rozumienie/strzępki/odpowiedź), panel „Ścieżka”
   w czacie (co zrozumiała każda warstwa, jakie dowody, które zdanie z jakiego źródła), weryfikacja zdań odpowiedzi.
2. Warstwy 1–2 jako zadania dla węzłów (role `understand`/`reason` w siatce), ślad węzłów w odpowiedzi.
3. Warstwa 3 na boxach/PC z GPU, odłamki LM w potoku, ocena na stałym zbiorze przed każdą zmianą.

### A1. Rozbiór zdań – pierwsza warstwa rozumienia (prośba 25.10, t115s539 + t116u) – pierwszy plasterek zrobiony
Każde zdanie → części mowy z cechami (przypadek, liczba, rodzaj, osoba, czas, aspekt, tryb, stopień), części zdania
(podmiot, orzeczenie czasownikowe/imienne, dopełnienie, przydawka → do którego rzeczownika, okolicznik miejsca/czasu/
sposobu/przyczyny/celu), zdania składowe (współrzędne/podrzędne + spójnik) i ramy ról: KTO/CO – ORZECZENIE (aspekt, czas)
– KOGO/CO – KOMU/CZEMU – Z KIM/CZYM – O KIM/GDZIE – JAK/KIEDY/DLACZEGO – przeczenie.
- Dane: UD Polish-PDB (CC BY-NC-SA 4.0) + UD Polish-LFG (GPL-3.0), oficjalne podziały (train 31 496 zdań, dev 3 960,
  test 3 942 – test nigdy do treningu), Walenty 2021-07-12 (CC BY-SA 4.0, 17 902 czasowniki). Licencje: licenses.json
  i karta „Rozumienie zdań” w zakładce AI. Wagi uczone na PDB dziedziczą NC-SA.
- Reguły UD → części zdania: `src/iot_mycelium/rozbior/analiza.py` = `web/src/myc/rozbior.ts` (test zgodności TS↔Python
  na 400 zdaniach w CI; zmiana reguł zmienia odcisk bramki).
- Model grzybni: BiLSTM + biaffine (MYCRB2, int8, 4,0 MB), numpy na węzłach i u weryfikatora, TS w przeglądarce
  (przejście w przód TS = numpy na 300 zdaniach). Zadanie węzła „rozumienie” (`mesh/rbwork.py`): FedAvg rund od
  opublikowanej wersji, nowa bramka role-F1 (`supabase/myc_rozbior.sql`) – publikacja tylko po niezależnym przeliczeniu
  (inny węzeł z innego IP albo weryfikator CI); bramka LM 2000 pytań bez zmian.
- Wynik na teście UD (3 942 zdania, 11 310 ról): punkt odniesienia spaCy pl_core_news_sm + reguły role-F1 74,4%
  (UPOS 95,4%, cechy 82,5%, LAS 76,4%); v0 grzybni role-F1 75,7% (UPOS 97,1%, cechy 77,6%, LAS 78,6%;
  PDB 74,2%, LFG 78,9%).
- Czat: zwijana tabela „Jak zrozumiałem zdanie” (kolor części mowy) + trasa (osobiste / fakt; pytane miejsce → właściwość
  Wikidata). Weryfikuj: „Rozbiór zdania” (dobrze / źle / popraw część zdania słowa; wagi zaufania, właściciel = złota).
  Start: kafelek role-F1 z wersji opublikowanej. Ćwiczenia S2: `selfplay_run.py --rozbior N` (pytania z ram train,
  bez pokrycia z bramką 2000 pytań).
- Dalej: Morfeusz2/SGJP (lematy, cechy dla słów spoza UD), trening na zatwierdzonych rozbiorach z Weryfikuj
  (`myc_parse_train`), tokenizacja surowego tekstu oceniona osobno, pytania typu „Kto ma teraz książkę?” w czacie,
  model bez danych NC (tylko LFG + własne poprawki) jako wariant do zastosowań komercyjnych.

## Etap 0 – zrobione 24.10
- Zbiór testowy modelu językowego: 250 → 2000 pytań (wersja 2, sha 9bebb6f4…), ścisła bramka, nowy punkt odniesienia
  liczony przez niezależnego weryfikatora (8 równoległych odłamków w CI).
- Naprawa: rezerwacja publikacji LM wygasała w trakcie oceny (`no reservation`) – kandydaci v2 nigdy nie trafiali do bramki.
- Panel „Wkład węzłów” w Weryfikacji (prawdziwe agregaty `myc_results`).

## Etap 1 – koniec marnowania mocy (najwyższy priorytet)
1. **Plateau → mniej rund**: gdy model ma ≥ 20 kolejnych odrzuconych rund (fashion, har, intent, words od 19.10),
   koordynator ogranicza jego zadania do 1 rundy/godz. i kieruje moc przeglądarek do zadań z otwartym postępem
   (LM, orientacja obrazów, OCR, taksonomia). Cel: odrzucone < 50% aktualizacji dziennie (dziś 99%).
2. **Bez powtórnych ocen** tej samej wersji (intent v43: 463 oceny) – wynik oceny wersji zapamiętany per węzeł.
3. **Telemetria urządzeń**: węzeł zapisuje rodzaj (PC/telefon/Python), rdzenie, GPU i backend (bez danych osobowych),
   by dało się uczciwie rozdzielić wkład PC i telefonu.
4. **Stały węzeł PC widoczny**: bicie serca co 10 min, licznik zadań i przyczyna bezczynności na stronie stanu
   i w panelu „Wkład węzłów”. Dziś stały węzeł z MyceliumNode.exe nie ma w bazie ani jednego zadania.

## Etap 2 – czat uczy się od ludzi (prośba właściciela 24.10; w toku: PR #53)
- Rozpoznawanie intencji krótkich reakcji (obelga, frustracja, niezgoda) zamiast zmyślania definicji.
- Nieznane słowo/fraza → czat mówi, że nie zna znaczenia, i prosi o wyjaśnienie → oczekujące znaczenie
  (słowo, znaczenie, rejestr: wulgarne/potoczne, przykład, autor) → głosowanie w Weryfikuj (wagi zaufania,
  głos właściciela = wzorzec) → dopiero po zatwierdzeniu strzępek, dane LM i odpowiedzi czatu.
- Mały słownik rejestru (Wikisłownik: kwalifikatory „wulg.”, „pot.”, CC BY-SA).

## Etap 3 – moc obliczeniowa tam, gdzie jest postęp
- Orientacja obrazów (samonadzór 0/90/180/270°) trenowana na węzłach – nowe, nienasycone zadanie dla przeglądarek/GPU.
- OCR zniekształconego tekstu z własnego generatora (otwarte słowa), stały test + sha256 + CER.
- Lepsze rozpoznawanie obrazów; niepewne przypadki → Weryfikuj.
- WebGPU: robotnicy dopasowani do `hardwareConcurrency`, suwak udziału, rzeczywiste wykorzystanie na urządzenie.
- Węzeł PC: GPU (CUDA, ewentualnie DirectML) + nowe binaria.

## Etap 4 – dane i zadania typu captcha
- Puzzle (suwak/brakujący element) i „zaznacz kwadraty z X” (3×3/4×4) w Ucz AI; odpowiedzi = etykiety z wagą zaufania.
- Więcej otwartych obrazów (Wikimedia Commons z atrybucją per obraz, Open Images V7, COCO, CIFAR) + strona atrybucji
  i liczniki w czasie. Bez pobierania z Google Images.
- Nowe typy w Weryfikuj: obrót/etykieta obrazu, tekst OCR, edycja kategorii.

## Etap S – samorozwój w granicach bramki (prośba właściciela 24.10)
Z „protokołu samoewolucji” bierzemy to, co da się zmierzyć. Twarde granice (nie do zmiany przez AI):
1. **Brak samoprzepisywania kodu** i brak uruchamiania wygenerowanego kodu na węzłach ochotników. Kod napisany przez model
   działa tylko w odizolowanej piaskownicy na boxie (bez sieci, limit CPU/RAM/czasu), a jego wynik to wyłącznie dane.
2. **Bramka bez regresji jest stała**: zbiór 2000 pytań (wersja 2, sha 9bebb6f4…), punkt odniesienia v1 = 712/2000 (35,6%),
   niezależny weryfikator f32. Każda zmiana (dane, strata, przydział mocy) wchodzi do modelu wyłącznie przez tę bramkę.
3. **Moc tylko w granicach udostępnionych** przez użytkownika (suwak/`--threads`/`--max-ram-gb`).
4. **Dane autentyczne**: żadnych liczb symulowanych; brak wyniku = uczciwy pusty stan.

### S1. Destylacja na poziomie logitów (w toku)
- Nauczyciel: `Qwen/Qwen2.5-1.5B-Instruct` (Apache-2.0, rewizja przypięta w `kd.json`), ten sam tokenizer co uczeń.
  3B ma licencję Qwen Research (niekomercyjną) – odpada; 7B (Apache-2.0) później na węźle PC z GPU.
- `scripts/export_kd_shards.py` (na boxie): top-32 surowych logitów fp16 dla każdej liczonej pozycji odłamka, format danych
  `MYCKD1` (bez pickle), gzip, sumy SHA-256 i perpleksja nauczyciela na odłamku w `kd.json`; pliki w wydaniu `lm-kd-1`
  repozytorium demo. Odłamek walidacyjny i zbiór testowy nigdy nie są destylowane.
- Węzeł: zadanie `train` z `params.kd` pobiera plik (suma z zadania, zgodność z odłamkiem sprawdzana), strata
  `(1 − α)·CE + α·T²·KL(nauczyciel_T ‖ uczeń_T)` na top-k, T = 2, α = 0,5. FedAvg bez zmian; walidacja agregatora i bramka
  liczą czystą perpleksję/trafność. Kandydat ma `meta.algo = fedavg-lora-kd` i `meta.teacher`.

### S2. Samodzielne ćwiczenia ze sprawdzalną odpowiedzią (projekt + pierwszy plasterek)
- Generator zadań sprawdzalnych automatycznie: arytmetyka (wynik liczony programem), luki w faktach z Wikipedii
  (zdanie z hasła z odłamków treningowych, ukryte słowo = odpowiedź), prosta logika (sylogizmy/porządki z jawnym rozwiązaniem).
- Model odpowiada (kilka prób); do odłamka treningowego trafiają tylko próbki, których odpowiedź sprawdzarka uznała
  za poprawną (odrzucenie: znane wyniki „źle”/„nie wiem”, liczone i pokazywane).
- Brak przecieku: każda próbka ma sha256 znormalizowanego tekstu; odrzucane są te, których tytuł hasła należy do
  podziału testowego (`sha1(tytuł) % 1000 < 10`) lub których hash/n-gram 8 pokrywa się ze zbiorem 2000 pytań.

### S3. Węzły testujące (red team)
- Nowy typ zadania `redteam`: węzeł bierze pytania z dowodami (strzępki/Wikidata), zadaje je bieżącemu modelowi w wariantach
  (parafraza, fałszywa przesłanka, liczby zamienione), porównuje odpowiedź z dowodem i zgłasza rozbieżności
  (pytanie, odpowiedź modelu, dowód, źródło).
- Zgłoszenia → Weryfikuj (nowy typ pozycji „błąd modelu”); po zatwierdzeniu → odłożony zbiór `redteam-held-out`
  (osobny sha, raportowany obok bramki), **nigdy** do zbioru bramki ani do treningu bez osobnego podziału.

### S4. Wybór ścieżek (przydział mocy)
- Aktywny dopiero, gdy wszystkie etapy tej mapy mają status „zrobione” (flaga w `myc_stages`, ustawiana ręcznie po
  zweryfikowanych liczbach) – wcześniej przydział jest stały.
- Waga typu zadania = zmierzony zysk / koszt: Δ zweryfikowanej metryki (z `myc_candidates` przyjętych przez bramkę,
  ostatnie 7 dni) na 1 PFLOP z `myc_results.flops`; minimum 5% dla każdego typu (eksploracja), brak danych = waga równa.
- Koordynator losuje typ rundy według wag; panel „Przydział mocy” pokazuje wagi, dane źródłowe i datę wyliczenia.
- Zmienia się tylko kolejność pracy w ramach mocy udostępnionej przez użytkowników; bramka i zbiór testowy poza zasięgiem.

### S5. Samoaktualizacja węzła PC (prośba 24.10, t90u)
- Węzeł co 6 h czyta `node/binaries.json`; pobiera tylko wydania z `maciejsearch-cloud/demo` podpisane cosign/Sigstore
  (tożsamość workflow wydania), sprawdza SHA-256 + podpis, podmienia plik atomowo (zapis obok, `rename`), stara wersja zostaje;
  gdy nowa nie wystartuje (brak „gotowy” w 120 s) → powrót do starej i blokada tej wersji.
- Nowe wersje modeli przyjmowane tylko, gdy przeszły bramkę na **każdym** etapie (LM: 2000 pytań bez regresji; każda
  metryka etapu nie gorsza, co najmniej jedna lepsza) – nie próg 100%.
- Wyłączenie: `--no-self-update` (zapisywane w `node-config.json`) albo `MYC_NO_SELF_UPDATE=1`.
- Zrobione: `mesh/selfupdate.py` + nadzorca w `service.py`; biblioteka `sigstore` wbudowana w binaria (test wydania
  `--selfupdate-selftest`). Starsze binaria (bez tej funkcji) trzeba raz pobrać ręcznie.

### S6. Panel węzła PC (prośba 24.10, t91u) – zrobione w tej wersji
- Okno w stylu Windows Vista/Aero (`src/iot_mycelium/mesh/dashboard.py`, `ui_page.py`): przeglądarka w trybie aplikacji
  (Edge/Chrome, osobny profil) na `127.0.0.1`, losowy klucz `ui-token` (0600) w części `#` adresu, nagłówek `X-Myc-Token`,
  sprawdzanie `Host`/`Origin`; bez dodatkowych bibliotek (mały plik wykonywalny). `--headless` dla serwerów, `--ui` otwiera panel.
- Zakładki: Przegląd (stan, wykresy CPU/RAM/GPU z pomiaru co 2 s, miernik), Moc i przydział (wątki – od razu, czas pracy %,
  RAM – po restarcie, GPU, udział rodzajów zadań → harmonogram `sched.py`), Statystyki (licznik procesu, czas wg rodzaju,
  wkład z bazy 14 dni, punkty konta), Historia (plik `history-<nazwa>.jsonl`, filtr), Konto (anonimowe, kod odzyskiwania;
  sesja w keyring albo `account.json` 0600, nigdy w panelu ani dzienniku), Konsola.
- GPU: wykrywanie i użycie przez `nvidia-smi`; **obliczenia na GPU jeszcze nie** (pliki wykonywalne mają PyTorch CPU;
  CUDA wymaga osobnego wydania ~2 GB i przeniesienia `qwen.py`/`lm.py` na urządzenie – następny krok; DirectML: torch-directml
  nie wspiera wszystkich operacji treningu, do sprawdzenia). GPU do nauki można dziś oddać przez stronę (WebGPU).

### S7. Tryb pasywny (prośba 24.10, t94u) – pierwszy etap zrobiony
- Osobny przełącznik w panelu, domyślnie wyłączony; opcja „nie oddawaj mocy” (cap 0: bez czatu i treningu).
  Limity: dysk (GB), pobieranie na dobę (GB); liczniki pokazane w panelu (`passive-usage.json`).
- Zrobione: (1) sprawdzona pamięć danych – odłamki LM i pliki destylacji z manifestów projektu, każdy plik SHA-256,
  dostępność ogłaszana w obecności (`state.cache`); **bez udostępniania innym** (brak otwartych portów);
  (2) świadek – spójność wyników treningu innych węzłów (adapter, wartości skończone, FLOP = tokeny × 6·494e6,
  próbki = tokeny, prędkość możliwa) i wydań (binaries.json ↔ SHA256SUMS.txt ↔ .pyz) → `myc_witness_report`
  (`supabase/myc_witness.sql`, jeden głos na węzeł i przedmiot, limit zapytań, tylko flagi logiczne). Pomocnicze –
  nie zmienia bramki ani punktów. Podpis Sigstore świadek weryfikuje w pełni tam, gdzie jest biblioteka sigstore
  (pliki wykonywalne, jak samoaktualizacja S5); w .pyz bez niej – tylko obecność pakietu podpisu.
- Później (z tymi samymi zasadami: tylko dane, SHA-256, zgoda, limity, bez otwartych portów bez zgody):
  - udostępnianie plików innym węzłom (P2P przez kanał grzybni, uwierzytelnione, z limitem; nigdy bez zgody),
  - rozproszona kopia zapasowa zatwierdzonych znaczeń i strzępków (paczki z sumą SHA-256 i podpisem wydania),
  - pamięć zweryfikowanych odpowiedzi (cache odpowiedzi z dowodami, unieważniany nową wersją modelu),
  - mapa opóźnień do przydziału zadań (pomiar RTT między węzłami, tylko liczby),
  - kolejka pobierania „gdy bezczynny / na ładowarce” (stan zasilania z systemu),
  - opcjonalnie 2–3 pytania dziennie z Weryfikuj w panelu węzła (powiadomienie tylko za zgodą).

## Etap C – czat globalny, role i „jak ludzie piszą” (prośba właściciela 25.10, t95u)
- Zrobione (pierwszy plasterek): czat globalny ludzi i botów węzłów na żywo (Realtime), rola **Developer** z klucza
  właściciela (automatycznie na urządzeniach z kluczem w Weryfikuj), Moderatorzy, dziennik moderacji, bez cenzury słów.
- Model komunikacji: klasyfikator intencji w przeglądarce (pytanie / emocja / niezgoda / ironia / powitanie /
  stwierdzenie, `web/src/myc/intent.ts`) + ekstrakcja wzorców w bazie (skróty, emotikony, wydłużenia, próbki intencji
  i ironii) → Weryfikuj → zatwierdzone → strzępki i dane treningowe. Klasyfikator działa też w „Rozmowie”: zatwierdzona
  próbka niezgody uruchamia tę samą pętlę naprawy co „pierdolisz”.
- Dalej: (1) eksport zatwierdzonych wzorców jako odłamek LM (`scripts/export_patterns.py` → `web/public/data/lm/patterns.jsonl`)
  i dołączanie do treningu; (2) klasyfikator intencji uczony na zatwierdzonych próbkach (zamiast reguł) z oceną na
  stałym zbiorze; (3) agenci węzłów głosujący na wzorce (p_agent, waga ≤ 0,7); (4) węzły rozumienia (Etap A) używają
  intencji i rejestru jako pierwszego kroku.

## Etap K – Kręgi (prośba 25.10, t97u/t99u/t100u)
- Zrobione (plasterek 1): kręgi z zaproszeniem kodem, właściciel/admini, limit osób, kanał kręgu w czacie (RLS),
  zaufanie ze zweryfikowanego wkładu (z wygaszaniem i karami), poręczenia ze stawką, zamrażanie przez Developera,
  dziennik kręgu, UI w Koncie (telefon najpierw).
- **Moc obliczeniowa – NIE „najpierw krąg”.** Wszyscy zawsze korzystają z całej sieci. Gdy zadanie potrzebuje
  dodatkowej mocy (szczyt), harmonogram dobiera kolejne węzły według **wyniku wydajności**: najniższe zmierzone
  opóźnienie (mapa opóźnień ze świadka / pasywnych pingów), wolna moc, przepustowość (zmierzone FLOP/s), niezawodność
  i zaufanie. Członkostwo w kręgu to tylko mały bonus przy remisie. Cel: maksymalna łączna przepustowość.
  Plasterek 2: tabela pomiarów opóźnień między węzłami (z `myc_witness`), wynik węzła w `myc_jobs`, test A/B na czasie
  ukończenia zadań.
- Plasterek 3 – **Specjalizacje**: krąg wybiera dziedzinę (język/slang, obrazy, matematyka/logika, źródła/fakty –
  pole `spec` już jest) → zadania tej dziedziny w Weryfikuj i w warstwach rozumienia/rozumowania (Etap A) trafiają
  do niego częściej; nadal bez blokowania reszty sieci.
- Plasterek 4 – **Mosty**: zaufanie między kręgami, gdy ich członkowie niezależnie zgadzają się na tych samych
  pozycjach (zgodność z decyzją końcową); graf strzępek (hyphae) na stronie.
- Plasterek 5 – **Lokalna wiedza**: słownik slangu/gwary kręgu (widoczny dla kręgu), z przyciskiem „zgłoś do
  głosowania globalnego” → Weryfikuj.
- Plasterek 6 – **Wspólne cele**: zadania kręgu na tydzień (np. 500 zweryfikowanych pozycji) liczone wyłącznie
  z prawdziwych liczników; odznaki.
- Plasterek 7 – **Odzyskiwanie przez krąg** (opcjonalne): k z n zaufanych członków zatwierdza przywrócenie konta bez
  kodu; opóźnienie (np. 72 h), powiadomienie na wszystkich urządzeniach konta, weto właściciela konta, dziennik.

## Etap P – prawda ze źródeł (prośba właściciela 24.10, t103u/t107u)
Zasada: bez cenzury (wulgaryzmy dostają tylko etykietę rejestru), ale odpowiedź na pytanie o fakt musi pochodzić ze
źródła, które można sprawdzić. Bez źródła czat mówi „nie wiem” i proponuje naukę – nie zgaduje.

Zrobione w tej wersji:
- **Pamięć wiedzy obok modelu** (`web/src/myc/knowledge.ts`): zatwierdzone znaczenia z czatu, zweryfikowane strzępki,
  zatwierdzone poprawki odpowiedzi z Weryfikuj i fakty z konsensusu w jednym indeksie BM25 w przeglądarce (tylko dane).
  Czat używa ich od razu, bez treningu; każdy wpis pokazuje pochodzenie (źródło, data zatwierdzenia, liczba głosów).
- **Odpowiedzi ze źródłem** (`web/src/myc/wiki.ts`, `sourced.ts`): kolejność Wikidata → pamięć wiedzy → pewny fakt z
  konsensusu → polska Wikipedia (zdanie przepisane dosłownie ze wstępu artykułu + link). Hosty Wikipedii/Wikisłownika/
  Wikidata były już w CSP (`connect-src`), nic nie dodano. Odpowiedź modelu na węzłach nie jest używana do pytań o fakt.
- **Każda odpowiedź czatu w Weryfikuj** (`supabase/myc_answers.sql`, typ „answer”): pytanie bez e-maili, linków,
  telefonów i imion, odpowiedź, źródła, pewność, etykiety (temat/kategoria z taksonomii, intencja, ma źródło, rejestr),
  filtry; głosy potwierdź / nie zgadzam się / popraw z wagą zaufania (Dawid–Skene; właściciel = złota etykieta,
  ludzie ≤ 0,9, agenci ≤ 0,7). Poprawka zatwierdzona → strzępek `odpowiedz` (pamięć wiedzy); odpowiedź błędna →
  `myc_error_set` „nigdy więcej”. Rezygnacja: przełącznik w czacie + `myc_account_prefs.train_ok` konta.
- **Pomiar**: stały zestaw 40 pytań `benchmarks/chat_facts/chat_facts_v1.json` (nie należy do bramki 2000 pytań),
  wyniki w `results/chat_facts/`.

Zaplanowane (każdy moduł zmienia model wyłącznie przez bramkę bez regresji na 2000 pytaniach):
- [ ] **Kilka dróg rozumowania + głosowanie węzłów**: kilka węzłów odpowiada niezależnie (różne źródła/ziarna),
  wygrywa odpowiedź z konsensusem ważonym zaufaniem; brak zgody → „nie jestem pewna” zamiast zmyślania.
- [ ] **Model krytyk** uczony na głosach z Weryfikuj (potwierdź/nie zgadzam się/popraw na odpowiedziach czatu):
  ocenia odpowiedź przed wysłaniem (na temat? zgodna ze źródłem? sprzeczna sama ze sobą?).
- [ ] **Pamięć błędów „nigdy więcej”** (`myc_error_set`): zestaw regresji czatu z odpowiedzi uznanych za błędne;
  każda nowa wersja czatu/modelu musi go przejść. NIGDY nie jest częścią zestawu 2000 pytań bramki LM.
- [ ] **Program nauczania (curriculum)**: zadania od łatwych do trudnych; model wybiera zadania na granicy umiejętności.
- [ ] **Uczenie aktywne**: najmniej pewne odpowiedzi/elementy trafiają do Weryfikuj w pierwszej kolejności.
- [ ] **Wspólna przestrzeń pojęć** dla słów, obrazów i strzępków (jedno osadzenie: „kot” na zdjęciu = słowo „kot”).
- [ ] **Rozumowanie z kodem w piaskownicy**: przy liczbach i logice model pisze krótki program uruchamiany w izolowanej
  piaskownicy i podaje wynik obliczenia; nigdy nie modyfikuje własnego kodu ani kodu węzłów.
- [ ] **Przydział mocy po ukończeniu etapów** (rozszerzenie S4): alokator rozdziela moc między powyższe moduły według
  zweryfikowanego zysku; każda zmiana modelu nadal przechodzi przez bramkę bez regresji.

## Później
- Token L2E (nagrody za zweryfikowane dane, liniowe odblokowanie) – wymaga programu escrow/vesting na Solanie
  i sprawdzenia MiCA.
