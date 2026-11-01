# Audyt bezpieczeństwa Mycelium AI (24.10.2026)

Zakres: poprzednie prywatne repozytorium (cała historia), publiczne repozytorium `demo` Repozytorium przeniesione 25.10.2026 do nowego `mycelium` (świeża historia, bez plików gold).
(cała historia, strona, `mycelium-node.pyz`, pliki wydań węzła na PC), baza Supabase „supab” (RLS, funkcje,
storage, doradcy), węzeł dla wolontariuszy (pyz/exe/przeglądarka), frontend, zależności.
Wartości sekretów nigdy nie są tu cytowane.

## Podsumowanie

| # | Obszar | Ustalenie | Waga | Stan |
|---|--------|-----------|------|------|
| 1 | Sekrety | Brak wycieku: w historii obu repozytoriów, w pyz i w rozpakowanych plikach wydań tylko klucz publikowalny Supabase (`sb_publishable_…`, publiczny z założenia). Brak klucza `service_role`/`sb_secret_`, tokenów GitHub/Supabase, klucza właściciela ani kluczy weryfikatorów (sprawdzone dosłownie i wzorcami). W demo tylko adresy `noreply` GitHub. | – | OK, nic do rotacji |
| 2 | Supabase | Widok `myc_meanings_approved` (prosty, aktualizowalny, z prawami właściciela) pozwalał anonimowi **zmieniać/usuwać zatwierdzone znaczenia** z pominięciem RLS. Pozostałe 3 widoki zbiorcze też działały z prawami właściciela (doradca: 4× ERROR). | **Wysoka** | Naprawione (`myc_security.sql`): zapis odebrany, `security_invoker=on` |
| 3 | Supabase | Limity „na IP” brały **pierwszy** element `X-Forwarded-For`, który ustawia klient – dowolny nagłówek omijał limit (sprawdzone na żywo). | Średnia | Naprawione: `myc_client_ip()` = `cf-connecting-ip` (Cloudflare), awaryjnie ostatni element XFF |
| 4 | Węzeł | Składanie ramek z publicznego pokoju Realtime bez limitów (`tot` do 65535, nieograniczona liczba niedokończonych wiadomości) → zajęcie pamięci przez obcego. Także w przeglądarce. | Średnia | Naprawione: ≤ 256 ramek (~12 MB), ≤ 64 niedokończone, wygasanie 60 s |
| 5 | Węzeł | Parametry zadań (`ids`, `shard`, rozmiar wejścia, `temp`, `conv`) nie były sprawdzane – możliwe bardzo długie prompty / duże bufory (DoS CPU/RAM). | Średnia | Naprawione: typy, zakresy (słownik, ≤ 4096 tokenów, shard z listy), rozmiar bufora |
| 6 | Węzeł | Nazwy plików z `meta.json` (danych z demo) trafiały wprost do ścieżki w pamięci podręcznej – `../` mogłoby zapisać plik poza nią, gdyby ktoś przejął stronę demo. | Niska | Naprawione: tylko `[A-Za-z0-9._-]`, bez `..`; ścieżki adapterów `lm/vN-xxxxxxxx.bin` |
| 7 | Wydania | Pliki węzła tylko z SHA-256 (bez podpisu). | Niska | Naprawione w workflow: poświadczenie pochodzenia GitHub (`gh attestation verify`) + podpis Sigstore/cosign `SHA256SUMS.txt` (bez kluczy do przechowywania); instrukcja w „Zostań węzłem” |
| 8 | Frontend | Brak CSP. Brak `innerHTML`/`dangerouslySetInnerHTML`/`eval` w `web/src` – tekst od użytkowników renderuje React jako tekst. Lokalna strona stanu węzła używała `innerHTML` (dane lokalne). | Niska | Dodane CSP (`<meta>`, tylko build): skrypty z własnej domeny + jsDelivr (onnxruntime), bez inline/eval, połączenia tylko do znanych hostów; strona stanu: `textContent` |
| 9 | Supabase | 2 funkcje bez stałego `search_path`; funkcje wyzwalaczy wykonywalne przez REST; zbędne prawa zapisu na `myc_eval_set_history`. | Niska | Naprawione |
| 10 | Zależności | `npm audit`: 0; `pip-audit` (requirements + websockets): 0. `torch +cpu` spoza PyPI – nieaudytowalny automatycznie; węzeł nie używa `torch.load`/pickle. | – | OK |
| 11 | Projekt współdzielony | W tej samej bazie są tabele innej aplikacji (dane osobowe). Anon nie widzi żadnych wierszy; nie ma wyzwalacza na `auth.users`, więc anonimowe konto nie dostaje profilu ani agencji → polityki tamtej aplikacji nic mu nie pokazują (rejestracja e-mailem była i tak otwarta). | Info | Sprawdzone |
| 12 | Prywatność | Skróty IP (`proposer_ip` w `myc_candidates`, `ip_hash` w `myc_candidate_evals`) były czytelne dla anon. Sól w `myc_ip()` jest jawna, więc skrót dało się odwrócić przeglądem całej przestrzeni IPv4. | Średnia | Naprawione 01.11.2026: prawa SELECT na poziomie kolumn bez tych pól (`supabase/myc_privacy_ip.sql`) |

