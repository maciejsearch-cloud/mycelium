import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { SB_KEY, SB_URL } from '../myc/store'
import { ago } from './TimeChart'
import { Card } from './ui'

// „Czego grzybnia chce się teraz nauczyć i dlaczego” – plan samouka z myc_lm_curriculum (scripts/samouk_run.py):
// pomiar na stałych zbiorach próbnych (poza treningiem), bandyta UCB, uzasadnienie z liczb. Bez planu = pusty stan.
type Why = { err: number; uncertainty: number; progress: number | null; explore: number; value: number; share: number; jobs: number; reason: string }
type St = { acc: number; p_right: number; n: number; progress: number | null; cand_acc?: number }
type Plan = {
  id: number
  at: string
  stats: Record<string, St>
  alloc: Record<string, number>
  why: Record<string, Why>
  wiki_jobs: number
  measured: { base: { version: number }; cand: { id: number; status: string } | null }
}
const NAME: Record<string, [string, string]> = {
  logika: ['logika', 'logic'],
  matematyka: ['matematyka', 'maths'],
  przypadki: ['przypadki (kogo? czego?…)', 'grammatical cases'],
  role: ['role w zdaniu (podmiot, orzeczenie…)', 'sentence roles'],
}
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

export function Samouk() {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [plans, setPlans] = useState<Plan[] | undefined>()
  useEffect(() => {
    const load = () =>
      fetch(`${SB_URL}/rest/v1/myc_lm_curriculum?select=id,at,stats,alloc,why,wiki_jobs,measured&order=id.desc&limit=10`, { headers: H })
        .then((r) => (r.ok ? (r.json() as Promise<Plan[]>) : Promise.reject(new Error(String(r.status)))))
        .then(setPlans, () => setPlans([]))
    load()
    const t = setInterval(load, 120_000)
    return () => clearInterval(t)
  }, [])
  const p = plans?.[0]
  const total = p ? Object.values(p.alloc).reduce((a, b) => a + b, 0) + p.wiki_jobs : 0
  const types = p ? Object.keys(p.why).sort((a, b) => p.why[b].jobs - p.why[a].jobs) : []
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <Card title={en ? 'What the mycelium wants to learn now – and why' : 'Czego grzybnia chce się teraz nauczyć i dlaczego'} className="mb-4">
      <div data-testid="samouk">
        {!plans ? (
          <p className="text-sm text-slate-500">…</p>
        ) : !p ? (
          <p className="text-sm text-slate-400" data-testid="samouk-empty">
            {en ? 'No study plan yet – it appears after the first self-measurement of the language model.' : 'Brak planu nauki – pojawi się po pierwszym samodzielnym pomiarze modelu językowego.'}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-400">
              {en ? 'Plan' : 'Plan'} #{p.id} · {ago(p.at, lang)} · {en ? 'measured on' : 'pomiar'} LM v{p.measured.base.version}
              {p.measured.cand ? ` + ${en ? 'candidate' : 'kandydat'} #${p.measured.cand.id}` : ''} · {en ? 'held-out probe sets, never trained on' : 'stałe pytania próbne, nigdy w treningu'}
            </p>
            <div className="space-y-2">
              {types.map((t) => {
                const w = p.why[t]
                const s = p.stats[t]
                return (
                  <div key={t} className="rounded-xl border border-white/10 p-3" data-testid={`samouk-${t}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium text-slate-100">{NAME[t]?.[en ? 1 : 0] ?? t}</span>
                      <span className="text-xs text-slate-400">
                        {w.jobs}/{total} {en ? 'training jobs' : 'zadań treningu'} · {en ? 'accuracy' : 'trafność'} {pct(s.acc)} ({s.n})
                        {s.progress != null ? ` · ${en ? 'progress' : 'postęp'} ${s.progress >= 0 ? '+' : ''}${(s.progress * 100).toFixed(1)} pp` : ''}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full bg-gradient-to-r from-spore-500 to-sky-400" style={{ width: `${(w.jobs / Math.max(1, total)) * 100}%` }} />
                    </div>
                    <p className="mt-2 text-sm text-slate-300">{w.reason}</p>
                  </div>
                )
              })}
              <div className="rounded-xl border border-dashed border-white/10 p-3 text-xs text-slate-400" data-testid="samouk-wiki">
                {en ? 'Wikipedia (general language, with teacher distillation)' : 'Wikipedia (ogólny język, z destylacją)'}: {p.wiki_jobs}/{total}{' '}
                {en ? 'jobs' : 'zadań'}
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              {en
                ? 'Choice: UCB bandit over task types – error, uncertainty, measured learning progress and an exploration bonus. A new version is published only after the independent f32 gate (2000 questions, no regression).'
                : 'Wybór: bandyta UCB nad typami zadań – błąd, niepewność, zmierzony postęp i premia za eksplorację. Nowa wersja trafia do użytku tylko po niezależnej bramce f32 (2000 pytań, bez regresji).'}
            </p>
          </>
        )}
      </div>
    </Card>
  )
}
