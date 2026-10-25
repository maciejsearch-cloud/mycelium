// Trafność według typu zadań (Ucz AI): model vs ludzie, zawsze z liczbą prób n i źródłem. Brak pomiaru = „brak pomiaru”.
import { useEffect, useState } from 'react'
import { Card } from './ui'
import { useI18n } from '../i18n'
import { typeOfQid, useBrain, type TaskType } from '../myc/brain'

export const TYPE_LABEL: Record<TaskType, [string, string]> = {
  mieszane: ['Mieszane', 'Mixed'],
  logiczne: ['Logiczne', 'Logic'],
  matematyczne: ['Matematyczne', 'Maths'],
  wzrokowe: ['Wzrokowe', 'Visual'],
  analityczne: ['Analityczne', 'Analytical'],
  językowe: ['Językowe', 'Language'],
  inne: ['Inne', 'Other'],
}

/** Dokąd trafiają odpowiedzi danego typu (docs/zadania.md). */
const FLOW: Record<Exclude<TaskType, 'mieszane'>, [string, string]> = {
  logiczne: ['pytania dla ludzi → konsensus → Weryfikuj/wiedza; kontrolne → zaufanie węzła; zadania programu → odłamek SFT logiki (przez bramkę)', 'human questions → consensus → Verify/knowledge; control → node trust; program tasks → logic SFT shard (through the gate)'],
  matematyczne: ['zaufanie węzła (myc_gold) i trudność dla ludzi; zadania z wynikiem programu → kandydat na odłamek SFT (przez bramkę)', 'node trust (myc_gold) and human difficulty; program-checked tasks → SFT shard candidate (through the gate)'],
  analityczne: ['jak matematyczne; tabele z prawdziwych faktów Wikidata (CC0)', 'like maths; tables from real Wikidata facts (CC0)'],
  wzrokowe: ['„czy to …?” → etykiety obrazów → model obrazów w przeglądarce i sesje FedAvg; obrazy kontrolne → zaufanie węzła', '“is this …?” → image labels → browser image model and FedAvg sessions; control images → node trust'],
  językowe: ['kategorie słów → model słów; rozbiór i znaczenia (Weryfikuj) → trening rozbioru i pamięć znaczeń', 'word categories → word model; parsing and meanings (Verify) → parser training and meaning memory'],
  inne: ['intencje (CLINC150) i czujniki (NAB) → modele w przeglądarce; fakty → pamięć wiedzy', 'intents (CLINC150) and sensors (NAB) → browser models; facts → knowledge memory'],
}

type Row = { model?: { acc: number; n: number; base?: number; what: string }; human?: { acc: number; n: number } }
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function TaskTypeStats() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [rb, setRb] = useState<{ f1: number; n: number } | null>()
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/rozbior/wyniki.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => setRb(w?.trained?.test?.role_f1 != null ? { f1: w.trained.test.role_f1, n: w.trained.test.role_n } : null), () => setRb(null))
  }, [])
  const rows: Record<string, Row> = {}
  const pc = b.logic?.per_category
  if (pc) {
    const v = Object.values(pc)
    const n = v.reduce((s, x) => s + x.n, 0)
    const c = v.reduce((s, x) => s + x.correct, 0)
    const base = v.reduce((s, x) => s + (x.baseline ?? 0) * x.n, 0)
    if (n) rows.logiczne = { model: { acc: c / n, n, base: base / n, what: b.logic!.model } }
  }
  for (const t of ['matematyczne', 'analityczne', 'wzrokowe'] as const) {
    const m = b.zad?.types[t]?.model
    if (m && m.acc != null && m.n) rows[t] = { model: { acc: m.acc, n: m.n, base: m.baseline, what: m.name } }
  }
  if (rb) rows.językowe = { model: { acc: rb.f1, n: rb.n, what: en ? 'parser role-F1, UD test' : 'rozbiór: role-F1, test UD' } }
  if (b.scores?.n.intent) rows.inne = { model: { acc: b.scores.intent, n: b.scores.n.intent, what: en ? 'intents (CLINC150 test), this browser' : 'intencje (test CLINC150), ta przeglądarka' } }
  for (const g of b.store.data.goldByType ?? []) {
    const t = typeOfQid(g.kind)
    const r = (rows[t] ??= {})
    const h = (r.human ??= { acc: 0, n: 0 })
    h.acc = (h.acc * h.n + g.correct) / (h.n + g.n || 1)
    h.n += g.n
  }
  const types = ['logiczne', 'matematyczne', 'wzrokowe', 'analityczne', 'językowe', 'inne'] as const
  return (
    <Card title={en ? 'Accuracy by task type' : 'Trafność według typu zadań'} className="mt-4">
      <div className="space-y-2.5" data-testid="type-stats">
        {types.map((t) => {
          const r = rows[t] ?? {}
          return (
            <div key={t} className="border-b border-white/5 pb-2 text-sm last:border-0" data-type-stat={t}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <b className="text-slate-200">{en ? TYPE_LABEL[t][1] : TYPE_LABEL[t][0]}</b>
                <span className="text-xs tabular-nums text-slate-400">
                  {en ? 'model' : 'model'}: {r.model ? <b className="text-spore">{pct(r.model.acc)}</b> : en ? 'no measurement' : 'brak pomiaru'}
                  {r.model && ` (n=${r.model.n}${r.model.base != null ? `, ${en ? 'always-same' : 'zawsze to samo'} ${pct(r.model.base)}` : ''})`}
                  {' · '}
                  {en ? 'people' : 'ludzie'}: {r.human && r.human.n ? <b className="text-violet">{pct(r.human.acc)}</b> : en ? 'no answers yet' : 'brak odpowiedzi'}
                  {r.human && r.human.n ? ` (n=${r.human.n})` : ''}
                </span>
              </div>
              {r.model && <div className="text-xs text-slate-500">{r.model.what}</div>}
              <div className="text-xs text-slate-500">
                {en ? 'Answers go to' : 'Odpowiedzi trafiają do'}: {en ? FLOW[t][1] : FLOW[t][0]}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {en
          ? 'People = answers of all nodes on control questions (myc_gold_by_type). Model numbers come from the files listed above; tasks never overlap the 2000-question LM gate.'
          : 'Ludzie = odpowiedzi wszystkich węzłów na pytaniach kontrolnych (myc_gold_by_type). Liczby modelu z plików opisanych wyżej; zadania nigdy nie pokrywają się z bramką 2000 pytań LM.'}
      </p>
    </Card>
  )
}
