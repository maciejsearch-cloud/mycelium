# Pomysły – priorytety (aktualizowane przez cykl 24/7)

Ostatnia aktualizacja: 2026-11-01 (faza IDEAS). Kolejność = priorytet. Wszystko wyłącznie na prawdziwych danych
(bez Math.random, makiet i liczb zastępczych; strażnik w CI musi przejść, bramka nie dopuszcza regresji).
Punkt wyjścia: testy szkolne v1 (czysta grzybnia, żywa strona 01.11 04:13) = 111/191 dobrze, 23 źle, 57 „nie wiem”;
klasy 1–5 i 4-8: 50–79%, klasa 6: 1/18, klasa 7: 3/16 (7 błędnych). LM nadal v4 (ppl 30.16); kandydat v5 ppl 30.61 odrzucony.

## Do zrobienia (najpierw)
1. ✅ *(zrobione 01.11, #44–#46: test 111/23/57 → 113/1/77, dev 99/0/2 bez zmian)* **Testy szkolne: błędne → „nie wiem”** – przejrzeć 23 złe odpowiedzi (głównie kl. 7 i jednostki kl. 3), dodać
   bezpieczniki, które przy niepewnym rozbiorze mówią „nie wiem” zamiast zgadywać. Cel: 0 błędnych na dev, bez spadku „ok”.
2. **Testy szkolne kl. 6–7** – ułamki zwykłe i dziesiętne w zadaniach tekstowych, procent składany, proporcje,
   równania z jedną niewiadomą (ślad krok po kroku). Najpierw zamrożony zestaw dev, potem kod, pomiar przed/po.
3. **Jednostki kl. 3 (0/8)** – zamiana jednostek w zdaniach („ile centymetrów ma 2 m 5 cm”), czas zegarowy i kalendarz.
4. **Samouk z testów szkolnych** – samouk dostaje kategorie z najniższą trafnością (dev, nie test) jako cel nauki
   i układa podobne zadania z szablonów; wynik rundy na wykresie postępu w czasie.
5. **LM v5: dane rozumowania zamiast Wikipedii** – odłamek SFT z zadań szkolnych dev (odpowiedź liczona programem),
   bramka f32 bez zmian; mierzyć też E1 matematyka.

## Później
6. **Mówca w czacie globalnym: pytania z luk testów szkolnych** – kategorie z „nie wiem” jako tematy pytań do ludzi.
7. **Moc: koszt na kategorię** – ile CPU/GPU poszło na LM, rozbiór, portfel, samouka (z myc_moc), wykres dzienny.
8. **Portfel MYC-test: walidacja bloków przez węzły box1/box2** – stały licznik zweryfikowanych bloków na stronie.
9. **Kwantyzacja int8 modelu rozbioru** – szybsze ładowanie na telefonach (bramka porównuje role-F1).
10. **Więcej węzłów za darmo** – macierz zadań węzła w GitHub Actions (repo publiczne).

## Zrobione (skrót, od 18.10)
Czysta grzybnia (arytmetyka, ciągi, analogie z relacji, zadania tekstowe, gramatyka, geometria, jednostki szkolne);
testy szkolne v1 (ZPE, CC BY/CC BY-SA) z pomiarem przed/po; samouk z planem nauki (ciekawość, mniej Wikipedii);
mówca w czacie; Moc; Portfel MYC-test; LM v4; CSP bez jsDelivr; gitleaks w CI; publiczne repo.