## Szczegóły

### Sekrety
- `gitleaks` (pełna historia obu repo + katalog wydań): 14 + 5 trafień, **wszystkie** to klucz publikowalny
  albo nazwa modelu – fałszywe alarmy. Dodatkowy skan wzorcami: klucz właściciela (dosłownie), `sb_secret_`,
  `service_role` JWT, `sbp_`, `ghp_/github_pat_`, `PRIVATE KEY`, ścieżki skrzynki (`/workspace`, `/cursor/stores`).
  W demo jedyne `sb_secret_` to nazwa prefiksu w kodzie biblioteki supabase-js.
- Pliki wydań (exe/linux/macos) rozpakowane `pyinstxtractor` – brak trafień. Sumy SHA-256 zgodne z `SHA256SUMS.txt`.
- Prywatne repo zawiera w metadanych commitów adres e-mail autora; publiczne demo – nie.
- Klucz właściciela, klucz testowy e2e i klucze weryfikatorów są w bazie tylko jako SHA-256 (`myc_owner`,
  `myc_review_keys`, `myc_ci_keys`); weryfikatory GitHub trzymają je w sekretach repozytorium.

### Supabase (RLS, funkcje, storage)
- Wszystkie tabele `myc_*` mają RLS. Anon: odczyt danych publicznych/zbiorczych, zapis tylko przez
  6 tabel z wyzwalaczem limitu (`myc_rate_limit`) i ~30 funkcji `SECURITY DEFINER` ze stałym `search_path`,
  sprawdzaniem kształtu danych i limitami (`myc_rl`). Funkcje „zaufane” wymagają klucza (porównanie SHA-256).
- Storage `myc-models`: publiczny odczyt; anonimowy zapis tylko nowych plików o nazwie `model/vN-<8 hex>.bin|json`,
  ≤ 4 MB, bez nadpisywania (brak polityki update). Węzły sprawdzają, że 8 znaków nazwy = początek SHA-256 treści.
- Doradca bezpieczeństwa po zmianach: 0 ERROR; zostają ostrzeżenia „anon może wywołać funkcję SECURITY DEFINER”
  – to celowe API (każda sprawdza dane/klucz).

### Węzeł dla wolontariuszy (pyz / exe / przeglądarka)
- **Brak zdalnego wykonywania kodu**: zadania z bazy i wiadomości z pokoju to wyłącznie JSON + surowe bufory float/int;
  nie ma `eval`/`exec`/`pickle`/`torch.load`, nie ma pobierania ani uruchamiania kodu, **nie ma samoaktualizacji**.
- Wagi modelu: `safetensors` czytane własnym parserem (tylko nagłówek JSON + bufory BF16), stała rewizja z Hugging Face
  i sprawdzana suma SHA-256. Adaptery LoRA i dane: własny format binarny + SHA-256 (z `meta.json` lub z nazwy pliku).
