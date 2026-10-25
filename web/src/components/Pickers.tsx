// Zawężanie wielokrotnego wyboru: słowo → kategorie (drzewo WordNetu), zdanie → domena → intencja.
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useBrain } from '../myc/brain'
import { catName, INTENT_DOMAINS, pathName, pathOf, type Cat } from '../myc/lexicon'
import { neural, useNeural } from '../myc/neural'
import { Card } from './ui'

const btn = (on: boolean) => `rounded-xl border px-3 py-2 text-sm active:scale-95 ${on ? 'border-spore/60 bg-spore/15 text-glow' : 'border-white/10 bg-white/5 hover:border-spore/40'}`
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

/** Słowo: wybierz wszystkie pasujące kategorie; wybrane z podkategoriami zawężają się dalej. */
export function WordDrill({ qid, word, onDone }: { qid: string; word: string; onDone: () => void }) {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const tax = b.lex!.taxonomy
  const children = (p: string | null) => tax.map((c, i) => [c, i] as [Cat, number]).filter(([c]) => c.parent === p)
  const [level, setLevel] = useState<number[]>(() => children(null).map(([, i]) => i))
  const nn = useNeural()
  // kolejność kategorii wg modelu grzybni (bez wyróżniania, żeby nie sugerować odpowiedzi)
  const [order, setOrder] = useState<Map<number, number>>()
  useEffect(() => {
    let live = true
    if (nn.status === 'ready')
      void neural.word(word, '').then((p) => {
        if (!p || !live) return
        const sc = new Map<number, number>(Array.from(p.probs, (v, i) => [i, v]))
        for (const n of p.neighbours) sc.set(n.leaf, (sc.get(n.leaf) ?? 0) + Math.max(0, n.sim) / 15)
        setOrder(sc)
      })
    return () => {
      live = false
    }
  }, [word, nn.status])
  const shownLevel = order ? [...level].sort((a, b2) => (order.get(b2) ?? 0) - (order.get(a) ?? 0)) : level
  const [sel, setSel] = useState<number[]>([])
  const [shown, setShown] = useState<number[]>([])
  const [yes, setYes] = useState<number[]>([])
  const toggle = (i: number) => setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))
  const next = () => {
    const sh = [...shown, ...level]
    const y = [...yes, ...sel]
    const deeper = sel.flatMap((i) => children(tax[i].id).map(([, j]) => j))
    if (deeper.length) {
      setShown(sh)
      setYes(y)
      setLevel(deeper)
      setSel([])
    } else {
      b.answerWord(qid, sh, y)
      onDone()
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      if (e.key === 'Enter') next()
      else if (/^[1-9]$/.test(e.key) && shownLevel[Number(e.key) - 1] !== undefined) toggle(shownLevel[Number(e.key) - 1])
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })
  const crumbs = yes.length ? pathName(tax, yes, en) : ''
  return (
    <div data-testid="word-drill">
      <div className="text-lg text-slate-100">„{word}”</div>
      {crumbs && <div className="mt-1 text-xs text-spore">{crumbs}</div>}
      <div className="mt-1 text-xs text-slate-500">{en ? 'Select ALL that fit (or none), then Next.' : 'Zaznacz WSZYSTKIE pasujące (albo żadną) i kliknij Dalej.'}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {shownLevel.map((i, k) => (
          <button key={i} onClick={() => toggle(i)} aria-pressed={sel.includes(i)} className={btn(sel.includes(i))} data-cat={tax[i].id}>
            {k < 9 && <kbd className="mr-1.5 text-xs text-slate-500">{k + 1}</kbd>}
            {catName(tax[i], en)}
          </button>
        ))}
      </div>
      <button onClick={next} className="mt-3 rounded-xl bg-spore/90 px-4 py-2 text-sm font-medium text-ink hover:bg-spore" data-testid="word-next">
        {sel.length ? (en ? 'Next ↵' : 'Dalej ↵') : en ? 'None of these ↵' : 'Żadna z tych ↵'}
      </button>
    </div>
  )
}

