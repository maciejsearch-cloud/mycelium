# SelfModel – „rozumiemy, że jesteśmy”, ale tylko w liczbach, które da się sprawdzić

Status: interfejsy (`src/iot_mycelium/selfmodel/base.py`). Implementacja w kolejnych PR.

## Po co (ocena kosztu i zysku, 1.11.2026)

Zmierzone na boxie przed decyzją:

- LM v4 na 2000 pytaniach stałego testu: średnia surowa pewność wybranej odpowiedzi **48,5%**, a trafność **35,7%**
  (ECE 0,128). Pewność prawie nie odróżnia dobrych odpowiedzi od złych (pewność 0,8 → trafność 44%).
  Jedna temperatura T = 2,8 dopasowana na połowie pytań daje na drugiej połowie ECE **0,031** (było 0,122).
- Pytania próbne samouka (po 40 na typ): trafność 22,5–32,5% przy zgadywaniu 25%, czyli przedział 95% ±13–14 pkt.

Wniosek: użyteczny SelfModel to **skalibrowana pewność w każdej domenie, sprawdzana co rundę z pomiarem**.
Etykiety typu „przetwarzam X” są tanie, ale same w sobie niczego nie mierzą – są tylko jako stan (`ClaimKind.STATE`)
wyprowadzony z prawdziwego planu samouka. „Fragment z kręgu Z” – odłożone razem z kręgami (2–3 węzły).

## Model danych

| Typ | Co to jest |
|---|---|
| `Measurement` | wynik w domenie (`lm/logika`, `lm/definicje`, `czysta/klasa-3`): n, dobrze, źle, „nie wiem”, pewność surowa i skalibrowana, ECE, odcisk danych |
| `Claim` | twierdzenie o sobie z wartością, przedziałem 95% (Wilson) i n; przedział to przewidywanie dla następnego pomiaru |
| `Check` | twierdzenie z poprzedniej migawki kontra bieżący pomiar: `zgodne` / `niezgodne` / `brak_nowych_danych` / `za_malo_danych` |
| `Decision` | własna decyzja (przydział zadań samouka) i jej zmierzony skutek (postęp, los kandydata) |
| `Snapshot` | wszystko powyżej + stan (architektura, wersje) + parametry kalibracji; zapis do bazy |

`brak_nowych_danych`: gdy odcisk danych jest ten sam (ta sama wersja modelu i te same pytania), zgodność byłaby
pozorna – tak to oznaczamy zamiast liczyć jako sukces.

## Interfejsy

- `EvidenceSource.collect() -> list[Measurement]` – pusta lista, gdy brak danych (nigdy wartości zastępcze).
- `Calibrator.fit/probs/params` – dopasowanie na jednej połowie, ocena na drugiej (odłożonej).
- `SelfModel.observe/record/claims/check/snapshot`.
- `SelfModelStore.latest/save` – odczyt publiczny, zapis tylko z uprawnieniami właściciela.

## Kontrola dostępu

Migawki: tabela z odczytem publicznym (RLS: select dla anon), bez praw zapisu dla anon/authenticated –
pisze tylko właściciel (Management API, jak samouk). Reszta sieci (węzły, strona) czyta.

## Relacje (punkt rozszerzenia)

Pamięć relacji z użytkownikami (ton, historia rozmów) buduje moduł czatu w osobnej tabeli `myc_self_relations`.
SelfModel ma na nią `RelationsSource` i pole `Snapshot.relations`, ale do publicznej migawki trafia tylko stan
źródła (czy istnieje, ile wierszy widzi klucz publiczny) – nigdy treść relacji z konkretną osobą. Panel na stronie
pokazuje uczciwy pusty stan, dopóki tabeli nie ma.
