import { useEffect, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { account } from '../myc/account'
import { gchat, gchatRoom } from '../myc/gchat'
import { ids, ownerKey, SB_KEY, SB_URL } from '../myc/store'
import { Card } from './ui'
import { split, type InboxProps } from '../myc/inbox'

interface Pat {
  id: number
  kind: string
  pattern: string
  label: string
  example: string | null
  n_seen: number
  n_authors: number
  posterior: number
  n_votes: number
}
const LABELS = ['pytanie', 'emocja', 'niezgoda', 'stwierdzenie', 'powitanie']

/** Weryfikuj → wzorce języka z czatu globalnego (skróty, emotikony, wydłużenia, intencje, ironia): „prawda” / „kłamstwo”.
 *  Waga głosu = trafność na złotych etykietach; Developer (konto z kluczem) lub klucz właściciela = złota etykieta. */
export function PatternVotes({ state, conf = 'all', onCount }: InboxProps = {}) {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  useSyncExternalStore(gchat.subscribe, gchat.getVersion)
  const [items, setItems] = useState<Pat[] | undefined>()
  // tylko czekające głosowania ludzi; bez pewności AI – przy filtrze pewności albo „zatwierdzone” sekcja znika
  const off = state === 'zatwierdzone' || conf !== 'all'
  const visible = off ? [] : items?.filter((x) => state !== 'sporne' || split(x.n_votes, x.posterior))
  useEffect(() => {
    if (visible) onCount?.(visible.length)
  }, [visible?.length, onCount]) // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState<Record<number, string>>({})
  const load = () =>
    fetch(`${SB_URL}/rest/v1/myc_lang_patterns?select=id,kind,pattern,label,example,n_seen,n_authors,posterior,n_votes&room=eq.${gchatRoom()}&status=eq.pending&order=n_authors.desc,created_at.desc&limit=30`, { headers: { apikey: SB_KEY } })
      .then((r) => (r.ok ? (r.json() as Promise<Pat[]>) : []))
      .then(setItems, () => setItems([]))
  useEffect(() => {
    void load()
    if (account.session) void gchat.refreshMe()
  }, [])
  const gold = !!ownerKey.get() || gchat.me?.role === 'developer'
  const vote = async (p: Pat, v: boolean, label?: string) => {
    try {
      const tok = await account.token().catch(() => null)
      const r = await fetch(`${SB_URL}/rest/v1/rpc/myc_lang_vote`, {
        method: 'POST',
        headers: { apikey: SB_KEY, 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ p_key: ownerKey.get() || null, p_node: ids.node, p_id: p.id, p_vote: v, p_agent: false, p_label: label ?? null }),
      })
      const j = (await r.json()) as { ok?: boolean; reason?: string; status?: string; voter?: string; posterior?: number; message?: string }
      if (!r.ok) throw new Error(j.message ?? String(r.status))
      setMsg((x) => ({
        ...x,
        [p.id]: !j.ok
          ? (j.reason ?? '?')
          : j.status === 'approved'
            ? L('zatwierdzone → strzępek i dane treningowe (eksport)', 'approved → fragment and training data (export)')
            : j.status === 'rejected'
              ? L('odrzucone', 'rejected')
              : `${L('głos policzony, prawda', 'vote counted, truth')} ${Math.round((j.posterior ?? 0) * 100)}%`,
      }))
      if (j.status && j.status !== 'pending') setTimeout(() => void load(), 1200)
    } catch (e) {
      setMsg((x) => ({ ...x, [p.id]: (e as Error).message.slice(0, 80) }))
    }
  }
  if (off) return null
  return (
    <Card title={L('Jak ludzie piszą – wzorce z czatu globalnego', 'How people write – patterns from global chat')}>
      <div data-testid="pattern-votes">
        <p className="mb-2 text-xs text-slate-400">
          {L(
            'Kandydaci wyciągnięci automatycznie z czatu globalnego (tylko od osób, które się zgodziły; bez pseudonimów, linków, e-maili i telefonów). Skrót/emotikon pojawia się tu dopiero, gdy użyły go ≥ 2 różne osoby. Czy to prawda?',
            'Candidates extracted automatically from global chat (only from people who opted in; pseudonyms, links, e-mails and phones removed). An abbreviation/emoticon appears only once ≥ 2 different people used it. Is it true?',
          )}
          {gold ? L(' Twój głos = złota etykieta.', ' Your vote = gold label.') : ''}
        </p>
        {visible && !visible.length && <p className="text-sm text-slate-500">{L('Nic nie czeka – wzorce pojawią się, gdy ludzie zaczną pisać w czacie globalnym.', 'Nothing waiting – patterns appear once people write in global chat.')}</p>}
        <ul className="space-y-3">
          {(visible ?? []).map((p) => (
            <li key={p.id} className="rounded-xl border border-white/10 p-3" data-testid="pattern-item">
              <div className="text-xs uppercase tracking-wider text-slate-500">{p.kind}</div>
              <div className="text-base">
                „{p.pattern}” → <b>{p.label}</b>
              </div>
              {p.example && p.example !== p.pattern && <div className="mt-1 text-xs text-slate-500">„{p.example}”</div>}
              <div className="mt-1 text-xs tabular-nums text-slate-500">
                {L('widziane', 'seen')} {p.n_seen}× · {L('osób', 'people')} {p.n_authors} · {p.n_votes} {L('głosów', 'votes')} · {L('prawda', 'truth')} {Math.round(p.posterior * 100)}%
              </div>
              <div className="mt-2 flex gap-2">
                <button className="flex-1 rounded-xl bg-spore/20 px-3 py-3 text-spore ring-1 ring-spore/30" onClick={() => void vote(p, true)}>
                  {L('Prawda', 'True')}
                </button>
                <button className="flex-1 rounded-xl bg-rose/20 px-3 py-3 text-rose ring-1 ring-rose/30" onClick={() => void vote(p, false)}>
                  {L('Kłamstwo', 'Lie')}
                </button>
              </div>
              {gold && p.kind === 'intencja' && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  <span className="text-slate-500">{L('popraw intencję:', 'fix intent:')}</span>
                  {LABELS.filter((l) => l !== p.label).map((l) => (
                    <button key={l} className="rounded-lg border border-violet/30 px-2 py-1 text-violet" onClick={() => void vote(p, true, l)}>
                      {l}
                    </button>
                  ))}
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
