import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { answerFacets, listAnswers, voteAnswer, type AFilter, type ChatAnswer } from '../myc/answers'
import { ownerKey } from '../myc/store'
import { Card } from './ui'
import { inConf, type InboxProps } from '../myc/inbox'

const INTENTS = ['pytanie', 'emocja', 'niezgoda', 'nauka', 'rozmowa', 'polecenie'] as const
const INTENT_EN: Record<string, string> = { pytanie: 'question', emocja: 'emotion', niezgoda: 'disagreement', nauka: 'teaching', rozmowa: 'small talk', polecenie: 'request' }
const REGS = ['neutralne', 'potoczne', 'wulgarne', 'obraźliwe', 'slang', 'ironiczne'] as const
const STATUS: Record<string, [string, string]> = {
  pending: ['czeka', 'waiting'],
  confirmed: ['potwierdzona', 'confirmed'],
  wrong: ['błędna', 'wrong'],
  corrected: ['poprawiona', 'corrected'],
  all: ['wszystkie', 'all'],
}

/** Weryfikuj → odpowiedzi czatu: każdy potwierdza / nie zgadza się / poprawia (z wagą zaufania); klucz właścicielki rozstrzyga.
 *  Poprawka zatwierdzona → pamięć wiedzy czatu; odpowiedź błędna → zestaw „nigdy więcej”. */