- Pliki: tylko pamięć podręczna (`~/.cache/mycelium` lub `MYC_CACHE`). Wyjątek na żądanie użytkownika:
  `--install` kopiuje program i dodaje autostart (usługa systemd użytkownika / launchd / Autostart Windows), `--uninstall` usuwa.
- Sieć: wyłącznie `agortpieeygmcttjwjfx.supabase.co` (REST/Realtime/Storage), `maciejsearch-cloud.github.io` (dane),
  `huggingface.co` (wagi). Strona stanu tylko na `127.0.0.1`, bez CORS, bez sekretów.
- Zasoby: `--threads`, obniżony priorytet procesu, jedno zadanie naraz (blokada), limity wiadomości (pkt 4–5),
  ≤ 96 sesji K/V, ≤ 8 rozmów.
- Przeglądarka: obliczenia w Web Workerach (tfjs/onnx/WebGPU), dane z bazy to liczby; sesja startuje dopiero po zgodzie.

### Weryfikacja plików węzła
```
gh attestation verify MyceliumNode.exe -R maciejsearch-cloud/demo
cosign verify-blob --bundle SHA256SUMS.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/maciejsearch-cloud/demo/.github/workflows/mycelium-node-build.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt
```
Brak certyfikatu wydawcy Windows (Authenticode) i notaryzacji Apple – to wymaga płatnego certyfikatu na osobę/firmę.

## Anonimowe konta (`supabase/myc_accounts.sql`, zakładka „Konto”)
- Supabase Auth „anonymous sign-in” (włączone w projekcie): bez e-maila, imienia, hasła. Konto zakładane dopiero
  po kliknięciu (zwykły gość nie tworzy użytkownika auth). Sesja w `localStorage` urządzenia.
- Konto: pseudonim (unikalny), kod polecający (8 hex; dla istniejących osób = dotychczasowy kod z linku),
  powiązanie z dawnym `contributor_id` i węzłami (pierwsze przypisanie wygrywa, potem niezmienne).
- Przeniesienie na inne urządzenie: **kod odzyskiwania** (~120 bitów z serwera, pokazany raz, w bazie tylko SHA-256,
  nowy unieważnia stary, limit prób na IP). Passkey (WebAuthn) – nie wdrożony (w Supabase tylko jako MFA dla kont z e-mailem).
- RLS: tabele kont bez praw dla anon; zalogowany widzi tylko własne wiersze (hash kodu niewidoczny). Wszystkie zmiany
  przez funkcje `myc_acct_*` (tylko `authenticated`, limity). Bezpośredni zapis do kont/punktów: 403 (test).
- Polecenia: zapisuje serwer; jedno na konto, w ciągu 30 dni od założenia, bez samopolecenia, bez pętli, bez wspólnego
  urządzenia; liczy się dopiero, gdy polecona osoba ma ≥ 10 zatwierdzonych punktów własnego wkładu.
- Punkty (`myc_points`, pg_cron co 10 min): 1 pkt za wynik treningu/hiperparametrów, 0,1 pkt za odpowiedź;
  `pending` → `approved`/`rejected` po bramce/weryfikacji/konsensusie; 5 pkt za zakwalifikowane polecenie.
- Portfel: tylko publiczny adres Solana (base58, 32 bajty, sprawdzane w przeglądarce i w bazie); ostrzeżenie, żeby nigdy
  nie podawać klucza ani seeda. W UI: „planowane, nieaktywne”, bez tokena, wypłat i obietnic. **Analiza prawna (MiCA) – do zrobienia.**
- Testy: `web/e2e-account/accounts-api.mjs` (24 sprawdzenia API/RLS) i `web/e2e-account/account.spec.ts`
  (telefon 390×844 + desktop, pokój `e2e`, sprzątanie `myc_acct_e2e_cleanup`; osieroceni anonimowi użytkownicy auth
  usuwani przez `myc_auth_purge` po dobie).

