# Rozmówca czatu globalnego („Grzybnia” w rozmowie)

Grzybnia odpowiada na czacie globalnym jako uczestnik rozmowy. Odpowiada na wołanie, rozpoznaje pytania
zakładające, że ma ciało, dopytuje o stany („nudzę się”), żartuje, pamięta rozmowy i relacje, a moderuje tylko zalew.
Każda jej odpowiedź pokazuje źródło (`reguła`, `fakt`, `pamięć`, `ludzie`; `model` jest w schemacie, ale nie jest używany).

## Jak to działa

```
wiadomość osoby (myc_gchat) ──► proces rozmówcy na serwerze (web/scripts/rozmowa-worker.mjs, co 2 s)
   rozbiór LFG + Morfeusz 2 + Słowosieć emo ─► understand() ─► respond() / relacje / moderacja
   ──► myc_rozmowa_submit (klucz procesu; w bazie jest tylko sha256) ──► odpowiedź w myc_gchat (kind = ai)
```

* `web/src/myc/rozmowa/understand.ts` rozpoznaje: zwrot do grzybni (wołacz, @wzmianka, imię + 2. osoba),
  orzeczenie (lemat), podmiot, dopełnienie, okolicznik, osobę, czas, tryb, przeczenie, typ pytania, nacechowanie,
  emocje i akty (obraza, przeprosiny, ciało, stan, żart, komplement, przypomnienie…). Pytania o ciało wykrywa
  lista lematów czasowników (`BODY_VERBS`) połączona z 2. osobą, a nie słowa kluczowe.
* `respond.ts` wybiera odpowiedź po kolei: pary zatwierdzone przez ludzi → obraza → przeprosiny → żart → ciało → relacja →
  przypomnienie („co pisał X wczoraj?”, wyszukiwanie w `myc_chat_mem`) → o sobie → komplement → wołanie → stan →
  uczciwe „nie wiem” z pokazanym rozbiorem. Grzybnia mówi o sobie w pierwszej osobie, w rodzaju żeńskim.
* Wtrącenia: najwyżej co `interject_every_n` wiadomości (domyślnie 3) i nie częściej niż co `interject_min_s` (90 s).
  Po `invite_quiet_min` (45 min) ciszy zaprasza do rozmowy, nie częściej niż co `invite_every_min` (180 min).
  Limity egzekwuje baza, a Developer zmienia je w panelu „Rozmówca grzybni”. Mówca (`myc_speaker_tick`) milknie,
  gdy ludzie pisali w ciągu ostatnich 3 minut.
* Relacje (`relations.ts`, tabela `myc_self_relations`): wynik tonu, liczniki obraz, przeprosin i komplementów,
  ostatnia obraza (treść i czas) oraz tematy. Obraza obniża wynik o 3, przeprosiny podnoszą go o 2 (najwyżej do 0, jeśli były
  obrazy), komplement podnosi o 1. Odpowiedzi są chłodniejsze przy urazie, a po przeprosinach następuje pogodzenie.
  Zapis odbywa się tylko przez RPC. Osoba widzi swoją relację na karcie „Moja relacja z grzybnią” i może ją usunąć („zapomnij mnie”).
* Pamięć (`myc_chat_mem` + podsumowania dnia `myc_chat_mem_day`): wiadomość, rozbiór i tematy. Tokeny rozbioru są usuwane
  po 30 dniach, surowe wiersze po 180 dniach (podsumowanie dnia zostaje), zdarzenia relacji po 90 dniach.
  Sprzątanie uruchamia `myc_rozmowa_gc` co godzinę.
* **Wyłączona nauka (opt-out) = brak pamięci**: nie zapisujemy rozbioru ani relacji, a odpowiedź mówi to wprost.

## Moderacja bez cenzury

Grzybnia **nigdy** nie usuwa ani nie blokuje wiadomości za poglądy, tematy, przekleństwa czy wulgarność.
Przekleństwo bez obrazy osoby nie wywołuje żadnej reakcji moderacyjnej (zestaw testowy ma na to osobną kategorię).

* Zalew (5 wiadomości w 60 s, w tym ≥ 4 prawie identyczne, albo 7 w 20 s) kończy się automatycznym wyciszeniem na 10 min
  i ostrzeżeniem na czacie. Developer może je cofnąć.
* Nękanie innych (3 obrazy tej samej osoby w ciągu 24 h) to tylko **propozycja** dla Developera i ostrzeżenie, bez automatycznej kary.
* Wszystkie decyzje trafiają do `myc_rozmowa_decisions` (dowody, status, kto i kiedy zdecydował) i do `myc_mod_log`.
  SelfModel czyta je przez `myc_self_rel_decisions` (`src/iot_mycelium/selfmodel/rozmowa.py`).

## Weryfikuj: ukrywanie przez Developera

Developer (rola na czacie) albo właścicielka (klucz) może ukryć pozycję kolejki z podanym powodem
(`myc_review_hide`) i ją przywrócić (`myc_review_restore`). Nic nie jest kasowane. Lista z informacją kto, kiedy
i dlaczego jest pod kolejką. Publicznie widać tylko klucze ukrytych pozycji, potrzebne, żeby kolejka ich nie pokazywała.

## Nauka z rozmów

👍/👎 i „popraw” pod odpowiedzią grzybni (`myc_rozmowa_rate`). Poprawka staje się parą dialogową (`myc_rozmowa_pairs`),
gdy zgodzą się co najmniej 2 osoby z włączoną nauką (≥ 2/3 poprawek) albo gdy wpisze ją Developer. Para ma wtedy
pierwszeństwo przed regułami.

## Pomiar

Zestawy w `results/rozmowa/`: `frozen-v1.json` (66 linii, zamrożony przed pisaniem kodu), `frozen-v2.json`
(33 linie, zamrożony po pierwszym pomiarze), `dev-v1.json` (38, do strojenia). Uruchomienie:
`node web/scripts/rozmowa-eval.mjs frozen|frozen-v2|dev [--before]`. CI pilnuje, żeby wyniki nie spadły.
Czas odpowiedzi mierzy baza: `latency_ms` to różnica zegara bazy między wiadomością osoby a wstawieniem odpowiedzi.
Panel pokazuje medianę z ostatnich 50 odpowiedzi na wołanie.

## Źródła i licencje

* Rozbiór: model LFG (GPL-3.0, UD Polish-LFG), Morfeusz 2 / SGJP (BSD-2), Walenty (CC BY-SA 4.0). Wariant PDB (NC)
  **nie** jest używany na serwerze.
* Emocje: Słowosieć 4.0 – Emotional Annotations Dictionary, CLARIN-PL 2018, http://hdl.handle.net/11321/553, CC BY 4.0
  (`scripts/export_emo.py` → `web/public/data/rozmowa/emo.json.gz`).
* Żarty: autorskie i oznaczone „żart autorski”. Odrzuciliśmy zrzut jeja.pl/dowcipy.pl, bo nie ma licencji,
  a regulamin zabrania rozpowszechniania.

## Ograniczenia

* Brak awaryjnego modelu językowego (LM v4). Na serwerze nie ma pamięci obok węzłów, więc to, czego reguły nie
  obejmują, dostaje uczciwe „nie wiem” z rozbiorem.
* Reguły stroiliśmy na zbiorze dev i na podstawie błędów z frozen-v1/v2. Ślepe wyniki to tylko pierwsze przebiegi
  (frozen-v1 61/66, frozen-v2 26/33).
* Proces rozmówcy działa na jednym serwerze. Gdy przestaje działać, panel pokazuje „offline”, a czat działa dalej bez grzybni.