/** Intencja: najpierw domena CLINC150, potem intencja w domenie. */
export function IntentDrill({ labels, labelTxt, guess, onAnswer }: { labels: string[]; labelTxt: (l: string) => string; guess?: string; onAnswer: (l: string) => void }) {
  const en = useI18n().lang === 'en'
  const doms = INTENT_DOMAINS.map((d) => ({
    ...d,
    labels: d.labels.filter((l) => labels.includes(l)),
  })).filter((d) => d.labels.length)
  const [dom, setDom] = useState<string | null>(null)
  const cur = doms.find((d) => d.id === dom)
  const opts = cur ? cur.labels : []
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      const i = Number(e.key) - 1
      if (!/^[1-9]$/.test(e.key)) return
      if (!cur && doms[i]) setDom(doms[i].id)
      else if (cur && opts[i]) onAnswer(opts[i])
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })
  return (
    <div data-testid="intent-drill">
      <div className="mb-2 text-xs text-slate-500">
        {cur ? (en ? `Domain: ${cur.en} – now the exact intent` : `Domena: ${cur.pl} – teraz dokładna intencja`) : en ? 'First pick the domain' : 'Najpierw wybierz dziedzinę'}
      </div>
      <div className="flex flex-wrap gap-2">
        {!cur &&
          doms.map((d, i) => (
            <button key={d.id} onClick={() => setDom(d.id)} className={btn(!!guess && d.labels.includes(guess))} data-domain={d.id}>
              <kbd className="mr-1.5 text-xs text-slate-500">{i + 1}</kbd>
              {en ? d.en : d.pl}
            </button>
          ))}
        {cur &&
          opts.map((l, i) => (
            <button key={l} onClick={() => onAnswer(l)} className={btn(false)} data-answer={l}>
              <kbd className="mr-1.5 text-xs text-slate-500">{i + 1}</kbd>
              {labelTxt(l)}
            </button>
          ))}
        {cur && (
          <button onClick={() => setDom(null)} className="rounded-xl px-3 py-2 text-sm text-slate-400 hover:text-slate-200">
            ← {en ? 'back' : 'wróć'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Wybór kategorii słowa (dla słów od nauczycieli). */
export function CatPicker({ onAnswer }: { onAnswer: (id: string) => void }) {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const tax = b.lex?.taxonomy ?? []
  return (
    <div className="flex flex-wrap gap-1.5">
      {tax.map((c, i) => (
        <button key={c.id} onClick={() => onAnswer(c.id)} className={`${btn(false)} !px-2 !py-1 text-xs`} data-answer={c.id} title={pathName(tax, [i], en)}>
          {catName(c, en)}
        </button>
      ))}
    </div>
  )
}

/** „Klasyfikuj słowo”: model zgaduje ścieżkę, użytkownik potwierdza albo poprawia (→ pytanie dla grzybni). */
export function ClassifyWord() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [w, setW] = useState('')
  const [fix, setFix] = useState('')
  const [msg, setMsg] = useState('')
  const tax = b.lex?.taxonomy ?? []
  const word = w.trim().toLowerCase()
  const ok = /^[\p{L}-]{3,30}$/u.test(word)
  const p = ok && b.words ? b.words.predict(word) : undefined
  const nn = useNeural()
  const [np, setNp] = useState<{
    w: string
    path: number[]
    leaf: number
    conf: number
    gloss: string
    top: [number, number][]
  }>()
  useEffect(() => {
    if (!ok || nn.status !== 'ready' || !tax.length) return
    let live = true
    const t = setTimeout(() => {
      void neural.word(word, '').then((r) => {
        if (!r || !live) return
        const c = neural.wordCat(tax, r)
        setNp({
          w: word,
          path: c.path,
          leaf: c.leaf,
          conf: c.conf,
          gloss: r.gloss,
          top: c.top,
        })
      })
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [word, ok, nn.status, tax]) // eslint-disable-line react-hooks/exhaustive-deps;
  const neu = np && np.w === word ? np : undefined
  const save = (cat: string) => {
    b.teach('word', word, cat)
    setW('')
    setFix('')
    setMsg(en ? 'Saved – other nodes will verify the category.' : 'Zapisano – inne węzły zweryfikują kategorię.')
  }
  return (
    <Card
      title={en ? 'Classify a word' : 'Klasyfikuj słowo'}
      right={
        b.words && (
          <span className="text-xs text-slate-500">
            {nn.versions.words && `${en ? 'mycelium model' : 'model grzybni'} ${pct(nn.versions.words.acc)} · `}
            Bayes {pct(b.words.acc)} ({en ? 'held-out' : 'test'})
          </span>
        )
      }
    >
      <p className="text-xs text-slate-400">
        {en
          ? 'Mycelium model (multilingual MiniLM embedding of the word and its Wiktionary definition + MLP trained by the nodes) picks the top category; the closest dictionary words pick the subcategory. Fallback: naive Bayes on character n-grams, trained in this browser.'
          : 'Model grzybni (wielojęzyczne osadzenie MiniLM słowa i jego definicji z Wikisłownika + sieć uczona przez węzły) wybiera kategorię główną; najbliższe słowa ze słownika – podkategorię. Zapas: naiwny Bayes na n-gramach znaków, uczony w tej przeglądarce.'}
        {nn.status !== 'ready' && (
          <button onClick={() => void neural.enable()} disabled={nn.status === 'loading'} className="ml-2 rounded-lg border border-spore/40 px-2 py-0.5 text-xs text-spore" data-testid="neural-enable">
            {nn.status === 'loading' ? `${Math.round(nn.progress * 100)}%` : en ? 'Use mycelium model (~140 MB)' : 'Użyj modelu grzybni (~140 MB)'}
          </button>
        )}
      </p>
      <input
        value={w}
        onChange={(e) => (setW(e.target.value), setMsg(''))}
        maxLength={30}
        placeholder={en ? 'e.g. hedgehog, jeż' : 'np. jeż, hedgehog'}
        className="mt-2 w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-sm text-slate-100"
        data-testid="word-input"
        aria-label={en ? 'Word' : 'Słowo'}
      />
      {p && (
        <div className="mt-2 text-sm" data-testid="word-pred">
          {p.known && (
            <div className="text-xs text-slate-400">
              {en ? 'in dictionary' : 'w słowniku'}: <b className="text-slate-200">{pathName(tax, p.known, en)}</b>
            </div>
          )}
          {neu && (
            <div data-testid="word-neural">
              {en ? 'Mycelium model' : 'Model grzybni'} v{nn.versions.words?.version}: <b className="text-spore">{pathName(tax, neu.path, en)}</b> ({pct(neu.conf)})
              <div className="text-xs text-slate-500">
                {neu.top
                  .slice(1)
                  .map(([i, v]) => `${catName(tax[i], en)} ${pct(v)}`)
                  .join(' · ')}
              </div>
              {neu.gloss && <div className="text-xs italic text-slate-500">Wiktionary: {neu.gloss}</div>}
            </div>
          )}
          <div className={neu ? 'text-xs text-slate-400' : ''}>
            {neu ? 'Bayes' : 'Model'}: <b className={neu ? '' : 'text-spore'}>{pathName(tax, p.path, en)}</b> ({pct(p.conf)})
          </div>
          {!neu && (
            <div className="text-xs text-slate-500">
              {p.top
                .slice(1)
                .map(([i, v]) => `${catName(tax[i], en)} ${pct(v)}`)
                .join(' · ')}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => save(tax[neu ? neu.leaf : p.leaf].id)} className="rounded-xl border border-spore/40 px-3 py-1.5 text-sm text-spore hover:bg-spore/10" data-testid="word-correct">
              {en ? 'Correct' : 'Poprawnie'}
            </button>
            <select value={fix} onChange={(e) => setFix(e.target.value)} className="rounded-lg border border-white/10 bg-ink/60 px-2 py-1.5 text-sm" aria-label={en ? 'Correct category' : 'Poprawna kategoria'}>
              <option value="">{en ? '— wrong? pick category —' : '— źle? wybierz kategorię —'}</option>
              {tax.map((c, i) => (
                <option key={c.id} value={c.id}>
                  {pathName(tax, pathOf(tax, i), en)}
                </option>
              ))}
            </select>
            {fix && (
              <button onClick={() => save(fix)} className="rounded-xl border border-amber/40 px-3 py-1.5 text-sm text-amber" data-testid="word-fix">
                {en ? 'Teach' : 'Naucz'}
              </button>
            )}
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-spore">{msg}</p>}
    </Card>
  )
}