## Czat globalny, role i wzorce języka (25.10.2026, `supabase/myc_gchat.sql`, `myc_lang.sql`)
- **Zapis tylko przez funkcje** `myc_gchat_post` (konto z sesji `auth.uid` → urządzenie → konto; pseudonim i rola
  wpisywane przez serwer) i `myc_gchat_node_post` (bot węzła – tylko węzeł z prawdziwym wynikiem/zdarzeniem w 7 dni,
  podpisany „węzeł·xxxxxx”). anon/authenticated nie mają INSERT/UPDATE/DELETE na `myc_gchat`; nie da się pisać
  jako ktoś inny ani nadać sobie roli. Odczyt: polityka RLS (globalny – każdy; kanał kręgu – tylko członkowie),
  działa też dla Realtime (postgres_changes z tokenem sesji).
- **Limity**: 8 wiadomości/min na konto, 240/min na pokój, 3/min na węzeł, limit na adres klienta (cf-connecting-ip,
  `myc_rl`), ta sama treść 2× w 2 min odrzucona, maks. 1000 znaków (węzeł 500).
- **Bez cenzury słów** (decyzja właściciela): wulgaryzmy dostają tylko etykietę rejestru (`tags`, słownik
  z Wikisłownika); moderuje człowiek.
- **Role**: `developer` – kluczem właściciela (`myc_gchat_claim_owner`: porównanie SHA-256 z `myc_owner`, klucz nie jest
  zapisywany; limit 5 prób/min na IP; każde urządzenie, które poda klucz, przypina rolę do swojego konta i jest
  zapisane w `myc_owner_devices`). Urządzenie z kluczem zapisanym w Weryfikuj (localStorage) robi to automatycznie po
  zalogowaniu. `moderator` – nadaje Developer. Moderator: przypnij/usuń/wycisz ≤ 24 h, nie wobec innych ról;
  Developer: dodatkowo ban/odbanowanie, nadawanie/odbieranie Moderatora, zamrażanie kręgów, złota etykieta w
  głosowaniu wzorców. Każda akcja → `myc_mod_log` (widoczny dla ról, pseudonimy, bez IP/urządzeń).
- **Prywatność**: w tabelach czatu nie ma adresu IP (limiter trzyma skrót IP ≤ 1 h w `myc_rate`). Powiązanie
  wiadomość → konto/węzeł w prywatnej `myc_gchat_priv` (bez dostępu przez REST). Przełącznik „moje wiadomości uczą
  model” (domyślnie włączony, widoczny pod czatem); wyłączenie oznacza wszystkie moje wiadomości jako nieużywane
  i usuwa oczekujące próbki zdań z nich. Kanały kręgów nigdy nie uczą modelu.
- **Wzorce zamiast profili** (`myc_lang_extract`, pg_cron co 10 min): treść czyszczona `myc_scrub` (linki, e-maile,
  telefony, @wzmianki, pseudonimy kont, id węzłów → znaczniki). Skrót/emotikon/wydłużenie zostaje kandydatem dopiero
  przy ≥ 2 różnych kontach; licznik autorów to `md5(sól ‖ konto ‖ token)` – inny dla każdego tokenu, więc nie da się
  złożyć „słownika osoby”. Kandydaci idą do Weryfikuj (prawda/kłamstwo, wagi zaufania jak przy znaczeniach); dopiero
  zatwierdzone stają się strzępkami (`source='chat'`) i danymi treningowymi (`scripts/export_patterns.py`, tylko dane).
- Test: `supabase/tests/gchat_circles_test.sql` (jedna transakcja wycofywana; 40 sprawdzeń: zły klucz, pisanie bez
  konta, duplikat, wyciszenie, uprawnienia moderatora, brak INSERT, brak odczytu `myc_gchat_priv`, kanał kręgu
  niewidoczny dla obcych i anon, zamrożenie, czyszczenie danych z próbek, wycofanie zgody, brak kolumn IP).

## Kręgi (25.10.2026, `supabase/myc_circles.sql`, Konto → Kręgi)
- Tabele kręgów bez żadnych praw dla anon/authenticated; wszystko przez funkcje sprawdzające członkostwo/rolę
  (właściciel/admin kręgu, Developer). Kod zaproszenia `KRG-…` (~72 bity) pokazany raz, w bazie tylko SHA-256,
  wymiana w każdej chwili; dołączanie limitowane na IP (6/min). Limity: maks. 3 własne kręgi, 10 kręgów na konto,
  rozmiar 2–200. Developer może zamrozić krąg (czat kręgu tylko do odczytu, brak dołączania i poręczeń). Dziennik
  `myc_circle_log` (+ `myc_mod_log` dla akcji Developera).
