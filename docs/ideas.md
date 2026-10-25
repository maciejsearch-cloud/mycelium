# Pomysły – priorytety (aktualizowane przez cykl 24/7)

Ostatnia aktualizacja: 2026-10-18 (faza IDEAS). Kolejność = priorytet. Wszystko wyłącznie na prawdziwych danych
(bez Math.random, makiet i liczb zastępczych; strażnik w CI musi przejść, bramka nie dopuszcza regresji).

## Do zrobienia (najpierw)
1. **Więcej węzłów za darmo** – cron węzła w GitHub Actions jako macierz kilku równoległych zadań
   (repo publiczne = darmowe minuty), każdy z osobną dzierżawą zadań; liczba aktywnych węzłów widoczna w czasie.
2. **Niezależny publiczny test** – ocena każdej wersji modelu na oficjalnych zbiorach testowych (np. MNIST/Fashion test 10k)
   z sumą SHA-256 pliku testowego i skryptem, który każdy może uruchomić; wynik i hash na stronie Weryfikacja.
3. **Czat: „nie wiem” → pytanie do nauki** – gdy czat nie ma źródła, proponuje użytkownikowi dopisanie faktu;
   odpowiedź trafia do kolejki „Ucz AI” i jest zatwierdzana konsensusem kilku węzłów.
4. **Wagi zaufania na widoku** – strona/karta z wagą zaufania każdego węzła (z `consensus.ts`) i jej historią na wykresie;
   pytania kontrolne pokazują, skąd waga się wzięła.
5. **Seria sesji (jak w Pi)** – licznik dni z aktywną sesją liczony z prawdziwych logów sesji + opcjonalne
   przypomnienie PWA o ponownym starcie sesji (więcej aktywnych węzłów = szybsza nauka).

## Później
6. **Rejestr wkładu poza łańcuchem** (przygotowanie pod L2E) – punkty „oczekujące”, zatwierdzane dopiero gdy węzły
   potwierdzą prawdziwość danych; bez tokena, dopóki nie ma decyzji właścicielki projektu, programu escrow/vesting i analizy MiCA.
7. **Klucz API dla endpointów zapisujących** (`/api/ai/runs`) – nagłówek `X-API-Key` z env.
8. **Kwantyzacja int8 modeli** – mniejsze modele dla telefonów i słabych węzłów (bramka porównuje dokładność).
9. **Detekcja anomalii na strumieniu MQTT** – błąd prognozy > k·σ → temat `mycelium/alerts/<id>`.
10. **Obraz Docker + compose** (API + mosquitto) do jednoklikowego uruchomienia.

## Zrobione (skrót)
Utwardzenie MQTT i API; captcha (6 rodzajów) z pytaniami kontrolnymi; sesja obliczeniowa WebGPU/WASM z FedAvg;
bramka bez regresji z niezależną oceną; weryfikacja postępu (surowe dane + skrypt); czat zawsze odpowiadający
(fakty, Wikisłownik, Wikidata, model grzybni); stałe węzły z nadzorcą; PWA, zaproszenia QR, ranking (#9–#38); strażnik demo na żywo co 6 h (live-watch.yml).
