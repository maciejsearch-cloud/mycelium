import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { account } from '../myc/account'
import { ids, ownerKey, SB_KEY, SB_URL } from '../myc/store'
import { POS_PL } from '../myc/rozbior'
import { Card } from './ui'
import { POS_COLOR } from './RozbiorTable'
import { inConf, split, type InboxProps } from '../myc/inbox'

interface PTok {
  form: string
  lemma?: string
  upos?: string
  head?: number
  deprel?: string
  part?: string
  q?: string
  of?: number
}
interface Parse {
  id: number
  sentence: string
  toks: PTok[]
  model_version: number | null
  conf: number | null
  posterior: number
  n_votes: number
  status: string
  created_at: string
}
const PARTS = ['podmiot', 'orzeczenie', 'orzecznik', 'dopełnienie', 'przydawka', 'okolicznik', 'spójnik', 'przyimek', 'partykuła', 'przeczenie', 'inne']

/** Weryfikuj → „rozbiór zdania”: części zdania z czatu (model grzybni). Dobrze / źle / popraw część zdania słowa.
 *  Waga głosu = trafność na złotych etykietach (osoby ≤ 0,9, agenci ≤ 0,7); klucz właściciela = złota etykieta. */
export function ParseVotes({ state, conf = 'all', onCount, room = 'main' }: InboxProps & { room?: string }) {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  const [items, setItems] = useState<Parse[] | undefined>()
  const [msg, setMsg] = useState<Record<number, string>>({})
  const [fix, setFix] = useState<Record<number, Record<number, string>>>({})
  const [pick, setPick] = useState<{ id: number; i: number } | undefined>()
  const done = state === 'zatwierdzone'
  const load = () =>
    fetch(
      `${SB_URL}/rest/v1/myc_parses?select=id,sentence,toks,model_version,conf,posterior,n_votes,status,created_at&room=eq.${room}&status=${done ? 'in.(confirmed,corrected,wrong)' : 'eq.pending'}&order=created_at.desc&limit=30`,
      { headers: { apikey: SB_KEY } },
    )
      .then((r) => (r.ok ? (r.json() as Promise<Parse[]>) : []))
      .then(setItems, () => setItems([]))
  useEffect(() => void load(), [done]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = items?.filter((x) => inConf(x.conf, conf) && (state !== 'sporne' || split(x.n_votes, x.posterior)))
  useEffect(() => {
    if (visible) onCount?.(done ? 0 : visible.length)
  }, [visible?.length, onCount, done]) // eslint-disable-line react-hooks/exhaustive-deps
  const gold = !!ownerKey.get()
  const vote = async (p: Parse, v: 'confirm' | 'disagree' | 'correct') => {
    try {
      const tok = await account.token().catch(() => null)
      const corr = v === 'correct' ? Object.entries(fix[p.id] ?? {}).map(([i, part]) => ({ i: Number(i), part })) : null
      const r = await fetch(`${SB_URL}/rest/v1/rpc/myc_parse_vote`, {
        method: 'POST',
        headers: { apikey: SB_KEY, 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ p_key: ownerKey.get() || null, p_node: ids.node, p_contrib: ids.contributor, p_id: p.id, p_vote: v, p_correction: corr, p_agent: false }),
      })
      const j = (await r.json()) as { ok?: boolean; reason?: string; status?: string; posterior?: number; message?: string }
      if (!r.ok) throw new Error(j.message ?? String(r.status))
      setMsg((x) => ({
        ...x,
        [p.id]: !j.ok
          ? j.reason === 'own'
            ? L('to Twój rozbiór – ocenia ktoś inny', 'your own parse – someone else rates it')
            : (j.reason ?? '?')
          : j.status === 'pending'
            ? `${L('głos policzony, dobrze', 'vote counted, correct')} ${Math.round((j.posterior ?? 0) * 100)}%`
            : `${L('rozstrzygnięte', 'decided')}: ${j.status}`,
      }))
      if (j.status && j.status !== 'pending') setTimeout(() => void load(), 1200)
    } catch (e) {
      setMsg((x) => ({ ...x, [p.id]: (e as Error).message.slice(0, 80) }))
    }
  }
  return (
    <Card title={L('Rozbiór zdania – części zdania z czatu', 'Sentence parsing – sentence parts from chat')}>
      <div data-testid="parse-votes">
        <p className="mb-2 text-xs text-slate-400">
          {L(
            'Tak model grzybni rozebrał zdania z Rozmowy (tylko od osób, które zgodziły się na naukę; bez danych osobowych). Czy części zdania są dobre? Kliknij słowo, żeby poprawić jego część zdania. Zatwierdzone rozbiory trafiają do treningu węzłów.',
            'This is how the mycelium model parsed sentences from Chat (only from people who opted in to training; personal data removed). Are the sentence parts right? Click a word to fix its part. Approved parses go to node training.',
          )}
          {gold ? L(' Twój głos = złota etykieta.', ' Your vote = gold label.') : ''}
        </p>
        {visible && !visible.length && (
          <p className="text-sm text-slate-500" data-testid="parse-empty">
            {done ? L('Jeszcze nic nie rozstrzygnięto.', 'Nothing decided yet.') : L('Nic nie czeka – rozbiory pojawią się, gdy ktoś rozwinie „Jak zrozumiałem zdanie” w Rozmowie.', 'Nothing waiting – parses appear once someone opens “How I understood the sentence” in Chat.')}
          </p>
        )}
        <ul className="space-y-3">
          {(visible ?? []).map((p) => (
            <li key={p.id} className="rounded-xl border border-white/10 p-3" data-testid="parse-item">
              <div className="text-base">„{p.sentence}”</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.toks.map((t, k) => {
                  const i = k + 1
                  const f = fix[p.id]?.[i]
                  if (t.upos === 'PUNCT') return null
                  return (
                    <button
                      key={i}
                      disabled={done}
                      onClick={() => setPick(pick?.id === p.id && pick.i === i ? undefined : { id: p.id, i })}
                      className={`rounded-lg border px-2 py-1 text-left text-xs ${POS_COLOR[t.upos ?? ''] ?? 'border-slate-600 text-slate-300'} ${pick?.id === p.id && pick.i === i ? 'ring-2 ring-violet' : ''}`}
                      title={POS_PL[t.upos ?? ''] ?? t.upos}
                      data-testid="parse-tok"
                    >
                      <span className="block font-medium">{t.form}</span>
                      <span className="block text-[10px] opacity-80">
                        {f ? <s>{t.part ?? '–'}</s> : (t.part ?? '–')}
                        {f && <b> {f}</b>}
                        {!f && t.q && ` · ${t.q}?`}
                        {!f && t.part === 'przydawka' && t.of ? ` → ${p.toks[t.of - 1]?.form ?? ''}` : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
              {pick?.id === p.id && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <span className="text-slate-500">{L(`„${p.toks[pick.i - 1]?.form}” to:`, `“${p.toks[pick.i - 1]?.form}” is:`)}</span>
                  {PARTS.map((x) => (
                    <button key={x} className="rounded-lg border border-violet/30 px-2 py-1 text-violet" onClick={() => (setFix((m) => ({ ...m, [p.id]: { ...(m[p.id] ?? {}), [pick.i]: x } })), setPick(undefined))}>
                      {x}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-1 text-xs tabular-nums text-slate-500">
                {L('model', 'model')} v{p.model_version ?? '–'} · {L('pewność', 'confidence')} {p.conf != null ? `${Math.round(p.conf * 100)}%` : '–'} · {p.n_votes} {L('głosów', 'votes')} · {L('dobrze', 'correct')} {Math.round(p.posterior * 100)}%{done && ` · ${p.status}`}
              </div>
              {!done && (
                <div className="mt-2 flex gap-2">
                  <button className="flex-1 rounded-xl bg-spore/20 px-3 py-3 text-spore ring-1 ring-spore/30" onClick={() => void vote(p, 'confirm')} data-testid="parse-ok">
                    {L('Dobrze', 'Correct')}
                  </button>
                  {fix[p.id] && Object.keys(fix[p.id]).length > 0 ? (
                    <button className="flex-1 rounded-xl bg-violet/20 px-3 py-3 text-violet ring-1 ring-violet/30" onClick={() => void vote(p, 'correct')} data-testid="parse-fix">
                      {L(`Popraw (${Object.keys(fix[p.id]).length})`, `Correct it (${Object.keys(fix[p.id]).length})`)}
                    </button>
                  ) : (
                    <button className="flex-1 rounded-xl bg-rose/20 px-3 py-3 text-rose ring-1 ring-rose/30" onClick={() => void vote(p, 'disagree')} data-testid="parse-bad">
                      {L('Źle', 'Wrong')}
                    </button>
                  )}
                </div>
              )}
              {msg[p.id] && <div className="mt-1 text-xs text-violet">{msg[p.id]}</div>}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
