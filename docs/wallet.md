# Mycelium Wallet i token testowy MYC-test

Stan: 1.11.2026. Kod: `supabase/myc_wallet.sql`, `web/src/myc/wallet.ts`, `web/src/pages/Wallet.tsx`,
`web/src/pages/Explorer.tsx`, `src/iot_mycelium/mesh/walletwork.py`, `src/iot_mycelium/mesh/ed25519.py`.

## Czym jest MYC-test (i czym nie jest)

**MYC-test to tokeny testowe bez żadnej wartości.** Nie da się ich kupić, sprzedać, wymienić ani wypłacić. Nie ma
żadnej ścieżki zakupu ani wypłaty i nie powstanie. Nie są notowane i nie mają kursu. Każdy ekran z kwotą pokazuje
tę informację. Służą do testowania sieci Mycelium: przelewów, napiwków i walidacji bloków przez węzły.

## Jak to działa

| Krok | Gdzie | Co się dzieje |
|---|---|---|
| Klucz | przeglądarka | `tweetnacl` tworzy ziarno Ed25519 z `crypto.getRandomValues`. Ziarno jest szyfrowane hasłem (PBKDF2-SHA256, 600 000 rund → AES-GCM-256) i trafia do IndexedDB (`myc-wallet`). Serwer dostaje tylko klucz publiczny. |
| Rejestracja | `myc_wallet_register` | Podpis `MYC-TEST/v1\|register\|<konto>\|<pub>` dowodzi posiadania klucza. Konto ma jeden aktywny adres; nowy klucz zastępuje stary, a saldo starego adresu zostaje na nim. |
| Kopia | przeglądarka | Kod `MYCW1-…` (ziarno + 2 bajty sumy SHA-256, base32) pokazywany tylko na żądanie po odblokowaniu. Nie jest nigdzie zapisywany. |
| Emisja | serwer, reguły | Kran: 10,00 raz na 20 h na konto. Nagrody za zatwierdzony wkład (`myc_points`: 1 pkt = 1,00), głos w Weryfikuj zgodny z rozstrzygnięciem (0,50), ocena wpisu Grzybni (0,10). Każda emisja ma identyfikator prawdziwego zdarzenia w `memo` (unikalny indeks), więc ta sama nagroda nie powstanie dwa razy. |
| Przelew | przeglądarka → `myc_wallet_send` | Klient podpisuje `MYC-TEST/v1\|transfer\|from\|to\|amount\|nonce\|ts_ms\|memo`. Serwer sprawdza podpis (pgsodium), okno czasu ±10 min, nonce = poprzedni + 1 i saldo pod blokadą wiersza. |
| Księga | `myc_wallet_tx` | Tylko dopisywanie (wyzwalacz blokuje UPDATE/DELETE). `hash = sha256(prev_hash\|body\|sig)` tworzy łańcuch. |
| Blok | pg_cron co minutę | Do 1000 oczekujących transakcji → blok z korzeniem Merkle i nagłówkiem `MYC-TEST/v1\|block\|…`. |
| Walidacja | węzły (`walletwork.py`) | Każdy węzeł niezależnie przelicza od bloku 1: ciągłość, łańcuch skrótów, każdy podpis Ed25519, nonce, salda, reguły emisji, korzeń Merkle i skrót nagłówka. Potem liczy dowód pracy (16 bitów) i podpisuje wynik kluczem węzła. |
| Ostateczność | `myc_wallet_attest` | Blok jest ostateczny, gdy ≥ 2 różne **uprawnione** węzły poświadczą ten sam skrót, a poprzedni blok jest ostateczny. Uprawniony = węzeł z ≥ 3 przyjętymi wynikami prawdziwego treningu AI (`myc_results.status = 'accepted'`). |

Kwoty są w jednostkach 1/100 MYC-test (1000 = 10,00).

## Model zagrożeń