- **Zaufanie** (`myc_trust_calc`) tylko ze zweryfikowanego wkładu: zatwierdzone punkty (bez poleceń), zgodność ze
  złotymi etykietami (od 5 odpowiedzi), dni aktywności w 30, poświadczenia świadka; kara za odrzucone punkty i głosy
  sprzeczne z decyzją właściciela; wygaszanie po 7 dniach bez aktywności; konto < 7 dni maks. 0,3. Składniki widzi
  właściciel konta, członkowie kręgu widzą tylko wynik.
- **Poręczenia**: stawka 0,02–0,2 (≤ ⅓ zaufania), wymagane zaufanie ≥ 0,35 i konto ≥ 14 dni, maks. 3 aktywne, jedno
  aktywne na nowicjusza, bez wycofania. `myc_vouch_settle` (co godzinę): zwrot po 14 dniach, gdy nowicjusz ma własne
  zaufanie ≥ 0,3 bez kar; utrata przy banie / > 50% odrzuconego wkładu / > 50% kłamliwych głosów; Developer może
  odebrać stawkę ręcznie. Usunięcie kręgu nie kasuje poręczeń (utracona stawka zostaje utracona).
- Ryzyko: zaufanie nadal opiera się na przypisaniu węzłów do kont (pierwsze przypisanie wygrywa, patrz niżej) –
  przed nagrodami potrzebny dowód posiadania węzła.

## Ryzyka, które zostają (uczciwie)
- **Sybil / zatruwanie danych**: identyfikatory węzłów i osób są generowane przez klienta i publiczne (ranking).
  Jedna osoba może uruchomić wiele węzłów/kont (limit: 5 kont/min na IP, IP da się zmieniać). Wagi zaufania liczone
  z trafności na złotym zbiorze i konsensusie ograniczają wpływ, a modele publikuje tylko bramka z niezależną
  weryfikacją (zaufane węzły + GitHub), więc zatrucie modelu wymaga przejścia ścisłej oceny – ale głosy w Weryfikuj
  i odpowiedzi od wielu fałszywych węzłów nadal mogą przesunąć konsensus dla rzadkich pytań.
- **Przypisanie wkładu**: punkty liczone po `node_id`/`contributor_id`, które da się podać w zapytaniu – ktoś może
  dopisać wynik „na cudzy” węzeł (nie odbierze go), a dawne ID z rankingu może przypisać sobie pierwszy, kto zażąda.
  Przed jakąkolwiek realną nagrodą potrzebny jest dowód posiadania węzła (klucz węzła podpisujący wyniki)
  i ręczny przegląd przypisań dawnych ID.
- Anonimowe logowanie bez CAPTCHA (limit Supabase 30/h na IP). Przy nadużyciach: włączyć Turnstile/hCaptcha.
- Sesja w `localStorage` – XSS przejąłby konto (CSP to ogranicza). Utrata urządzenia bez kodu = utrata konta.
- Brak podpisu Authenticode/Apple – ostrzeżenia systemu przy pierwszym uruchomieniu.
- Nagrody krypto: brak tokena i escrow; wymagają osobnego audytu programu Solana i analizy MiCA przed uruchomieniem.
- Czat globalny: brak CAPTCHA przy zakładaniu konta (limity jak wyżej); fałszywe węzły z prawdziwym wkładem mogą pisać
  (3/min). Klasyfikacja intencji i etykiety rejestru liczone w przeglądarce – to tylko kandydaci, decyduje głosowanie.

## Audyt 01.11.2026 (zależności, Node.js, Supabase, frontend, węzeł, telemetria)

