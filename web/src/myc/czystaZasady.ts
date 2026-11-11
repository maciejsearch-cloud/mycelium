// Zasady nauki czystej grzybni – wartości z prawdziwego kodu i SQL (nie z opisu). Zgodność z plikami źródłowymi
// sprawdza w CI web/scripts/czysta-check.mjs: gdy ktoś zmieni próg w SQL/TS, a nie tutaj, lint się nie uda.
import { FACT_CONF, CONTROL_EVERY } from './brain'
import { OWNER_PRIOR, PRIOR } from './consensus'

export interface Rule {
  what: string
  value: string
  file: string
}
export const LEARN_RULES: Rule[] = [
  { what: 'Fakt / para z Ucz AI liczy się jako wiedza, gdy konsensus głosów daje prawdopodobieństwo co najmniej', value: `${Math.round(FACT_CONF * 100)}% (i ma ≥ 1 głos)`, file: 'web/src/myc/brain.ts (FACT_CONF)' },
  { what: 'Konsensus faktów: Dawid–Skene („one-coin”) – każdy głos ma wagę z trafności osoby; startowa trafność osoby (apriori Beta)', value: `Beta(${PRIOR[0]}, ${PRIOR[1]}) ≈ ${Math.round((PRIOR[0] / (PRIOR[0] + PRIOR[1])) * 100)}%; właściciel Beta(${OWNER_PRIOR[0]}, ${OWNER_PRIOR[1]}) ≈ ${Math.round((OWNER_PRIOR[0] / (OWNER_PRIOR[0] + OWNER_PRIOR[1])) * 100)}%`, file: 'web/src/myc/consensus.ts (PRIOR, OWNER_PRIOR)' },
  { what: 'Trafność osoby rośnie lub spada na pytaniach kontrolnych (odpowiedź zna program); pytanie kontrolne co', value: `${CONTROL_EVERY}. odpowiedź, waga ×2`, file: 'web/src/myc/brain.ts (CONTROL_EVERY), consensus.ts (GOLD_WEIGHT)' },
  { what: 'Odpowiedź czystej grzybni zatwierdzona („dobrze”) lub odrzucona („źle”) w Weryfikuj', value: '≥ 3 głosy i pewność ≥ 95% (albo ≤ 5%); głos właściciela rozstrzyga od razu', file: 'supabase/myc_answers.sql (myc_answer_vote)' },
  { what: 'Waga głosu osoby w Weryfikuj (z pytań kontrolnych)', value: '(trafne + 3) / (wszystkie + 4), w przedziale 55–90%', file: 'supabase/myc_answers.sql (myc_answer_vote)' },
  { what: 'Poprawka staje się wiedzą (strzępek „pytanie → odpowiedź”), gdy suma wag zgodnych poprawek', value: '≥ ln(0,9 / 0,1) ≈ 2,2 (np. 2–3 osoby z tą samą poprawką)', file: 'supabase/myc_answers.sql (myc_answer_vote)' },
  { what: 'Mówca w czacie globalnym awansuje na wyższy poziom', value: '≥ 20 ocenionych wpisów poziomu i ≥ 70% „sensowne”', file: 'supabase/myc_speaker.sql (myc_speaker_tick)' },
  { what: 'Poprawka formy mówcy staje się formą wyuczoną', value: '≥ 2 różne osoby z tą samą poprawką i ≥ 2/3 zgłoszeń', file: 'supabase/myc_speaker.sql' },
]
