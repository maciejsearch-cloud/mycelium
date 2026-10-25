// Wyszukiwanie faktów grzybni (BM25) – podstawa odpowiedzi modelu i trybu bez modelu.
export interface Doc {
  id: string
  text: string
  alt?: string
  truth: string
  p: number
  votes: number
  source: string
  /** wpis ze słownika (nie z głosowania) */
  dict?: boolean
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
const STOP = new Set('i w z na do to jest sa czy nie tak a o od po za ze sie jak co the a an is are of to in on and or for be it what who does do with jaki jaka jakie'.split(' '))

export function tokens(s: string): string[] {
  return (strip(s).match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => t.slice(0, 6))
}

export class Index {
  private docs: Doc[] = []
  private tf: Map<string, number>[] = []
  private df = new Map<string, number>()
  private avg = 1
  constructor(docs: Doc[]) {
    this.docs = docs
    let total = 0
    for (const d of docs) {
      const m = new Map<string, number>()
      for (const t of tokens(`${d.text} ${d.alt ?? ''}`)) m.set(t, (m.get(t) ?? 0) + 1)
      this.tf.push(m)
      total += [...m.values()].reduce((a, b) => a + b, 0)
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
    this.avg = total / Math.max(1, docs.length)
  }
  /** score: BM25; cover: udział wag idf słów pytania, które występują w fakcie (0–1) – miara trafności */
  search(q: string, k = 5): (Doc & { score: number; cover: number })[] {
    const qt = [...new Set(tokens(q))]
    const N = this.docs.length
    const idfOf = (t: string) => Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))
    const total = qt.reduce((a, t) => a + idfOf(t), 0) || 1
    const res: (Doc & { score: number; cover: number })[] = []
    this.docs.forEach((d, i) => {
      const m = this.tf[i]
      const len = [...m.values()].reduce((a, b) => a + b, 0)
      let s = 0
      let hit = 0
      for (const t of qt) {
        const f = m.get(t)
        if (!f) continue
        const idf = idfOf(t)
        hit += idf
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * len) / this.avg))
      }
      if (s > 0) res.push({ ...d, score: s, cover: hit / total })
    })
    return res.sort((a, b) => b.score * (0.5 + b.cover) - a.score * (0.5 + a.cover)).slice(0, k)
  }
}
