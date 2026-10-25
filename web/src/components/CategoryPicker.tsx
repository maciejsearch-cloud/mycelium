import { useEffect, useMemo, useState } from 'react'
import { catalog, searchCats, taxoInputs, type Cand, type TaxoInputs, type TaxoVersion } from '../myc/taxo'
import { rankSeed, seedCand, seedCatalog, type Seed } from '../myc/seed'

/**
 * Wybór kategorii dla słowa: kategorie drzewa seed najwyżej ocenione przez model (z pewnością %), kategoria ze źródeł (seed),
 * wyszukiwanie wśród istniejących kategorii (PL+EN) i nowa własna kategoria (nazwa + opcjonalny rodzic).
 * `onPick(value, label)` – value w formacie budowniczego: s:<seed> | c:<v>:<id> | g:<id> | h:<idx> | own:<nazwa>|<rodzic>.
 */
export function CategoryPicker({ v, seed, i, en, value, onPick }: { v: TaxoVersion; seed?: Seed; i: number; en: boolean; value: string; onPick: (value: string, label: string) => void }) {
  const [inp, setInp] = useState<TaxoInputs>()
  const [cands, setCands] = useState<Cand[] | null>(null)
  const [err, setErr] = useState('')
  const [peek, setPeek] = useState<string>()
  const [q, setQ] = useState('')
  const [newName, setNewName] = useState('')
  const [parent, setParent] = useState<{ value: string; label: string }>()
  useEffect(() => {
    let live = true
    void taxoInputs()
      .then(async (x) => {
        if (!live) return
        setInp(x)
        const m = seed ? await rankSeed(seed, x, i, en, 5) : []
        if (live) setCands(m)
      })
      .catch((e) => live && (setErr(String(e)), setCands([])))
    return () => {
      live = false
    }
  }, [seed, i, en])
  const cat = useMemo(() => (inp ? [...(seed ? seedCatalog(seed, en) : []), ...catalog(v, inp, en)] : []), [inp, v, seed, en])
  const hits = useMemo(() => searchCats(cat, q), [cat, q])
  const sc = inp && seed ? seedCand(seed, inp, i, en) : undefined
  const wn = sc ? [sc] : []
  const btn = (c: Cand, testid: string) => (
    <li key={c.value} className="flex items-stretch gap-1">
      <button onClick={() => onPick(c.value, c.label)} className={`flex-1 rounded-xl px-3 py-2.5 text-left text-sm ${value === c.value ? 'bg-amber/20 text-amber ring-1 ring-amber/40' : 'bg-white/5 text-slate-200'}`} data-testid={testid} data-value={c.value}>
        <span className="flex items-baseline justify-between gap-2">
          <span>{c.label}</span>
          <span className="shrink-0 text-xs text-slate-400">{c.p != null ? `${Math.max(1, Math.round(c.p * 100))}%` : 'seed'}{c.src === 'current' ? (en ? ' · now' : ' · teraz') : ''}</span>
        </span>
      </button>
      {c.members && c.members.length > 0 && (
        <button onClick={() => setPeek(peek === c.value ? undefined : c.value)} className="rounded-xl bg-white/5 px-2 text-xs text-slate-400" aria-label={en ? 'show members' : 'pokaż słowa'} data-testid="cand-peek">
          {peek === c.value ? '▴' : '▾'}
        </button>
      )}
    </li>
  )
  const peeked = [...(cands ?? []), ...wn].find((c) => c.value === peek)
  const ownVal = newName.trim() ? `own:${newName.trim().slice(0, 80)}${parent ? `|${parent.value}` : ''}` : ''
  return (
    <div className="space-y-3" data-testid="category-picker">
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">{en ? 'Model’s best guesses' : 'Najwyżej ocenione przez AI'}</div>
        {cands === null ? (
          <p className="text-xs text-slate-500">{en ? 'scoring categories…' : 'liczę dopasowanie kategorii…'}</p>
        ) : cands.length === 0 ? (
          <p className="text-xs text-slate-500">{en ? 'no data' : 'brak danych'}{err ? ` (${err})` : ''}</p>
        ) : (
          <ul className="space-y-1" data-testid="cand-model">{cands.map((c) => btn(c, 'cand'))}</ul>
        )}
        {peeked && (
          <p className="mt-1 rounded-lg bg-black/30 p-2 text-xs text-slate-300" data-testid="cand-members">
            {en ? 'words there' : 'słowa w tej grupie'}: {peeked.members!.join(', ')}
          </p>
        )}
      </div>
      {wn.length > 0 && (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">{en ? 'From sources (seed: WordNet/Wikidata, medium trust)' : 'Ze źródeł (seed: WordNet/Wikidata, zaufanie średnie)'}</div>
          <ul className="space-y-1" data-testid="cand-wordnet">{wn.map((c) => btn(c, 'cand'))}</ul>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-white/10 p-2" data-testid="own-category">
        <div className="text-xs uppercase tracking-wider text-slate-500">{en ? 'Your own category' : 'Własna kategoria'}</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={en ? 'search existing (PL or EN), e.g. motyl' : 'szukaj istniejącej (PL lub EN), np. motyl'} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-base" data-testid="cat-search" />
        {q.trim().length >= 2 && (
          <ul className="space-y-1" data-testid="cat-hits">
            {hits.length === 0 && <li className="text-xs text-slate-500">{en ? 'nothing found – create it below' : 'nic nie znaleziono – utwórz poniżej'}</li>}
            {hits.map((h) => (
              <li key={h.value} className="flex gap-1">
                <button onClick={() => onPick(h.value, h.label)} className={`flex-1 rounded-lg px-2 py-2 text-left text-sm ${value === h.value ? 'bg-amber/20 text-amber' : 'bg-white/5 text-slate-200'}`} data-testid="cat-hit">
                  {h.label} <span className="text-[11px] text-slate-500">{h.kind === 'seed' ? 'seed' : h.kind === 'group' ? (en ? 'group' : 'grupa') : h.kind === 'wordnet' ? 'WordNet' : en ? 'hypernym' : 'hiperonim'}</span>
                </button>
                <button onClick={() => setParent(h)} className="rounded-lg bg-white/5 px-2 text-[11px] text-slate-400" data-testid="cat-as-parent">
                  {en ? 'as parent' : 'jako rodzic'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={en ? 'new category name' : 'nazwa nowej kategorii'} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-base" data-testid="new-cat-name" maxLength={80} />
          <button disabled={!ownVal} onClick={() => onPick(ownVal, `${parent ? `${parent.label} › ` : ''}${newName.trim()}`)} className={`rounded-xl px-3 text-sm disabled:opacity-40 ${value === ownVal && ownVal ? 'bg-amber/20 text-amber' : 'bg-white/10 text-slate-200'}`} data-testid="new-cat-use">
            {en ? 'Use' : 'Użyj'}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          {en ? 'parent' : 'rodzic'}: {parent ? parent.label : en ? 'none (pick “as parent” in search)' : 'brak (wybierz „jako rodzic” w wyszukiwaniu)'}
          {parent && (
            <button onClick={() => setParent(undefined)} className="ml-2 underline">
              {en ? 'clear' : 'usuń'}
            </button>
          )}
        </p>
      </div>
    </div>
  )
}
