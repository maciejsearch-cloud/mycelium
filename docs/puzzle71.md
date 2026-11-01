# Bitcoin Puzzle #71 – szukanie klucza mocą węzłów (≈10 %)

**Co to jest.** W 2015 r. ktoś wysłał bitcoiny na 256 adresów, których klucze prywatne leżą w znanych, rosnących
zakresach (zagadka *n* ma klucz między 2^(n−1) a 2^n − 1) – celowo, żeby mierzyć, ile mocy trzeba do łamania kluczy.
Zagadka #71: adres `1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`, zakres `0x400000000000000000 … 0x7fffffffffffffffff`
(2^70 ≈ 1,18·10^21 kluczy). Saldo 1.11.2026 (mempool.space i blockstream.info, zgodne): **7,10195986 BTC**, 72 wpływy,
nic nie wydano. Klucz publiczny tego adresu nie jest znany (nigdy nic z niego nie wysłano), więc jedyna metoda to
sprawdzanie kluczy po kolei – kangur Pollarda tu nie działa.

**Uczciwe szanse.** Przy 1 mln kluczy/s przejrzenie całości trwa ≈37 mln lat (znalezienie średnio połowę tego); szansa
na rok ≈ 1 : 37 mln. Szukają też inni – pule GPU (np. btcpuzzle.info) mają moc o rzędy wielkości większą niż nasze CPU.
To nie jest inwestycja ani obietnica wypłaty. Zakładka **Moc** pokazuje na żywo szybkość z podpisanych raportów węzłów,
liczbę sprawdzonych kluczy i szacunek przy obecnym tempie.

Krackpot (krackpot.io) i podobne aplikacje pobierają część nagrody; my szukamy sami, bez pośrednika.

## Jak to działa