| # | Obszar | Ustalenie | Waga | Stan |
|---|--------|-----------|------|------|
| A1 | CI | Node.js 20 w `ci.yml` i `live-watch.yml` – koniec wsparcia (EOL) 30.04.2026. | Średnia | Naprawione: Node.js 24 (aktywne LTS) |
| A2 | Węzeł (prywatność) | Węzeł Pythona ogłaszał w publicznej obecności Realtime etykietę `nazwa_komputera/nazwa` (`platform.node()`) – wyciek nazwy hosta wolontariusza. | Średnia | Naprawione: tylko nazwa węzła (`--name`) |
| A3 | Frontend (CSP) | `script-src` dopuszczał `cdn.jsdelivr.net` (onnxruntime-web dla modeli w przeglądarce). Przejęcie CDN = wykonanie skryptu na stronie (klucz właściciela i portfela w `localStorage`). | Średnia | Naprawione: onnxruntime-web hostowany u nas (`/ort/`, 4 pliki, +41 MB w demo), CSP `script-src 'self' 'wasm-unsafe-eval'`; modele w przeglądarce sprawdzone (wczytanie 22 s, odpowiedź czatu, 0 naruszeń CSP, 0 żądań do CDN) |
| A4 | Pliki węzła PC | Workflow budowania instalował zależności bez przypiętych wersji/skrótów; akcje przypięte tagiem. Wersja DirectML wymaga `torch==2.4.1` (stary; luki dotyczą `torch.load`, którego węzeł nie używa). Python 3.12 – wspierany do 10.2028. | Niska | Naprawione (repo demo, PR #1): `.github/node-build/<plat>.txt` z wersjami i SHA-256 (4 platformy), `pip install --require-hashes`, akcje po SHA; sprawdzone pobraniem z kontrolą skrótów + pełną instalacją Linux |
| A5 | Supabase | 10 funkcji `security definer` z `p_key` bez `myc_rl`. Klucz sprawdzany przez skrót SHA-256; nieudana próba kończy się wyjątkiem, więc licznik w tej samej transakcji i tak by się wycofał. Minimalna długość klucza recenzenta: 8 znaków. | Niska | Naprawione: nowe klucze recenzentów min. 20 znaków (`myc_review_key_add`, `myc_key_room`); istniejący klucz e2e działa jak dotąd (`created_at` = null) |
| A6 | Supabase | Nowe tabele `myc_lm_self`, `myc_lm_curriculum`, `myc_moc`, `myc_moc_hour`: RLS, anon tylko `select`; zapis telemetrii wyłącznie przez `myc_moc_push` (limit `myc_rl` na węzeł, ≥ 45 s między raportami, globalnie ≤ 300/min, zakresy wartości, lista dozwolonych rodzajów pracy). Rollup/GC tylko z pg_cron. | – | OK |
| A7 | Telemetria | `myc_moc` nie zapisuje IP, nazwy hosta ani konta – tylko id węzła, CPU/GPU/RAM, wątki, urządzenie, sekundy pracy; 48 h surowo, 30 dni godzinowo. | – | OK |
| A8 | Zależności | `npm audit`: 0. `pip-audit` (requirements): 0. Środowisko węzłów na tym komputerze: `setuptools 78.1.0` (PYSEC-2025-49, GHSA-xmj3-9gf7-h52w). | Niska | Naprawione lokalnie: setuptools 84.2.1 |
| A9 | Sekrety | `gitleaks` 8.28 – cała historia `mycelium`: 0 trafień. Job gitleaks w CI działa. | – | OK |
| A10 | Samoaktualizacja | Węzeł weryfikuje podpis Sigstore z dokładną tożsamością workflow (`mycelium-node-build.yml@refs/heads/main`) i wydawcą OIDC GitHub; brak podpisu = brak aktualizacji. | – | OK |
| A11 | Frontend (XSS) | Brak `innerHTML`/`dangerouslySetInnerHTML`/`eval` w `web/src`; czat i „Mówca” renderowane jako tekst przez React. `img-src *` (tylko obrazy). | Info | OK |
| A12 | Projekt współdzielony | W tej samej bazie są tabele innej aplikacji z prawami zapisu anon (pilnowane politykami RLS). Poza zakresem Mycelium. | Info | Do decyzji: osobny projekt Supabase |
