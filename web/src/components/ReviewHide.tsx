// Weryfikuj – narzędzia Developera: ukryj pozycję kolejki z powodem (miękko, z dziennikiem kto/kiedy/dlaczego)
// i przywróć ją. Uprawnienie sprawdza baza (rola Developer na czacie albo klucz właściciela).
import { useState } from 'react'
import { hiddenList, reviewHide, reviewRestore, type HiddenRow } from '../myc/rozmowaApi'
import { ownerKey } from '../myc/store'
import type { ReviewItem } from '../myc/review'

const key = () => ownerKey.get() || null

/** Sprawdza w bazie, czy ta sesja może ukrywać (lista ukrytych zwraca się tylko Developerowi/właścicielowi). */
export const probeHidden = (room: 'main' | 'e2e') => hiddenList(key(), room)

export function HideItem({ item, room, en, onHidden }: { item: ReviewItem; room: 'main' | 'e2e'; en: boolean; onHidden: () => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState('')
  const [err, setErr] = useState('')
  const go = async () => {
    setErr('')
    try {
      await reviewHide(key(), item.type, item.ref, why.trim(), room)
      setOpen(false)
      setWhy('')
      onHidden()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="card text-sm" data-testid="review-hide">
      {!open ? (
        <button className="text-xs text-slate-400 underline" onClick={() => setOpen(true)} data-testid="review-hide-open">
          {L('Developer: usuń tę pozycję z weryfikacji…', 'Developer: remove this item from review…')}
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} placeholder={L('Powód (zapisywany w dzienniku)', 'Reason (logged)')} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2" data-testid="review-hide-reason" />
          <button className="rounded-xl bg-rose/15 px-3 py-2 text-rose ring-1 ring-rose/30 disabled:opacity-50" disabled={!why.trim()} onClick={() => void go()} data-testid="review-hide-go">
            {L('ukryj', 'hide')}
          </button>
          <button className="px-2 text-slate-400" onClick={() => setOpen(false)}>
            {L('anuluj', 'cancel')}
          </button>
          <p className="w-full text-xs text-slate-500">{L('Pozycja zniknie z kolejki dla wszystkich; da się ją przywrócić poniżej. Nic nie jest kasowane.', 'The item leaves everyone’s queue; it can be restored below. Nothing is deleted.')}</p>
        </div>
      )}
      {err && <p className="text-rose">{err}</p>}
    </div>
  )
}

export function HiddenList({ rows, room, en, onChange }: { rows: HiddenRow[]; room: 'main' | 'e2e'; en: boolean; onChange: () => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [err, setErr] = useState('')
  return (
    <details className="card" data-testid="review-hidden">
      <summary className="cursor-pointer text-sm text-slate-300">
        {L('Ukryte z weryfikacji', 'Hidden from review')} ({rows.filter((r) => !r.restored_at).length})
      </summary>
      <div className="mt-2 space-y-1.5 text-xs text-slate-400">
        {rows.length === 0 && <p>{L('Nic nie ukryto.', 'Nothing hidden.')}</p>}
        {rows.map((r) => (
          <div key={`${r.item_type}|${r.item_ref}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 p-2">
            <b className="text-slate-200">
              {r.item_type} · {r.item_ref}
            </b>
            <span>„{r.reason}”</span>
            <span>
              {r.hidden_by} · {new Date(r.hidden_at).toLocaleString('pl-PL', { timeZone: 'Europe/Amsterdam' })}
            </span>
            {r.restored_at ? (
              <span className="text-spore">
                {L('przywrócone', 'restored')} ({r.restored_by}, {new Date(r.restored_at).toLocaleString('pl-PL', { timeZone: 'Europe/Amsterdam' })})
              </span>
            ) : (
              <button className="ml-auto rounded-full border border-white/15 px-2.5 py-1" onClick={() => void reviewRestore(key(), r.item_type, r.item_ref, room).then(onChange, (e) => setErr(String(e.message)))} data-testid="review-restore">
                {L('przywróć', 'restore')}
              </button>
            )}
          </div>
        ))}
        {err && <p className="text-rose">{err}</p>}
      </div>
    </details>
  )
}