export function AnswerVotes({ state, conf = 'all', onCount }: InboxProps = {}) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [f, setF] = useState<AFilter>({ status: 'pending', intent: '', has_source: '', topic: '', register: '' })
  const [items, setItems] = useState<ChatAnswer[] | undefined>()
  const [facets, setFacets] = useState<Awaited<ReturnType<typeof answerFacets>> | undefined>()
  const [msg, setMsg] = useState<Record<number, string>>({})
  const [edit, setEdit] = useState<number | undefined>()
  const [corr, setCorr] = useState('')
  const [src, setSrc] = useState('')
  // stan ze skrzynki: czeka/sporne → oczekujące, zatwierdzone → potwierdzone (inne rozstrzygnięcia w liście „status”)
  useEffect(() => {
    if (state) setF((x) => ({ ...x, status: state === 'zatwierdzone' ? 'confirmed' : 'pending' }))
  }, [state])
  const visible = items?.filter((a) => (state !== 'sporne' || a.n_votes > a.n_confirm) && inConf(a.conf, conf))
  useEffect(() => {
    if (visible) onCount?.(visible.length)
  }, [visible?.length, onCount]) // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(() => {
    listAnswers(f).then(setItems, () => setItems([]))
    answerFacets().then(setFacets, () => undefined)
  }, [f])
  useEffect(() => {
    load()
  }, [load])
  const vote = async (a: ChatAnswer, v: 'confirm' | 'disagree' | 'correct') => {
    try {
      const r = await voteAnswer(a.id, v, v === 'correct' ? corr.trim() : undefined, v === 'correct' ? src.trim() || undefined : undefined)
      const t = !r.ok
        ? r.reason === 'own'
          ? en
            ? 'this answer was given in your browser – others vote'
            : 'ta odpowiedź padła w Twojej przeglądarce – głosują inni'
          : r.reason === 'decided'
            ? en
              ? `already decided: ${r.status}`
              : `już rozstrzygnięte: ${STATUS[r.status ?? 'all'][0]}`
            : (r.reason ?? 'error')
        : r.status && r.status !== 'pending'
          ? en
            ? `decided: ${STATUS[r.status][1]}${r.status === 'corrected' ? ' → knowledge memory' : r.status === 'wrong' ? ' → “never again” set' : ''}`
            : `rozstrzygnięte: ${STATUS[r.status][0]}${r.status === 'corrected' ? ' → pamięć wiedzy' : r.status === 'wrong' ? ' → zestaw „nigdy więcej”' : ''}`
          : en
            ? `vote counted (${r.voter}, weight ${Math.round((r.posterior ?? 0) * 100)}% correct so far)`
            : `głos policzony (${r.voter === 'person' ? 'człowiek' : r.voter}), prawdopodobieństwo poprawnej odpowiedzi ${Math.round((r.posterior ?? 0) * 100)}%`
      setMsg((x) => ({ ...x, [a.id]: t }))
      if (v === 'correct') {
        setEdit(undefined)
        setCorr('')
        setSrc('')
      }
      if (r.status && r.status !== 'pending') setTimeout(load, 1200)
    } catch (e) {
      setMsg((x) => ({ ...x, [a.id]: String((e as Error).message).slice(0, 90) }))
    }
  }
  const sel = 'rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-sm'
  return (
    <Card title={en ? 'Chat answers – check them' : 'Odpowiedzi czatu – sprawdź'}>
      <div data-testid="answer-votes">
        <p className="mb-2 text-xs text-slate-400">
          {en
            ? 'Every chat answer lands here live (questions without e-mails, links, phone numbers or names). Confirm, disagree, or correct it (with a source if you have one). Votes count with trust weights; the owner key decides. Approved corrections go to the chat’s knowledge memory, wrong answers to the “never again” regression set (separate from the 2000-question gate).'
            : 'Tu trafia na żywo każda odpowiedź czatu (pytania bez e-maili, linków, telefonów i imion). Potwierdź, nie zgódź się albo popraw (ze źródłem, jeśli masz). Głosy liczą się z wagą zaufania; klucz właścicielki rozstrzyga. Zatwierdzone poprawki trafiają do pamięci wiedzy czatu, błędne odpowiedzi do zestawu „nigdy więcej” (osobnego od bramki 2000 pytań).'}
          {ownerKey.get() ? (en ? ' Your vote = gold label.' : ' Twój głos = złota etykieta.') : ''}
        </p>
        {facets && (
          <p className="mb-2 text-xs text-slate-500 tabular-nums" data-testid="answer-facets">
            {en ? 'last' : 'ostatnie'} {facets.n}: {Object.entries(facets.status).map(([k, v]) => `${STATUS[k]?.[en ? 1 : 0] ?? k} ${v}`).join(' · ') || '–'} · {en ? '“never again” set' : 'zestaw „nigdy więcej”'}: {facets.errors}
          </p>
        )}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="answer-filters">
          <select className={sel} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as AFilter['status'] })} data-testid="filter-status">
            {Object.entries(STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v[en ? 1 : 0]}
              </option>
            ))}
          </select>
          <select className={sel} value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value as AFilter['intent'] })} data-testid="filter-intent">
            <option value="">{en ? 'any intent' : 'każda intencja'}</option>
            {INTENTS.map((i) => (
              <option key={i} value={i}>
                {en ? INTENT_EN[i] : i}
              </option>
            ))}
          </select>
          <select className={sel} value={f.has_source} onChange={(e) => setF({ ...f, has_source: e.target.value as AFilter['has_source'] })} data-testid="filter-source">
            <option value="">{en ? 'source: any' : 'źródło: dowolnie'}</option>
            <option value="tak">{en ? 'with source' : 'ze źródłem'}</option>
            <option value="nie">{en ? 'without source' : 'bez źródła'}</option>
          </select>
          <select className={sel} value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} data-testid="filter-topic">
            <option value="">{en ? 'any topic' : 'każdy temat'}</option>
            {(facets?.topics ?? []).map(([t, n]) => (
              <option key={t} value={t}>
                {t} ({n})
              </option>
            ))}
          </select>
          <select className={sel} value={f.register} onChange={(e) => setF({ ...f, register: e.target.value as AFilter['register'] })} data-testid="filter-register">
            <option value="">{en ? 'any register' : 'każdy rejestr'}</option>
            {REGS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        {visible && !visible.length && <p className="text-sm text-slate-500" data-testid="answers-empty">{en ? 'No answers for these filters yet.' : 'Brak odpowiedzi dla tych filtrów.'}</p>}
        <ul className="space-y-3">
          {(visible ?? []).map((a) => (
            <li key={a.id} className="rounded-xl border border-white/10 p-3" data-testid="answer-item">
              <div className="text-sm text-slate-300">
                <span className="text-slate-500">{en ? 'Q' : 'P'}:</span> {a.question}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-base text-slate-100">{a.answer}</div>
              <div className="mt-2 flex flex-wrap gap-1 text-xs" data-testid="answer-labels">
                <span className="chip border-violet/30 text-violet">{en ? INTENT_EN[a.intent] : a.intent}</span>
                <span className={`chip ${a.has_source ? 'border-spore/30 text-spore' : 'border-rose/30 text-rose'}`}>{a.has_source ? (en ? 'has source' : 'ma źródło') : en ? 'no source' : 'bez źródła'}</span>
                {a.topic && <span className="chip border-white/10 text-slate-300" title={a.category ?? ''}>{a.topic}</span>}
                {a.register !== 'neutralne' && <span className="chip border-amber/30 text-amber">{a.register}</span>}
                {a.act && <span className="chip border-white/10 text-slate-400">{a.act}</span>}
                {a.conf !== null && (
                  <span className="chip border-white/10 text-slate-400">
                    {en ? 'confidence' : 'pewność'} {Math.round(a.conf * 100)}%
                  </span>
                )}
                <span className="chip border-white/10 text-slate-400">{STATUS[a.status][en ? 1 : 0]}</span>
              </div>
              {a.sources.length > 0 && (
                <ul className="mt-1 text-xs text-slate-400">
                  {a.sources.map((s, i) => (
                    <li key={i}>
                      [{i + 1}]{' '}
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-spore underline">
                          {s.title}
                        </a>
                      ) : (
                        s.title
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {a.correction && (
                <div className="mt-1 text-xs text-amber">
                  {en ? 'approved correction' : 'zatwierdzona poprawka'}: {a.correction}
                  {a.correction_source ? ` (${a.correction_source})` : ''}
                </div>
              )}
              <div className="mt-1 text-xs text-slate-500 tabular-nums">
                {a.n_votes} {en ? 'votes' : 'głosów'} · {en ? 'correct' : 'poprawna'} {Math.round(a.posterior * 100)}% · #{a.id} · {new Date(a.created_at).toLocaleString(en ? 'en-GB' : 'pl-PL')}
              </div>
              {a.status === 'pending' || ownerKey.get() ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <button className="rounded-xl bg-spore/20 px-2 py-3 text-sm text-spore ring-1 ring-spore/30" onClick={() => void vote(a, 'confirm')} data-testid="answer-confirm">
                    {en ? 'Confirm' : 'Potwierdź'}
                  </button>
                  <button className="rounded-xl bg-rose/20 px-2 py-3 text-sm text-rose ring-1 ring-rose/30" onClick={() => void vote(a, 'disagree')} data-testid="answer-disagree">
                    {en ? 'Disagree' : 'Nie zgadzam się'}
                  </button>
                  <button className="rounded-xl bg-amber/15 px-2 py-3 text-sm text-amber ring-1 ring-amber/30" onClick={() => setEdit(edit === a.id ? undefined : a.id)} data-testid="answer-correct">
                    {en ? 'Correct' : 'Popraw'}
                  </button>
                </div>
              ) : null}
              {edit === a.id && (
                <div className="mt-2 space-y-2">
                  <textarea value={corr} onChange={(e) => setCorr(e.target.value)} rows={3} maxLength={600} className="w-full rounded-xl border border-white/10 bg-black/30 p-2 text-base" placeholder={en ? 'correct answer' : 'poprawna odpowiedź'} data-testid="answer-correction" />
                  <input value={src} onChange={(e) => setSrc(e.target.value)} maxLength={300} className="w-full rounded-xl border border-white/10 bg-black/30 p-2 text-sm" placeholder={en ? 'source (optional, e.g. a Wikipedia link)' : 'źródło (opcjonalnie, np. link do Wikipedii)'} data-testid="answer-correction-source" />
                  <button disabled={!corr.trim()} onClick={() => void vote(a, 'correct')} className="w-full rounded-xl bg-amber/25 py-3 text-sm text-amber ring-1 ring-amber/40 disabled:opacity-40" data-testid="answer-correction-save">
                    {en ? 'Save correction' : 'Zapisz poprawkę'}
                  </button>
                </div>
              )}
              {msg[a.id] && (
                <div className="mt-1 text-xs text-violet" data-testid="answer-msg">
                  {msg[a.id]}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
