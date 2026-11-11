import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { pendingMeanings, voteMeaning, type Meaning } from '../myc/meanings'
import { ownerKey } from '../myc/store'
import { Card } from './ui'
import { split, type InboxProps } from '../myc/inbox'

/** Weryfikuj → znaczenia z czatu: każdy głosuje „prawda” / „kłamstwo” (waga = trafność na złotych etykietach);
 *  głos właściciela (klucz) jest złotą etykietą i rozstrzyga. Rejestr (np. wulgarne) to tylko etykieta – bez cenzury. */
export function MeaningVotes({ state, conf = 'all', onCount }: InboxProps = {}) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [items, setItems] = useState<Meaning[] | undefined>()
  // tylko czekające głosowania ludzi; bez pewności AI – przy filtrze pewności albo „zatwierdzone” sekcja znika
  const off = state === 'zatwierdzone' || conf !== 'all'
  const visible = off ? [] : items?.filter((x) => state !== 'sporne' || split(x.n_votes, x.posterior))
  useEffect(() => {
    if (visible) onCount?.(visible.length)
  }, [visible?.length, onCount]) // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState<Record<number, string>>({})
  const load = () => pendingMeanings().then(setItems, () => setItems([]))
  useEffect(() => {
    void load()
  }, [])
  const vote = async (m: Meaning, v: boolean) => {
    try {
      const r = await voteMeaning(m.id, v)
      const t = !r.ok
        ? r.reason === 'own'
          ? en
            ? 'you wrote this explanation – others vote'
            : 'to Twoje wyjaśnienie – głosują inni'
          : (r.reason ?? 'error')
        : r.status === 'approved'
          ? en
            ? `approved (${r.voter === 'owner' ? 'owner – gold label' : 'votes'}) → fragment, chat (LM data: next export)`
            : `zatwierdzone (${r.voter === 'owner' ? 'właściciel – złota etykieta' : 'głosy'}) → strzępek, czat (dane LM: następny eksport)`
          : r.status === 'rejected'
            ? en
              ? 'rejected'
              : 'odrzucone'
            : en
              ? `vote counted (${r.voter}), truth probability ${Math.round((r.posterior ?? 0) * 100)}%`
              : `głos policzony (${r.voter === 'person' ? 'człowiek' : r.voter}), prawdopodobieństwo prawdy ${Math.round((r.posterior ?? 0) * 100)}%`
      setMsg((x) => ({ ...x, [m.id]: t }))
      if (r.status && r.status !== 'pending') setTimeout(() => void load(), 1200)
    } catch (e) {
      setMsg((x) => ({
        ...x,
        [m.id]: String((e as Error).message).slice(0, 80),
      }))
    }
  }
  if (off) return null
  return (
    <Card title={en ? 'Meanings taught in chat – vote' : 'Znaczenia z czatu – głosuj'}>
      <div data-testid="meaning-votes">
        <p className="mb-2 text-xs text-slate-400">
          {en
            ? 'People explained words the chat did not know (slang and vulgar words included – the register is only a tag). Until approved they are not used. Every vote counts with its trust weight; the owner key decides.'
            : 'Ludzie wyjaśnili słowa, których czat nie znał (także slang i wulgaryzmy – rejestr to tylko etykieta). Do zatwierdzenia nie są używane. Każdy głos liczy się z wagą zaufania; klucz właściciela rozstrzyga.'}
          {ownerKey.get() ? (en ? ' Your vote = gold label.' : ' Twój głos = złota etykieta.') : ''}
        </p>
        {visible && !visible.length && <p className="text-sm text-slate-500">{en ? 'Nothing waiting.' : 'Nic nie czeka.'}</p>}
        <ul className="space-y-3">
          {(visible ?? []).map((m) => (
            <li key={m.id} className="rounded-xl border border-white/10 p-3" data-testid="meaning-item" data-word={m.word}>
              <div className="text-base">
                <b>„{m.word}”</b> {m.register !== 'neutralne' && <span className="chip ml-1 border-amber/30 text-amber">{m.register}</span>} – {m.meaning}
              </div>
              {m.example && (
                <div className="mt-1 text-xs text-slate-500">
                  {en ? 'used as' : 'użyte'}: „{m.example}”
                </div>
              )}
              <div className="mt-1 text-xs text-slate-500 tabular-nums">
                {m.n_votes} {en ? 'votes' : 'głosów'} · {en ? 'truth' : 'prawda'} {Math.round(m.posterior * 100)}% · #{m.id}
              </div>
              <div className="mt-2 flex gap-2">
                <button className="flex-1 rounded-xl bg-spore/20 px-3 py-3 text-spore ring-1 ring-spore/30" onClick={() => void vote(m, true)} data-testid="meaning-true">
                  {en ? 'True' : 'Prawda'}
                </button>
                <button className="flex-1 rounded-xl bg-rose/20 px-3 py-3 text-rose ring-1 ring-rose/30" onClick={() => void vote(m, false)} data-testid="meaning-false">
                  {en ? 'Lie' : 'Kłamstwo'}
                </button>
              </div>
              {msg[m.id] && (
                <div className="mt-1 text-xs text-violet" data-testid="meaning-msg">
                  {msg[m.id]}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}
