// Rozmówca czatu: plakietka źródła i ocena odpowiedzi grzybni, arkusz „rozbiór” wiadomości, panel stanu i decyzji
// moderacji (Developer), „moja relacja z grzybnią”. Wszystkie liczby z bazy; brak danych = uczciwy pusty stan.
import { useEffect, useState } from 'react'
import { Card } from './ui'
import {
  decide, decisionsList, forgetMe, myRelation, rozmowaAdmin, rozmowaParse, rozmowaRate, SOURCE_PL,
  type DecisionRow, type MyRelation, type ReplyMeta, type RozmowaState, type StoredParse,
} from '../myc/rozmowaApi'

const btn = 'rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-white/[0.05] disabled:opacity-50'
const sec = (ms: number | null) => (ms == null ? '' : `${(ms / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} s`)

export function ReplyTools({ id, m, canRate, en, onDone }: { id: number; m: ReplyMeta; canRate: boolean; en: boolean; onDone: () => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [fix, setFix] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (s: 1 | -1 | null, f?: string) => {
    setBusy(true)
    setErr('')
    try {
      await rozmowaRate(id, s, f)
      setFix(null)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }
  return (
    <div className="mt-1 text-xs" data-testid="rozmowa-tools">
      <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
        <span className="chip border-sky-400/30 bg-sky-400/[0.06] px-2 py-0 text-[10px] text-sky-300" data-testid="rozmowa-source" title={m.cite ?? undefined}>
          {L('źródło', 'source')}: {SOURCE_PL[m.source] ?? m.source} · {m.rule}
          {m.latency_ms != null && m.addressed ? ` · ${sec(m.latency_ms)}` : ''}
        </span>
        {m.cite && <span className="text-[10px] text-slate-500">{m.cite}</span>}
        <span className="tabular-nums">👍 {m.up} · 👎 {m.down}</span>
        {canRate && (
          <>
            <button className={`${btn} ${m.mine?.sense === 1 ? 'border-spore/60 text-spore' : 'border-white/10'}`} disabled={busy} onClick={() => void send(1)} aria-label={L('dobra odpowiedź', 'good reply')}>
              👍
            </button>
            <button className={`${btn} ${m.mine?.sense === -1 ? 'border-rose/60 text-rose' : 'border-white/10'}`} disabled={busy} onClick={() => void send(-1)} aria-label={L('zła odpowiedź', 'bad reply')}>
              👎
            </button>
            <button className={`${btn} border-white/10`} onClick={() => setFix(fix == null ? (m.mine?.fixed ?? '') : null)} data-testid="rozmowa-fix-open">
              {L('popraw', 'improve')}
            </button>
          </>
        )}
      </div>
      {fix != null && (
        <div className="mt-1 flex gap-1.5">
          <input
            value={fix}
            maxLength={300}
            onChange={(e) => setFix(e.target.value)}
            placeholder={L('Lepsza odpowiedź grzybni…', 'A better reply…')}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-slate-100"
            data-testid="rozmowa-fix"
          />
          <button className={`${btn} border-spore/40 text-spore`} disabled={busy || !fix.trim()} onClick={() => void send(null, fix.trim())}>
            {L('zapisz', 'save')}
          </button>
        </div>
      )}
      {m.mine?.fixed && fix == null && <div className="mt-0.5 text-[11px] text-slate-500">{L('twoja poprawka', 'your fix')}: „{m.mine.fixed}” · {L('do nauki po zgodzie 2 osób albo Developera', 'used after 2 people or a Developer agree')}</div>}
      {err && <div className="text-rose">{err}</div>}
    </div>
  )
}

const FIELD_PL: [keyof StoredParse, string][] = [
  ['pred', 'orzeczenie (lemat)'], ['subj', 'podmiot'], ['obj', 'dopełnienie'], ['phrase', 'okolicznik'], ['person', 'osoba'], ['tense', 'czas'],
  ['mood', 'tryb'], ['qtype', 'typ pytania'], ['toOther', 'zwrot do osoby'],
]
const MOOD_PL: Record<string, string> = { ind: 'oznajmujący', imp: 'rozkazujący', cond: 'przypuszczający' }
const TENSE_PL: Record<string, string> = { pres: 'teraźniejszy', past: 'przeszły', fut: 'przyszły' }

export function RozbiorSheet({ id, text, onClose, en }: { id: number; text: string; onClose: () => void; en: boolean }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [p, setP] = useState<StoredParse | null | undefined>(undefined)
  const [err, setErr] = useState('')
  useEffect(() => {
    rozmowaParse(id).then(setP, (e) => setErr(String((e as Error).message)))
  }, [id])
  const val = (k: keyof StoredParse, v: unknown) => (k === 'mood' ? MOOD_PL[String(v)] : k === 'tense' ? TENSE_PL[String(v)] : String(v))
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose} data-testid="rozbior-sheet">
      <div className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-[#0b1512] p-4 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-base font-semibold text-slate-100">{L('Rozbiór wiadomości', 'Message parse')}</h3>
          <button className="ml-auto px-2 text-slate-400" onClick={onClose} aria-label={L('zamknij', 'close')}>
            ✕
          </button>
        </div>
        <p className="mb-3 rounded-xl bg-white/[0.04] p-2 text-sm text-slate-200">„{text}”</p>
        {err && <p className="text-sm text-rose">{err}</p>}
        {p === undefined && !err && <p className="text-sm text-slate-500">{L('wczytuję…', 'loading…')}</p>}
        {p === null && <p className="text-sm text-slate-400">{L('Brak zapisanego rozbioru: autor wyłączył naukę albo rozmówca nie przetworzył jeszcze tej wiadomości.', 'No stored parse: the author opted out of learning or it has not been processed yet.')}</p>}
        {p && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-1.5">
              {p.addressed && <span className="chip border-sky-400/40 text-sky-300">{L('do grzybni', 'to mycelium')}</span>}
              {p.question && <span className="chip border-white/15">{L('pytanie', 'question')}</span>}
              {p.acts.map((a) => (
                <span key={a} className="chip border-spore/30 text-spore">
                  {a}
                </span>
              ))}
              {p.emotions.map((e) => (
                <span key={e} className="chip border-amber/30 text-amber">
                  {e}
                </span>
              ))}
              <span className="chip border-white/10 text-slate-400">
                {L('nacechowanie', 'polarity')} {p.polarity > 0 ? '+' : ''}
                {p.polarity}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {FIELD_PL.filter(([k]) => p[k] != null && p[k] !== '').map(([k, n]) => (
                <div key={k} className="contents">
                  <dt className="text-slate-500">{n}</dt>
                  <dd className="text-slate-100">{val(k, p[k])}</dd>
                </div>
              ))}
              {p.neg && (
                <>
                  <dt className="text-slate-500">{L('przeczenie', 'negation')}</dt>
                  <dd className="text-slate-100">{L('tak', 'yes')}</dd>
                </>
              )}
            </dl>
            {p.why.length > 0 && <p className="text-xs text-slate-400">{L('dlaczego', 'why')}: {p.why.join('; ')}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="pr-2 text-left">#</th>
                    <th className="pr-2 text-left">{L('forma', 'form')}</th>
                    <th className="pr-2 text-left">{L('lemat', 'lemma')}</th>
                    <th className="pr-2 text-left">UPOS</th>
                    <th className="pr-2 text-left">{L('relacja', 'deprel')}</th>
                    <th className="text-left">{L('cechy', 'feats')}</th>
                  </tr>
                </thead>
                <tbody className="text-slate-200">
                  {(p.toks ?? []).map((t, i) => (
                    <tr key={i}>
                      <td className="pr-2 text-slate-500">{i + 1}</td>
                      <td className="pr-2">{t.f}</td>
                      <td className="pr-2">{t.l}</td>
                      <td className="pr-2">{t.u}</td>
                      <td className="pr-2">
                        {t.d}→{t.h}
                      </td>
                      <td>{t.x ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              {L('Model rozbioru', 'Parse model')}: {p.model} (GPL-3.0, UD Polish-LFG) · Morfeusz 2 / SGJP (BSD-2) · {L('emocje', 'emotions')}: Słowosieć – Emotional Annotations Dictionary (CC BY 4.0) · {L('pewność', 'confidence')} {Math.round(p.conf * 100)}%
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export function RozmowaPanel({ st, dev, en, onChange }: { st: RozmowaState | null; dev: boolean; en: boolean; onChange: (s: RozmowaState) => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<DecisionRow[] | null>(null)
  const [err, setErr] = useState('')
  const load = () => decisionsList().then(setRows, (e) => setErr(String((e as Error).message)))
  useEffect(() => {
    if (open && dev) void load()
  }, [open, dev])
  if (!st) return null
  const act = async (f: () => Promise<unknown>) => {
    setErr('')
    try {
      await f()
      await load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="rounded-2xl border border-sky-400/20 bg-sky-400/[0.04] p-3 text-xs text-slate-300" data-testid="rozmowa-panel">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sky-300">{L('Rozmówca grzybni', 'Mycelium conversationalist')}</b>
        <span className={`chip px-1.5 py-0 ${st.online && st.enabled ? 'border-spore/40 text-spore' : 'border-amber/40 text-amber'}`} data-testid="rozmowa-online">
          {!st.enabled ? L('wstrzymany', 'paused') : st.online ? L('słucha czatu', 'listening') : L('offline – proces rozmówcy nie odpowiada', 'offline – worker not responding')}
        </span>
        <span>
          {L('odpowiedzi', 'replies')}: {st.replies}
        </span>
        {st.median_latency_ms != null && (
          <span>
            {L('mediana czasu odpowiedzi', 'median reply time')}: {sec(st.median_latency_ms)}
          </span>
        )}
        <span>
          {L('zapamiętane wiadomości', 'remembered messages')}: {st.mem}
        </span>
        <span>
          {L('pary od ludzi', 'human pairs')}: {st.pairs}
        </span>
        <button className="ml-auto text-slate-400 underline" onClick={() => setOpen(!open)}>
          {open ? L('zwiń', 'less') : L('jak to działa', 'how it works')}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2 text-slate-400">
          <p>
            {L(
              `Każdą wiadomość rozkładam na części (orzeczenie, podmiot, osoba, czas, tryb, typ pytania, emocje) i odpowiadam regułami opartymi na tym rozbiorze. Odpowiadam zawsze, gdy ktoś woła „Grzybnio”; sama wtrącam się najwyżej co ${st.interject_every_n} wiadomości i nie częściej niż co ${st.interject_min_s} s; gdy przez ${st.invite_quiet_min} min jest cicho, zapraszam do rozmowy. Pod każdą odpowiedzią jest jej źródło. Bez cenzury: przekleństwa i poglądy nie są karane – automatycznie wyciszam tylko zalew (10 min), a nękanie innych zgłaszam Developerowi.`,
              `I parse every message (predicate, subject, person, tense, mood, question type, emotions) and reply with rules based on the parse. I always answer when called; I interject at most every ${st.interject_every_n} messages and ${st.interject_min_s} s; after ${st.invite_quiet_min} quiet minutes I invite people to talk. Each reply shows its source. No censorship: swearing and opinions are never punished – only floods are auto-muted (10 min); harassment of others goes to the Developer.`,
            )}
          </p>
          {dev && (
            <div className="space-y-2" data-testid="rozmowa-dev">
              <div className="flex flex-wrap gap-1.5">
                <button className={`${btn} border-white/15`} onClick={() => void act(async () => onChange(await rozmowaAdmin(st.enabled ? 'pause' : 'resume')))}>
                  {st.enabled ? L('wstrzymaj rozmówcę', 'pause') : L('wznów rozmówcę', 'resume')}
                </button>
                {[1, 3, 5, 10].map((n) => (
                  <button key={n} className={`${btn} ${st.interject_every_n === n ? 'border-spore/50 text-spore' : 'border-white/10'}`} onClick={() => void act(async () => onChange(await rozmowaAdmin('every_n', n)))}>
                    {L('wtrącenie co', 'every')} {n}
                  </button>
                ))}
              </div>
              <div className="eyebrow">{L('Decyzje moderacji grzybni', 'Moderation decisions')}</div>
              {rows?.length === 0 && <p>{L('Brak decyzji.', 'No decisions.')}</p>}
              {rows?.map((d) => (
                <div key={d.id} className="rounded-xl border border-white/10 p-2" data-testid="rozmowa-decision">
                  <div className="flex flex-wrap gap-1.5">
                    <b className="text-slate-200">{d.kind === 'mute_auto' ? L('wyciszenie automatyczne', 'auto-mute') : d.kind === 'propose' ? L('propozycja', 'proposal') : L('ostrzeżenie', 'warning')}</b>
                    <span>{d.handle}</span>
                    {d.target && <span>→ {d.target}</span>}
                    <span className="text-slate-500">{new Date(d.at).toLocaleString('pl-PL')}</span>
                    <span className="chip border-white/10 px-1.5 py-0">{d.status}</span>
                  </div>
                  <div>{d.reason}</div>
                  {d.texts?.map((t) => (
                    <div key={t.id} className="truncate text-slate-500">
                      #{t.id}: {t.body ?? L('(usunięta)', '(deleted)')}
                    </div>
                  ))}
                  <div className="mt-1 flex gap-1.5">
                    {d.status === 'pending' && (
                      <>
                        <button className={`${btn} border-amber/40 text-amber`} onClick={() => void act(() => decide(d.id, 'accept'))}>
                          {L(`przyjmij (wycisz ${d.minutes ?? 60} min)`, `accept (mute ${d.minutes ?? 60} min)`)}
                        </button>
                        <button className={`${btn} border-white/15`} onClick={() => void act(() => decide(d.id, 'reject'))}>
                          {L('odrzuć', 'reject')}
                        </button>
                      </>
                    )}
                    {(d.status === 'applied' || d.status === 'accepted') && d.kind !== 'warn' && (
                      <button className={`${btn} border-white/15`} onClick={() => void act(() => decide(d.id, 'revert'))}>
                        {L('cofnij wyciszenie', 'revert mute')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {err && <p className="text-rose">{err}</p>}
        </div>
      )}
    </div>
  )
}

export function MyRelationCard({ en }: { en: boolean }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [r, setR] = useState<MyRelation | null | undefined>(undefined)
  const [err, setErr] = useState('')
  const load = () => myRelation().then(setR, (e) => setErr(String((e as Error).message)))
  useEffect(() => {
    void load()
  }, [])
  const s = r?.state
  const tone = !s ? null : s.score <= -2 ? L('chłodno', 'cool') : s.score >= 2 ? L('ciepło', 'warm') : L('neutralnie', 'neutral')
  return (
    <Card title={L('Moja relacja z grzybnią', 'My relationship with mycelium')}>
      <div className="space-y-2 text-sm text-slate-300" data-testid="my-relation">
        {r === undefined && !err && <p className="text-slate-500">{L('wczytuję…', 'loading…')}</p>}
        {r && !r.train_ok && <p>{L('Masz wyłączoną naukę – grzybnia nie prowadzi o tobie pamięci.', 'Learning is off – mycelium keeps no memory of you.')}</p>}
        {r && r.train_ok && !s && <p>{L('Grzybnia jeszcze cię nie zna – porozmawiaj z nią na czacie („Grzybnio, …”).', 'Mycelium does not know you yet – talk to it in the chat.')}</p>}
        {s && (
          <>
            <p>
              {L('Ton', 'Tone')}: <b>{tone}</b> ({L('wynik', 'score')} {s.score}) · {L('wiadomości', 'messages')}: {s.n_msgs} · {L('obrazy', 'insults')}: {s.n_insults} · {L('przeprosiny', 'apologies')}: {s.n_apologies} · {L('komplementy', 'compliments')}: {s.n_compliments}
              {s.n_hostile_others ? ` · ${L('wrogość wobec innych', 'hostility to others')}: ${s.n_hostile_others}` : ''}
            </p>
            {Object.keys(s.topics).length > 0 && (
              <p className="text-xs text-slate-400">
                {L('Twoje tematy', 'Your topics')}: {Object.entries(s.topics).map(([k, v]) => `${k} (${v})`).join(', ')}
              </p>
            )}
            {r.events.length > 0 && (
              <ul className="space-y-0.5 text-xs text-slate-400">
                {r.events.map((e, i) => (
                  <li key={i}>
                    {new Date(e.at).toLocaleString('pl-PL')} · <b>{e.kind}</b>
                    {e.excerpt ? `: „${e.excerpt}”` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {r && (s || r.events.length > 0) && (
          <button
            className={`${btn} border-rose/40 text-rose`}
            onClick={() => confirm(L('Usunąć pamięć grzybni o tobie (relacja i rozbiory twoich wiadomości)?', 'Delete what mycelium remembers about you?')) && void forgetMe().then(load, (e) => setErr(String(e.message)))}
          >
            {L('zapomnij mnie', 'forget me')}
          </button>
        )}
        {err && <p className="text-rose">{err}</p>}
      </div>
    </Card>
  )
}
