# Grzybnia AI – mówca w czacie globalnym

Decyzja właściciela z 31.10.2026: grzybnia sama pisze w czacie globalnym mniej więcej co minutę, a ludzie uczą ją
zadawać pytania i odpowiadać.

## Jak to działa (bez węzłów, w bazie)
- `pg_cron` co minutę wywołuje `myc_speaker_tick()` (`supabase/myc_speaker.sql`). Funkcja pisze najwyżej jeden wpis
  na `interval_s` (domyślnie 60 s). Wpis ma w czacie typ `kind = 'ai'`, nazwę „Grzybnia AI” i plakietkę „AI · grzybnia”.
- Tekst składa **generator programu nauczania** `myc_spk_generate(level)` z jawnych list słów poziomu. Nie ma tu
  gotowych zdań udających AI. Każdy wpis ma zapisane tokeny, poziom i sposób powstania (`myc_speaker_posts.how`):
  - `losowe`: eksploracja, czyli losowe słowa i szyk;
  - `wyuczone`: forma, którą ludzie ocenili jako sensowną, albo poprawka z konsensusu;
  - `mutacja`: wyuczona forma z zamienionymi dwoma sąsiednimi słowami;
  - `rozbiór` (L0/L1): w 60% eksploracji zdanie z `myc_speaker_cands`, czyli z tych samych list słów,
    ale tylko takie, które przeszły ocenę modelu rozbioru LFG (GPL-3.0) i leksykonu: jeden korzeń,
    słowo pytające na początku, najwyżej jeden czasownik osobowy, zgoda osoby/liczby z zaimkiem,
    przyimek przed słowem w wymaganym przypadku, „się” przy czasowniku, najwyżej jedno samodzielne
    rzeczowne, średnia pewność ≥ 0,75. Pozostałe 40% zostaje losowe jako grupa kontrolna.
    Dane generuje `node web/scripts/speaker-candidates.mjs` → `supabase/myc_speaker_cands_data.sql`
    i `results/speaker/candidates.json`. Z wszystkich kombinacji przechodzi L0 23/112, L1 190/4800.
    To ocena modelu, nie ludzi – prawdziwą miarą są dopiero głosy (porównanie `rozbiór` vs `losowe`).
  Eksploatacja ma prawdopodobieństwo równe trafności poziomu (najwyżej 0,8).
- Poziomy:
  - **L0**: dwa słowa w dowolnym szyku („kto ja?”, „ja kto?”, „ile ja?”);
  - **L1**: krótkie pytania z worka słów pytajnika („ile ja lat?”, a z czasem „ile mam lat?”);
  - **L2**: pytanie, a w następnym takcie odpowiedź na nie. Odpowiedź pochodzi najpierw od ludzi (konsensus), inaczej
    jest złożona ze słów odpowiedzi;
  - **L3**: pytania o przypadki (kto/co/komu/gdzie) i zdania na odmianie imion z ćwiczeń logiki
    (`selfplay.PEOPLE`). Forma przypadka jest poprawna z prawdopodobieństwem 0,4 + 0,6·trafność.
- **Awans**: gdy ≥ 20 ocenionych wpisów poziomu (z ostatnich 60) ma ≥ 70% ocen „sensowne” (większość głosów osób
  ze zgodą na naukę). Awans trafia do dziennika moderacji (`speaker_level`). Spadku poziomu nie ma.

## Co mogą zrobić ludzie (pod każdym wpisem AI, konto czatu)
- ocenić wpis: sensowne / bez sensu;
- przypisać kategorię (pytanie/odpowiedź/stwierdzenie) i typ zadania (językowe, logiczne, matematyczne, analityczne,
  wzrokowe, inne);
- dodać etykiety (do 5);
- ułożyć słowa stuknięciami po kolei (działa na telefonie);
- wpisać poprawione zdanie albo odpowiedź na pytanie.

`myc_speaker_rate()` zapisuje jeden wiersz na osobę i wpis (`myc_speaker_votes`) ze skrótem konta (md5 z solą), bez IP.
Limit to 30 ocen na minutę.

## Od sygnału do nauki
- **Zgoda**: głos osoby z wyłączoną nauką (`myc_account_prefs.train_ok = false`) jest zapisany, ale nie wlicza się
  do trafności, form ani danych SFT.
- **Konsensus**, jak w Weryfikuj: ta sama poprawka, ten sam szyk albo ta sama odpowiedź od ≥ 2 różnych osób i ≥ 2/3
  zgłoszeń trafia do `myc_speaker_sft`. Poprawka i szyk zostają też formą wyuczoną generatora.
- **Odłamek**: `scripts/export_speaker_shard.py` buduje `sft-speaker-0001`, gdy jest ≥ 50 przykładów. Kontrola
  przecieku względem bramki działa jak przy innych odłamkach. Przy mniejszej liczbie odłamek nie powstaje.

## Koszt i porządek
- Wszystko działa w Postgresie. Nie ma Edge Function, węzłów ani zewnętrznego API.
- GC w każdym takcie usuwa wpisy AI bez ocen po 3 dniach, a wszystkie wpisy AI po 30 dniach. Konsensus i formy
  zostają w swoich tabelach.

## Sterowanie (Developer)
Panel „Grzybnia AI” w czacie globalnym wywołuje `myc_speaker_admin(action, value)`. Akcje: wstrzymaj/wznów, odstęp
(1–60 min), ustaw poziom, usuń wpisy AI, wyłącz i usuń mówcę. Każda akcja trafia do dziennika moderacji.
Pojedynczy wpis usuwa się zwykłym „usuń” w menu wiadomości.
