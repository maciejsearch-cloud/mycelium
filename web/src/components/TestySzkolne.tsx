import { useEffect, useMemo, useState } from 'react'
import { Card, Bar, Src } from './ui'
import type { PureAnswer } from '../myc/czystaWiedza'

/** Testy szkolne kl. 1–7: wyniki pomiaru na żywej stronie (przed / po) i zamrożone zadania do rozwiązania tutaj. */
type V = 'ok' | 'zle' | 'nie_wiem'
interface Cnt {
  n: number
  ok: number
  zle: number
  nie_wiem: number
}
interface Run {
  when: string
  label: string
  mode: string
  url: string | null
  file: string
  n: number
  ok: number
  zle: number
  nie_wiem: number
  per_grade: Record<string, Cnt>
  per_category: Record<string, Cnt>
}
interface Task {
  id: string
  grade: string
  category: string
  q: string
  gold: string[][]
  src: { title: string; url: string; author: string; licence: string; exercise?: string }
  res: Record<string, { v: V; a: string | null }>
}
export interface SzkolneWyniki {
  set: string
  sha256: string
  licence: string
  runs: Run[]
  lm: Run | null
  lm_note: string | null
  tasks: Task[]
}

const GRADE_PL = (g: string) => (g === '4-8' ? 'kl. 4–8 · polski' : `klasa ${g}`)
const CAT_PL: Record<string, string> = {
  arytmetyka: 'działania',
  zadania_tekstowe: 'zadania tekstowe',
  jednostki: 'jednostki',
  geometria: 'geometria',
  ulamki: 'ułamki',
  logika_ciagi: 'ciągi',
  czesci_mowy: 'części mowy',
  rodzaj: 'rodzaj',
  liczba: 'liczba',
  przypadki: 'przypadki (odmiana)',
}
const V_PL: Record<V, string> = { ok: 'dobrze', zle: 'źle', nie_wiem: 'nie wiem' }
const V_CLS: Record<V, string> = { ok: 'border-spore/30 text-spore', zle: 'border-rose-400/40 text-rose-300', nie_wiem: 'border-amber/30 text-amber' }
const frac = (c?: Cnt) => (c && c.n ? c.ok / c.n : 0)
const fmt = (iso: string) => new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' })
const goldText = (g: string[][]) => g.map((alt) => alt.join(' i ')).join(' albo ')

