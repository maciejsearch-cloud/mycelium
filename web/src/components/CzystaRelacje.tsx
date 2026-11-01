// „Naucz relacji” w zakładce Czysta grzybnia: zdania-relacje od ludzi (→ Weryfikuj), liczniki zatwierdzonych relacji
// i pytania zaproponowane przez mówcę i samouka (myc_rel_questions). Nic nie jest zatwierdzane automatycznie.
import { useEffect, useMemo, useState } from 'react'
import { Card } from './ui'
import { FACT_CONF, useBrain } from '../myc/brain'
import { scrub, trainConsent } from '../myc/answers'
import { REL_KINDS, loadRelQuestions, recognize, type RelKind, type RelQuestion } from '../myc/czystaRelacje'
import type { PureKB } from '../myc/czystaWiedza'

const KINDS = Object.keys(REL_KINDS) as RelKind[]
const fmt = (iso: string) => new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Amsterdam' })

export default function CzystaRelacje({ kb }: { kb?: PureKB }) {
  const b = useBrain()
  const [kind, setKind] = useState<RelKind>('dom')
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<string>()
  const [qs, setQs] = useState<RelQuestion[] | undefined>()
  const [qErr, setQErr] = useState<string>()
  useEffect(() => {
    loadRelQuestions().then(setQs, (e: Error) => setQErr(e.message))
  }, [])
  const rec = text.trim() ? recognize(text, kind) : null
  // zatwierdzone zdania-relacje w wiedzy (tylko prawda wg ludzi)
  const approved = useMemo(() => {
    const m = new Map<RelKind, { a: string; b: string; text: string }[]>()
    for (const f of kb?.facts ?? []) {
      if (f.truth !== 'tak') continue
      const r = recognize(f.text)
      if (r) m.set(r.kind, [...(m.get(r.kind) ?? []), { a: r.a, b: r.b, text: f.text }])
    }
    return m
  }, [kb])
  const submit = () => {
    const t = scrub(text.trim()).replace(/([^.!])$/, '$1.')
    if (!recognize(t, kind)) return setMsg(`To zdanie nie ma budowy ${REL_KINDS[kind].pattern} – popraw je albo wybierz inny rodzaj relacji.`)
    if (!trainConsent.get()) return setMsg('Nauka wyłączona na tym urządzeniu – nic nie zapisuję (przełącznik niżej, przy „Naucz ją faktu”).')
    b.teach('fact', t, 'tak')
    setText('')
    setMsg(`Dodane do Ucz AI → Weryfikuj: „${t}”. Analogia zadziała, gdy zdanie zatwierdzą inni (konsensus ≥ ${Math.round(FACT_CONF * 100)}%) i gdy w wiedzy będą co najmniej dwa zatwierdzone zdania tej budowy.`)
  }
  const answer = (q: RelQuestion) => {
    setKind(q.kind)
    setText(REL_KINDS[q.kind].starter?.(q.word.startsWith('w ') ? '' : q.word) ?? '')
    setMsg(`Odpowiadasz na: „${q.question}”. Napisz pełne zdanie, np. ${REL_KINDS[q.kind].examples[0]}`)
    document.getElementById('czysta-rel-input')?.focus()
  }
  return (
    <Card title="Naucz relacji (analogie)">
      <div data-testid="czysta-rel">
        <p className="mb-2 text-sm text-slate-400">
          Analogie typu „pies : buda = lis : ?” czysta grzybnia rozwiązuje tylko z <b>zatwierdzonych przez ludzi</b> zdań o tej samej budowie. Wybierz rodzaj relacji i napisz jedno pełne zdanie po polsku. Zdanie trafia do <b>Ucz AI → Weryfikuj</b>.
        </p>
        <div className="no-scrollbar -mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {KINDS.map((k) => (
            <button key={k} type="button" data-testid={`czysta-rel-kind-${k}`} onClick={() => setKind(k)} className={`chip shrink-0 whitespace-nowrap ${k === kind ? 'border-spore/50 text-spore' : 'text-slate-300'}`}>
              {REL_KINDS[k].label}
            </button>
          ))}
        </div>
        <p className="mb-2 text-xs text-slate-400">
          Budowa: <b className="text-slate-200">{REL_KINDS[kind].pattern}</b> · przykłady: {REL_KINDS[kind].examples.join(' ')}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="czysta-rel-input"
            data-testid="czysta-rel-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={REL_KINDS[kind].examples[1]}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/40 px-3 text-base text-slate-100 placeholder:text-slate-500 sm:text-sm"
          />
          <button type="button" className="btn-ghost min-h-11" onClick={submit} data-testid="czysta-rel-add">
            Dodaj do Weryfikuj
          </button>
        </div>
        {text.trim() && (
          <p className="mt-1.5 text-xs" data-testid="czysta-rel-check">
            {rec ? (
              <span className="text-spore">
                rozpoznano relację „{rec.kind}”: {rec.a} → {rec.b}
              </span>
            ) : (
              <span className="text-amber">jeszcze nie ma budowy {REL_KINDS[kind].pattern}</span>
            )}
          </p>
        )}
        {msg && (
          <p className="mt-2 text-sm text-slate-300" data-testid="czysta-rel-msg">
            {msg}
          </p>
        )}

        <div className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2" data-testid="czysta-rel-stats">
          {KINDS.map((k) => {
            const xs = approved.get(k) ?? []
            return (
              <div key={k} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5">
                <span className="text-slate-300">{REL_KINDS[k].label}: </span>
                <b className={xs.length >= 2 ? 'text-spore' : 'text-slate-400'}>{xs.length}</b>
                <span className="text-slate-500"> {xs.length >= 2 ? '· analogie możliwe' : xs.length === 1 ? '· potrzeba jeszcze jednego zdania' : '· brak zatwierdzonych zdań'}</span>
                {xs.length > 0 && <div className="mt-0.5 truncate text-slate-500">{xs.map((x) => x.text).join(' ')}</div>}
              </div>
            )
          })}
        </div>

        <h3 className="mb-1.5 mt-4 text-sm font-medium text-slate-200">Pytania od mówcy i samouka</h3>
        <p className="mb-2 text-xs text-slate-500">
          Grzybnia sama proponuje, o co zapytać – nigdy nie podaje odpowiedzi i niczego nie zatwierdza. Mówca zadaje je też w czacie globalnym (najwyżej jedno na 30 minut).
        </p>
        {qs === undefined && !qErr && <div className="skeleton h-16 rounded-xl" />}
        {qErr && <p className="text-sm text-slate-400">Nie wczytano pytań: {qErr}</p>}
        {qs && qs.length === 0 && <p className="text-sm text-slate-400">Brak pytań – mówca i samouk jeszcze niczego nie zaproponowali.</p>}
        {qs && qs.length > 0 && (
          <ul className="space-y-1.5" data-testid="czysta-rel-questions">
            {qs.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2 text-sm">
                <span className="min-w-0 flex-1 text-slate-200">{q.question}</span>
                <span className="chip text-[10px] text-slate-400" title={q.reason ?? ''}>
                  {q.proposer} · {q.kind} · {fmt(q.created_at)}
                  {q.voiced_at ? ' · zadane w czacie' : ''}
                </span>
                <button type="button" className="btn-ghost min-h-9 px-3 text-xs" onClick={() => answer(q)}>
                  Odpowiedz zdaniem
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
