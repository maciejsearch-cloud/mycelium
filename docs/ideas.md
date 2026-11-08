# Pomysły – priorytety (aktualizowane przez cykl 24/7)

Ostatnia aktualizacja: 2026-11-08 (faza IDEAS). Kolejność = priorytet. Wszystko wyłącznie na prawdziwych danych
(bez Math.random, makiet i liczb zastępczych; strażnik w CI musi przejść, bramka nie dopuszcza regresji).
Stan 08.11 03:55 CET: Supabase REST/Realtime/Storage zwraca HTTP 402 (`exceed_egress_quota`, `exceed_cached_egress_quota`)
od 07.11 ~18:13 – trening LM, portfel, P71 i backend czatu stoją (węzły w backoffie, #58). Baza 110 MB (OK), ale bucket
`myc-models` ma 2221 plików / 1439 MB (limit darmowy 1 GB): har 537 MB (816), words 348 MB (525), intent 337 MB (607),
rozbior 103 MB (30), fashion 82 MB (180), lm 30 MB (42), taxo 3 MB (21). Większość to stare wersje modeli.

## Do zrobienia (najpierw)
1. **Egress i Storage pod limitem darmowym** (blokuje wszystko inne) – (a) GC starych wersji w `myc-models`: zostawić
   bieżącą + poprzednią wersję każdego modelu i wszystko, do czego odwołuje się `myc_models`; kopia w /workspace/backups
   przed kasowaniem; cel < 300 MB. (b) Opublikowane wagi (`public/…`) serwować z GitHub Pages (repo demo, pliki
   zbudowane) zamiast z Supabase Storage; węzły i przeglądarka pobierają z Pages, Supabase tylko jako zapas.
   (c) Pamięć podręczna z ETag/If-None-Match w `lmwork.py` i `web/src/mesh/net.ts`, żeby ten sam plik nie był
   pobierany co rundę. (d) Licznik egressu na zakładce Moc (z prawdziwych rozmiarów pobrań). Pomiar: bajty na rundę przed/po.
2. **Testy szkolne kl. 6–7** – ułamki zwykłe i dziesiętne w zadaniach tekstowych, procent składany, proporcje,
   równania z jedną niewiadomą (ślad krok po kroku). Generatory `ułamki tekstowe` i `procent składany` oraz odłamek
   `sft-math-0003` (ziarno 3000) są gotowe (proporcje w #59); nadal brak zamrożonego zestawu dev i śladu krok po kroku.
3. **Samouk z testów szkolnych** – samouk dostaje kategorie z najniższą trafnością (dev, nie test) jako cel nauki
   i układa podobne zadania z szablonów; wynik rundy na wykresie postępu w czasie.
4. **LM v5: dane rozumowania zamiast Wikipedii** – odłamki SFT `sft-math-0001` (1000), `sft-math-0002` (1400,
   jednostki + proporcje) i `sft-math-0003` (ułamki tekstowe + procent składany, ziarno 3000) gotowe; po odblokowaniu
   Supabase runda v5 na nich, bramka f32 bez zmian; mierzyć E1 matematyka.
5. **Jednostki kl. 3** – zamiana jednostek w zdaniach (generatory z #59); czas zegarowy i kalendarz nadal brak.

## Później
6. **Mówca w czacie globalnym: pytania z luk testów szkolnych** – kategorie z „nie wiem” jako tematy pytań do ludzi.
7. **Moc: koszt na kategorię** – ile CPU/GPU poszło na LM, rozbiór, portfel, samouka (z myc_moc), wykres dzienny.
8. **Portfel MYC-test: walidacja bloków przez węzły box1/box2** – stały licznik zweryfikowanych bloków na stronie.
9. **Kwantyzacja int8 modelu rozbioru** – szybsze ładowanie na telefonach i mniej egressu (bramka porównuje role-F1).
10. **Więcej węzłów za darmo** – macierz zadań węzła w GitHub Actions (repo publiczne) – dopiero gdy egress pod kontrolą.

## Zrobione (skrót, od 18.10)
SFT matematyka: sft-math-0001 (1000), 0002 (1400, #59) i 0003 (ułamki tekstowe + procent składany); bezpieczniki szkolne → „nie wiem” (#44–#46); backoff przy 402 (#58);
Puzzle 71 (SCHED_IDLE, #55); SelfModel, rozmowy Grzybni, int8 dla węzłów (#47–#56).
Czysta grzybnia (arytmetyka, ciągi, analogie z relacji, zadania tekstowe, gramatyka, geometria, jednostki szkolne);
testy szkolne v1 (ZPE, CC BY/CC BY-SA) z pomiarem przed/po; samouk z planem nauki (ciekawość, mniej Wikipedii);
mówca w czacie; Moc; Portfel MYC-test; LM v4; CSP bez jsDelivr; gitleaks w CI; publiczne repo.