export default function TestySzkolne({ solve, ready }: { solve: (q: string) => PureAnswer | undefined; ready: boolean }) {
  const [w, setW] = useState<SzkolneWyniki | null | undefined>()
  const [grade, setGrade] = useState<string>()
  const [open, setOpen] = useState<Record<string, PureAnswer>>({})
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/szkolne/wyniki.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setW, () => setW(null))
  }, [])
  const grades = useMemo(() => (w ? [...new Set(w.tasks.map((t) => t.grade))].sort((a, b) => parseInt(a) - parseInt(b) || a.length - b.length) : []), [w])
  const before = w?.runs.find((r) => r.label === 'przed')
  const after = w ? [...w.runs].reverse().find((r) => r.label !== 'przed') : undefined
  const g = grade ?? grades[0]
  const tasks = w?.tasks.filter((t) => t.grade === g) ?? []

  return (
    <Card title="Testy szkolne · klasy 1–7" className="mt-4" right={w ? <span className="chip text-[11px] text-slate-400">{w.tasks.length} zadań · zestaw zamrożony</span> : undefined}>
      {w === undefined && <div className="skeleton h-24 rounded-xl" />}
      {w === null && <p className="text-sm text-slate-400" data-testid="szk-empty">Brak opublikowanego pomiaru – nic nie pokazuję.</p>}
      {w && (
        <div data-testid="szk">
          <p className="text-sm text-slate-300">
            Prawdziwe zadania z podręczników na zpe.gov.pl (MEN). Zestaw testowy zamrożono przed zmianami w kodzie – reguły stroiłam tylko na osobnym zbiorze dev. Pomiar: zakładka „Czysta grzybnia” na żywej stronie, w przeglądarce bez logowania. „Nie wiem” liczę osobno od błędów.
          </p>

          <div className="mt-3 grid grid-cols-3 gap-2 text-center" data-testid="szk-total">
            {[
              ['przed', before],
              ['po', after],
            ].map(([lab, r]) =>
              r && typeof r === 'object' ? (
                <div key={lab as string} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
                  <div className="eyebrow">{lab as string}</div>
                  <div className={`font-display text-2xl ${lab === 'po' ? 'text-spore' : 'text-slate-300'}`}>
                    {r.ok}/{r.n}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {r.zle} źle · {r.nie_wiem} nie wiem
                  </div>
                </div>
              ) : null,
            )}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2" data-testid="szk-lm">
              <div className="eyebrow">LM grzybni</div>
              {w.lm ? (
                <>
                  <div className="font-display text-2xl text-slate-300">
                    {w.lm.ok}/{w.lm.n}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {w.lm.zle} źle · {w.lm.nie_wiem} nie wiem
                  </div>
                </>
              ) : (
                <div className="mt-1 text-[11px] text-amber">brak pomiaru{w.lm_note ? ` – ${w.lm_note}` : ''}</div>
              )}
            </div>
          </div>

          <table className="mt-4 w-full text-sm" data-testid="szk-grades">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-1 font-medium">klasa</th>
                <th className="py-1 font-medium">przed</th>
                <th className="py-1 font-medium">po</th>
              </tr>
            </thead>
            <tbody>
              {grades.map((k) => {
                const b = before?.per_grade[k]
                const a = after?.per_grade[k]
                return (
                  <tr key={k} className="border-t border-white/[0.06]" data-testid="szk-grade" data-grade={k}>
                    <td className="py-1.5 pr-2 text-slate-200">{GRADE_PL(k)}</td>
                    <td className="w-[30%] py-1.5 pr-2 text-slate-400">{b ? `${b.ok}/${b.n}` : '–'}</td>
                    <td className="w-[38%] py-1.5">
                      {a ? (
                        <>
                          <div className="text-slate-100">
                            {a.ok}/{a.n} <span className="text-[11px] text-slate-500">· {a.zle} źle</span>
                          </div>
                          <Bar value={frac(a)} />
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {after && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-slate-200">Wyniki według kategorii</summary>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2" data-testid="szk-cats">
                {Object.entries(after.per_category).map(([c, a]) => (
                  <li key={c} className="flex justify-between rounded-lg border border-white/[0.06] px-2 py-1">
                    <span className="text-slate-300">{CAT_PL[c] ?? c}</span>
                    <span className="text-slate-400">
                      {before?.per_category[c] ? `${before.per_category[c].ok} → ` : ''}
                      <b className="text-slate-100">{a.ok}</b>/{a.n}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-4">
            <div className="eyebrow mb-2">Zadania</div>
            <div className="flex flex-wrap gap-1.5" role="tablist">
              {grades.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={k === g} onClick={() => setGrade(k)} className={`chip min-h-9 ${k === g ? 'border-spore/40 text-spore' : 'text-slate-400'}`} data-testid="szk-tab">
                  {GRADE_PL(k)}
                </button>
              ))}
            </div>
            <ul className="mt-3 space-y-2" data-testid="szk-tasks">
              {tasks.map((t) => {
                const last = after ? t.res[after.label] : undefined
                const live = open[t.id]
                return (
                  <li key={t.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3" data-testid="szk-task" data-id={t.id}>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="chip text-slate-400">{CAT_PL[t.category] ?? t.category}</span>
                      {last && <span className={`chip ${V_CLS[last.v]}`}>pomiar: {V_PL[last.v]}</span>}
                    </div>
                    <p className="mt-1.5 break-words text-sm text-slate-200">{t.q}</p>
                    <div className="mt-1 text-xs text-slate-400">odpowiedź z podręcznika: {goldText(t.gold)}</div>
                    <Src className="mt-1">
                      <a href={t.src.url} target="_blank" rel="noreferrer" className="underline decoration-dotted">
                        {t.src.title}
                        {t.src.exercise ? `, ${t.src.exercise}` : ''}
                      </a>{' '}
                      · {t.src.author} · {t.src.licence}
                    </Src>
                    <button
                      type="button"
                      className="btn-ghost mt-2 min-h-11"
                      disabled={!ready}
                      onClick={() => {
                        const r = solve(t.q)
                        if (r) setOpen((o) => ({ ...o, [t.id]: r }))
                      }}
                      data-testid="szk-solve"
                    >
                      {ready ? 'Rozwiąż tutaj' : 'Rozwiąż tutaj (czekam na model rozbioru)'}
                    </button>
                    {live && (
                      <div className="mt-2 rounded-lg border border-white/[0.06] bg-ink/30 p-2" data-testid="szk-live">
                        <div className={`font-display text-lg ${live.answer != null ? 'text-glow' : 'text-amber'}`} data-testid="szk-live-answer">
                          {live.answer ?? 'nie wiem'}
                        </div>
                        {live.method && <span className="chip text-[11px] text-slate-300">{live.method}</span>}
                        <ol className="mt-2 space-y-1 text-xs" data-testid="szk-trace">
                          {live.trace.map((s, i) => (
                            <li key={i} className="flex gap-2">
                              <span className={`chip h-fit shrink-0 text-[10px] ${s.kind === 'brak' ? 'border-amber/30 text-amber' : s.kind === 'wniosek' ? 'border-spore/30 text-spore' : 'text-slate-400'}`}>{s.kind}</span>
                              <span className="min-w-0 break-words text-slate-300">{s.text}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>

          <p className="mt-3 text-[11px] text-slate-500" data-testid="szk-meta">
            {before && `przed: ${fmt(before.when)}`}
            {after && ` · po: ${fmt(after.when)}`} · zestaw {w.set}, sha256 {w.sha256.slice(0, 12)}… · {w.licence}
          </p>
        </div>
      )}
    </Card>
  )
}