1. **Algorytm** (`src/iot_mycelium/mesh/p71/`): dla kolejnych kluczy *k*: punkt *k·G* na secp256k1 → klucz publiczny
   skompresowany (02/03 ‖ x) → SHA-256 → RIPEMD-160 → porównanie z hash160 adresu (`f6f5431d…a0a5b8`). Kolejne punkty
   to dodawanie P + j·G z jedną odwrotnością w ciele na paczkę 1024 kluczy (trik Montgomery'ego). Rdzeń w C
   (`p71core.c`, ctypes, kompilowany lokalnie); bez kompilatora – ten sam algorytm w czystym Pythonie (≈10× wolniej).
   Poprawność: testy na rozwiązanych zagadkach #20–#30 (klucz → adres), zgodność C ↔ Python ↔ naiwne *k·G* (tests/test_p71.py).
2. **Moc** (`worker.py`): jeden wątek, `nice 19` (Linux: per wątek), cykl pracy z czasu CPU wątku: średnio `pct`% z
   wątków węzła (10 % z 4 wątków = 0,4 rdzenia). Węzły właściciela (box1, box2): włączone, 10 %. Węzły ochotników:
   **domyślnie wyłączone**, włączenie w panelu węzła (zakładka Pasywny → Puzzle #71) z tekstem zgody i szansami;
   maksimum 10 %.
3. **Koordynacja** (`supabase/myc_p71.sql`): przestrzeń = 2^38 paczek po 2^32 kluczy. `myc_p71_claim` losuje wolną
   paczkę (bez nakładania), węzeł wznawia swoją otwartą paczkę po restarcie (postęp lokalnie). `myc_p71_done` przyjmuje
   wynik: XOR wszystkich hash160 w paczce, liczba kluczy, czas. Każdy raport podpisany kluczem Ed25519 węzła
   (`myc_node_keys`, ten sam co w portfelu) z czasem (±10 min). Porzucone przydziały wracają do puli po 72 h.
4. **Uczciwość**: ok. 1 na 20 przydziałów to przeliczenie cudzej, zrobionej paczki. Zgodny XOR = paczka potwierdzona;
   niezgodny = paczka „sporna”, jej klucze nie liczą się do pokrycia ani do podziału nagrody. XOR-a nie da się
   policzyć bez zhashowania każdego klucza. Ograniczenie: węzeł, który *znajdzie* klucz, może go zatrzymać dla siebie
   (patrz „Słabe strony”).
5. **Baza**: jeden wiersz na paczkę (~150 B). Przy ~0,7 rdzenia to ok. 15 paczek/dobę ≈ 1 MB/rok; twardy limit
   200 000 wierszy. Tabele bez odczytu publicznego; publiczne są tylko sumy (`myc_p71_stats`).

## Bezpieczeństwo trafienia

Puzzle #66 (09.2024) i #69 (04.2025) zostały **ukradzione**: zwycięzca wysłał transakcję do publicznego mempoolu,
co ujawniło klucz publiczny; boty w sekundy policzyły klucz prywatny kangurem Pollarda (2^35 operacji dla 70 bitów)
i podmieniły transakcję (RBF). #67 i #68 odebrano bezpiecznie, z pominięciem mempoolu. Dlatego:

- Klucz **nigdy** nie trafia do bazy jawnie, do czatu, do logów ani do mempoolu. Węzeł sprawdza trafienie drugą,
  niezależną ścieżką (Python), szyfruje klucz do **klucza publicznego właściciela** (X25519 + HKDF-SHA256 +
  ChaCha20-Poly1305, `seal.py`, klucz publiczny `owner_x25519.pub`), zapisuje szyfrogram lokalnie (`<cache>/p71/hit-*.sealed`,
  chmod 600) i wysyła **tylko szyfrogram** (`myc_p71_hit`). Log mówi tylko „TRAFIENIE – zaszyfrowane”.
- `myc_p71_hits` nie ma odczytu publicznego, a statystyki nie zawierają liczby trafień. Paczka z trafieniem jest
  raportowana jak każda inna, żeby z publicznych danych nie dało się wskazać, gdzie szukać.
- Klucz prywatny właściciela powstał na boxie: `/workspace/.secrets/p71/owner-x25519.key` (katalog 700, plik 600, poza
  repozytorium), kopia `/workspace/backups/p71/`. Nigdy nie był wypisany. **Właściciel powinien przechować kopię poza
  boxem** (np. menedżer haseł), bo bez niego szyfrogramu nie da się otworzyć.
- Nie ma automatycznego wysyłania transakcji.

### Procedura odbioru (ręcznie, tylko właściciel)

1. Otwórz szyfrogram na zaufanym komputerze: `python scripts/p71_open.py <plik .sealed albo id z myc_p71_hits>` –
   skrypt sprawdza, że klucz daje adres `1PWo3…zXU`, i zapisuje WIF do pliku chmod 600 (nie wypisuje go).
2. Zbuduj i podpisz transakcję **offline** (np. Sparrow/Electrum bez sieci), wydając wszystkie 72 wyjścia na adres
   docelowy właściciela (najlepiej multisig projektu), z wysoką opłatą, bez RBF.
3. Wyślij ją **prywatnie do górnika**, nigdy do publicznego mempoolu: MARA Slipstream (slipstream.mara.com) albo
   Rebar Shield (rebarlabs.io). Nie wklejaj jej w żaden publiczny „broadcast”. Licz się z tym, że górnik widzi
   transakcję (zaufanie do jednej firmy) i że wydobycie może potrwać kilka bloków.
4. Po potwierdzeniu: rozdział według zasad niżej, ze wszystkimi transakcjami opublikowanymi.

## Zasady podziału (ogłoszone z góry, 1.11.2026)

Jeśli klucz się znajdzie, po opłatach transakcyjnych:

| Udział | Na co |
|---|---|
| 40 % | rozwój projektu (serwery, sprzęt, praca) |
| 30 % | użytkownicy – proporcjonalnie do zweryfikowanej pracy przy zagadce (klucze z podpisanych raportów, bez paczek spornych); dotyczy ochotników, którzy włączyli Puzzle #71 |
| 15 % | odkup MYC |
| 15 % | pula płynności MYC |

**MYC jest dziś tokenem testowym bez wartości i bez rynku.** Części na odkup i pulę płynności zostają w rezerwie
(BTC), dopóki nie powstanie prawdziwy token MYC i prawdziwa pula; do tego czasu nic nie jest odkupywane. To nie jest
obietnica zysku ani inwestycja; najbardziej prawdopodobny wynik to brak nagrody. Wypłata części dla użytkowników wymaga
adresu BTC od każdego uprawnionego (podanego dopiero po znalezieniu) i może podlegać prawu podatkowemu ich kraju.

## Słabe strony (uczciwie)

- **Szanse**: realnie zerowe przy naszej mocy (patrz wyżej); to eksperyment pokazujący wspólną moc sieci.
- **Tylko CPU**: brak ścieżki GPU (wymagałaby osobnego jądra CUDA/OpenCL jak BitCrack); żaden węzeł nie ma dziś GPU.
- **Węzeł może ukraść trafienie**: kod węzła jest otwarty, więc zmodyfikowany węzeł ochotnika mógłby zatrzymać klucz.
  Szyfrowanie chroni przed wyciekiem w bazie/logach i przed kradzieżą z mempoolu, nie przed nieuczciwym znalazcą.
- **Weryfikacja wyrywkowa**: przeliczane jest ~5 % paczek; nieuczciwy węzeł może przez jakiś czas zawyżać pracę.
- **Klucz właściciela na jednym komputerze**, dopóki właściciel nie zrobi kopii.
