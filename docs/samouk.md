# Samouk – grzybnia sama wybiera, czego się uczyć (od 1.11.2026)

Decyzja właścicielki (31.10): mniej Wikipedii, więcej samodzielnego rozumowania i zadawania pytań; model sam ustala,
czego chce się uczyć.

* **Skład rundy LM** (12 zadań): 3 na Wikipedii (z destylacją, `MYC_LM_WIKI_JOBS`), 9 na zadaniach samouka według planu
  z `myc_lm_curriculum` (wcześniej: ~10 z 12 na Wikipedii). Bez planu (lub planu starszego niż doba) – dawny skład.
* **Typy zadań** (`src/iot_mycelium/mesh/samouk.py`), każde z odpowiedzią liczoną programem: logika (`selfplay`),
  matematyka (`zadania`), przypadki („na jakie pytanie odpowiada słowo…”, formy z Morfeusza 2/SGJP, BSD-2),
  role w zdaniu (podmiot, orzeczenie, dopełnienie, okolicznik – rola znana z konstrukcji zdania).
* **Pomiar** – stałe zbiory próbne (ziarno 7, 40 pytań na typ), nigdy w treningu; wybór 1 z 4 przez log-prob jak
  w `zadania_run.py`. Postęp = trafność kandydata trenowanego wg planu − trafność opublikowanej wersji.
* **Wybór** – bandyta UCB: wartość = 0,5·błąd + 0,3·niepewność + 2·postęp + premia za eksplorację; softmax → 9 zadań,
  min. 1 na typ. Uzasadnienie każdego wyboru zapisane w planie i pokazane w karcie
  „Czego grzybnia chce się teraz nauczyć i dlaczego” (Weryfikacja, Węzeł).
* **Nowe pytania** – `scripts/samouk_run.py` (watchdog na boxie) układa po 256 nowych zadań na typ (nowe ziarna; bez
  zbiorów próbnych, rundy 1 Ucz AI, puli kontrolnej, hashy i 8-gramów bramki), zapis do `myc_lm_self`
  (zapis tylko właściciel, odczyt publiczny); węzeł sprawdza SHA-256 z zadania, z tabeli i z bajtów.
* **Bramka bez zmian**: publikacja tylko po niezależnym weryfikatorze f32 na 2000 pytaniach, bez regresji.
* Rozmiar: odłamki ~50 KB, `myc_samouk_gc()` trzyma tylko te z 3 ostatnich planów.
