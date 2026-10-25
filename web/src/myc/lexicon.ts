// Słowniki (OEWN 2025 + plWordNet/OMW + VADER) i klasyfikator słów w przeglądarce:
// wielomianowy naiwny Bayes na n-gramach znaków (2–4), uczony na słowach ze słowników
// + słowach z konsensusu grzybni. Wynik: liść taksonomii i ścieżka (np. Zwierzę › Ssak › Pies).
export interface Cat {
  id: string
  parent: string | null
  pl: string
  en: string
}
export interface Lexicon {
  version: number
  taxonomy: Cat[]
  words: [string, string, number[]][]
  questions: { id: string; word: string; lang: string }[]
  sentiment: Record<string, number>
  sources: string[]
}

export const wordQid = (qid: string, cat: number) => `${qid}c${String(cat).padStart(3, '0')}`

export function grams(w: string): string[] {
  const s = `^${w.toLowerCase().trim()}$`
  const out: string[] = []
  for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n))
  return out
}

/** Ścieżka od korzenia do kategorii (indeksy taksonomii). */
export function pathOf(tax: Cat[], leaf: number): number[] {
  const idx = new Map(tax.map((c, i) => [c.id, i]))
  const out: number[] = []
  let c: number | undefined = leaf
  while (c !== undefined) {
    out.unshift(c)
    const p: string | null = tax[c].parent
    c = p ? idx.get(p) : undefined
  }
  return out
}

/** Najgłębsza kategoria ścieżki (liść) – ścieżki są domknięte w górę. */
export function leafOf(tax: Cat[], path: number[]): number {
  const depth = (i: number) => pathOf(tax, i).length
  return path.reduce((a, b) => (depth(b) > depth(a) ? b : a), path[0])
}

export class WordNB {
  private counts: Map<string, Float64Array> = new Map()
  private totals: Float64Array
  private prior: Float64Array
  private V = 1
  private k: number
  constructor(k: number) {
    this.k = k
    this.totals = new Float64Array(k)
    this.prior = new Float64Array(k)
  }
  fit(words: string[], y: number[]): this {
    for (let i = 0; i < words.length; i++) {
      const c = y[i]
      this.prior[c]++
      for (const g of grams(words[i])) {
        let a = this.counts.get(g)
        if (!a) this.counts.set(g, (a = new Float64Array(this.k)))
        a[c]++
        this.totals[c]++
      }
    }
    this.V = this.counts.size
    return this
  }
  proba(w: string): Float64Array {
    const n = this.prior.reduce((a, b) => a + b, 0) || 1
    const lp = new Float64Array(this.k)
    for (let c = 0; c < this.k; c++) lp[c] = Math.log((this.prior[c] + 1) / (n + this.k))
    for (const g of grams(w)) {
      const a = this.counts.get(g)
      for (let c = 0; c < this.k; c++) lp[c] += Math.log(((a?.[c] ?? 0) + 0.5) / (this.totals[c] + 0.5 * this.V))
    }
    const m = Math.max(...lp)
    let z = 0
    for (let c = 0; c < this.k; c++) z += lp[c] = Math.exp(lp[c] - m)
    for (let c = 0; c < this.k; c++) lp[c] /= z
    return lp
  }
}

export interface WordPred {
  leaf: number
  path: number[]
  conf: number
  top: [number, number][]
  known?: number[]
}

export class WordAgent {
  nb: WordNB
  dict = new Map<string, number[]>()
  acc = 0
  private lex: Lexicon
  constructor(lex: Lexicon, extra: [string, number][] = []) {
    this.lex = lex
    const tax = lex.taxonomy
    const train: [string, number][] = []
    const test: [string, number][] = []
    lex.words.forEach(([w, , path], i) => {
      this.dict.set(w, path)
      ;(i % 10 === 0 ? test : train).push([w, leafOf(tax, path)])
    })
    const all = [...train, ...extra]
    this.nb = new WordNB(tax.length).fit(
      all.map(([w]) => w),
      all.map(([, y]) => y),
    )
    let hit = 0
    for (const [w, y] of test) if (argmax(this.nb.proba(w)) === y) hit++
    this.acc = test.length ? hit / test.length : 0
  }
  predict(w: string): WordPred {
    const p = this.nb.proba(w)
    const order = [...p.keys()].sort((a, b) => p[b] - p[a])
    const leaf = order[0]
    const known = this.dict.get(w.toLowerCase().trim())
    return { leaf, path: pathOf(this.lex.taxonomy, leaf), conf: p[leaf], top: order.slice(0, 3).map((i) => [i, p[i]]), known }
  }
  sentiment(w: string): number | undefined {
    return this.lex.sentiment[w.toLowerCase().trim()]
  }
}

function argmax(p: ArrayLike<number>): number {
  let b = 0
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i
  return b
}

export const catName = (c: Cat, en: boolean) => (en ? c.en : c.pl)
export const pathName = (tax: Cat[], path: number[], en: boolean) => path.map((i) => catName(tax[i], en)).join(' › ')

/** Domeny CLINC150 dla zawężania intencji (domena → intencja). */
export const INTENT_DOMAINS: { id: string; pl: string; en: string; labels: string[] }[] = [
  { id: 'utility', pl: 'Narzędzia', en: 'Utility', labels: ['weather', 'alarm', 'timer'] },
  { id: 'home', pl: 'Dom', en: 'Home', labels: ['play_music', 'calendar', 'smart_home'] },
  { id: 'travel', pl: 'Podróże', en: 'Travel', labels: ['translate', 'travel_alert'] },
  { id: 'kitchen_and_dining', pl: 'Kuchnia i jedzenie', en: 'Kitchen & dining', labels: ['restaurant_reservation'] },
  { id: 'meta', pl: 'Ustawienia', en: 'Meta', labels: ['change_volume'] },
]