| Zagrożenie | Ochrona | Co zostaje |
|---|---|---|
| Kradzież klucza z serwera | Serwer nie ma kluczy prywatnych, tylko publiczne. | — |
| Kradzież klucza z urządzenia | Ziarno w IndexedDB jest zaszyfrowane hasłem (PBKDF2 600k + AES-GCM). Odblokowanie trwa 5 min i dotyczy tylko jednej karty. | Słabe hasło da się złamać offline, jeśli ktoś skopiuje profil przeglądarki. Wymagamy co najmniej 10 znaków. |
| XSS kradnący klucz | Ścisła CSP (`vite.config.ts`): skrypty tylko z tej strony (także `onnxruntime-web`, hostowany u nas w `/ort/`), bez CDN, inline i eval. React ucieka tekst, a w kodzie nie ma `dangerouslySetInnerHTML`. | Skrypt wstrzyknięty mimo CSP mógłby podpisać przelew w czasie odblokowania. Szkoda jest ograniczona, bo tokeny nie mają wartości. |
| Powtórka przelewu | Nonce musi być równy poprzedniemu + 1, a podpis obejmuje nonce i czas (okno ±10 min). | — |
| Podwójne wydanie | `myc_wallet_send` blokuje wiersz głowy łańcucha i wiersz salda (`FOR UPDATE`). Saldo ma `CHECK (balance >= 0)`. Węzły niezależnie odtwarzają salda i nonce. | — |
| Podrobiony podpis lub zmiana kwoty | pgsodium `crypto_sign_verify_detached` na serwerze. Każdy węzeł sprawdza ponownie (`cryptography` albo czysty Python RFC 8032). | — |
| Zmiana historii przez bazę | Łańcuch skrótów, korzeń Merkle i skróty bloków są niezależnie przeliczane przez węzły. Wyzwalacze blokują UPDATE/DELETE. | Właściciel bazy mógłby wyłączyć wyzwalacz. Węzły to wykryją, bo ich lokalny stan się nie zgodzi, a poświadczenia z innym skrótem są zapisywane jako „inny skrót”. |
| Nadużycie kranu (sybil) | Raz na 20 h na konto, maks. 3 konta z jednego IP na dobę, maks. 300 wypłat dziennie w całej sieci, limit zakładania kont (5/min/IP). | Ktoś z wieloma adresami IP dostanie więcej tokenów testowych, które nic nie są warte. |
| Złośliwe poświadczenia węzłów | Serwer sprawdza podpis węzła i dowód pracy. Liczą się tylko węzły z przyjętą pracą AI. Poświadczenie innego skrótu jest zapisywane (`matches = false`), a odrzucenie bloku przez uprawniony węzeł oznacza blok jako sporny i wstrzymuje ostateczność kolejnych. | Klucz węzła rejestruje się według zasady „pierwszy wygrywa” (TOFU). Kto zna id węzła z przyjętą pracą i zarejestruje klucz przed nim, przejmuje jego uprawnienie do poświadczania. Może wtedy poświadczać tylko prawdziwy skrót bloku albo blokować ostateczność fałszywym sporem. Spór rozstrzyga właściciel ręcznie (SQL). |
| Spam i miejsce w bazie | Limity RPC (`myc_rl`), przelew 10/min na adres, poświadczenie 30/min na węzeł. Księga ma limit 300 000 transakcji, po nim emisja i przelewy stoją. `myc_wallet_gc` (codziennie) usuwa stare dni kranu i poświadczenia nieuprawnionych węzłów. | Księga rośnie o ok. 0,5 kB na transakcję, więc 300 000 transakcji to ok. 150 MB. Przed tym limitem trzeba dodać archiwum (eksport starych bloków do Storage). |
| Ujawnienie tożsamości | Adres jest powiązany publicznie tylko z pseudonimem (`myc_wallet_dir`). Id konta i IP kranu (skrót) nie są publiczne. | Historia adresu jest publiczna, jak w każdej księdze. |
| Pieniądze | Brak zakupu, wypłaty, giełdy i kursu. Token nie ma wartości. | — |

Zależność: Supabase oznacza rozszerzenie `pgsodium` jako przestarzałe. Jeśli zniknie, sprawdzanie podpisów na
serwerze trzeba przenieść do Edge Function. Węzły sprawdzają podpisy niezależnie od tego.

## Testy

- `tests/test_wallet.py` (CI): wektory RFC 8032 dla obu implementacji, poprawny blok, powtórka, podwójne wydanie,
  przekroczenie salda, podrobiony podpis, zmiana kwoty, zły korzeń Merkle, reguły emisji, dowód pracy, poprawny podpis
  poświadczenia.
- `supabase/tests/wallet_test.sql` (na prawdziwej bazie, w transakcji wycofywanej na końcu): zły podpis rejestracji,
  przejęcie klucza, ponowny kran, bezpośredni INSERT/UPDATE, powtórka, zmieniona kwota, cudzy klucz, podwójne wydanie,
  przekroczenie salda, stary znacznik czasu, łańcuch, nagłówek bloku, zmiana i usunięcie transakcji, poświadczenie bez
  dowodu pracy.
- `web/e2e-account/wallet.spec.ts` (Playwright, pokój e2e): dwa konta, klucz w IndexedDB tylko jako szyfrogram, kran,
  kopia zapasowa poza localStorage, przelew na pseudonim, eksplorator, brak naruszeń CSP. `WAIT_FINAL=1` czeka na
  ostateczność bloku.
- Węzeł: `MyceliumNode --wallet-selftest` (CI wydania).
