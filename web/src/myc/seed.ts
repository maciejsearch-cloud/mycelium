// Kuratorowane drzewo kategorii (seed): polskie nazwy z WordNetu/plWordNetu/Wikidata, każda z pochodzeniem
// (scripts/build_seed_taxonomy.py → public/data/taxo/seed.json). Zaufanie średnie – można głosować w Weryfikuj.
// Tu: odczyt, ścieżki, propozycje kategorii dla słowa liczone modelem (te same cechy co budowniczy) i wyszukiwanie.
import { hypersOf, taxoEmb, type Cand, type CatEntry, type TaxoInputs } from './taxo'

export interface SeedCat {
  id: number
  parent: number
  lvl: number
  pl: string
  en: string
  label_src: 'wikidata+wordnet' | 'plwordnet' | 'korekta'
  synset: string
  n: number
  qid?: string
  plwiki_cat?: string
  wd_parent_ok?: boolean
}
export interface Seed {
  version: number
  built: string
  rule: string
  trust: number
  sources: { name: string; licence: string; url: string }[]
  cats: SeedCat[]
  map: number[]
  stats: Record<string, number>
}

let seedP: Promise<Seed | undefined> | undefined
export const taxoSeed = () =>
  (seedP ??= fetch(`${import.meta.env.BASE_URL}data/taxo/seed.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Seed>) : undefined))
    .catch(() => undefined))

export function seedPath(seed: Seed, c: number, en = false): string {
  const out: string[] = []
  for (let x = c; x >= 0; x = seed.cats[x].parent) out.unshift(en ? seed.cats[x].en : seed.cats[x].pl)
  return out.join(' › ')
}

export const seedSrc = (c: SeedCat, en = false) =>
  c.label_src === 'wikidata+wordnet' ? 'Wikidata + WordNet' : c.label_src === 'plwordnet' ? 'plWordNet' : en ? 'name fixed by hand' : 'nazwa poprawiona ręcznie'

/** Kategoria seed słowa (−1 = źródła się nie zgadzają / brak). */
export const seedOf = (seed: Seed, i: number) => seed.map[i] ?? -1

// ---------------------------------------------------------------- propozycje z modelu
interface SeedModel {
  sum: Float32Array[]
  cnt: number[]
  feat: (i: number) => { dense: Float32Array; sparse: [number, number][] }
}
let modelP: Promise<SeedModel> | undefined
async function seedModel(seed: Seed, inp: TaxoInputs, beta = 6): Promise<SeedModel> {
  return (modelP ??= (async () => {
    const E = await taxoEmb(inp.words.length)
    const n = inp.words.length
    const df = new Map<number, number>()
    for (const h of inp.hyper.idx) df.set(h, (df.get(h) ?? 0) + 1)
    const V = inp.hyper.names.length
    const sb = Math.sqrt(beta)
    // cechy jak w budowniczym: [osadzenie, √beta · znormalizowany tf-idf hiperonimów], całość znormalizowana
    const feat = (i: number) => {
      const hs = hypersOf(inp, i)
      const w = hs.map((h) => Math.log(n / (df.get(h) ?? 1)))
      const s = Math.sqrt(w.reduce((a, x) => a + x * x, 0)) || 1
      const sp: [number, number][] = hs.map((h, k) => [h, (sb * w[k]) / s])
      const norm = Math.sqrt(1 + sp.reduce((a, [, x]) => a + x * x, 0))
      const dense = new Float32Array(384)
      for (let d = 0; d < 384; d++) dense[d] = E[i * 384 + d] / norm
      return { dense, sparse: sp.map(([h, x]) => [h, x / norm] as [number, number]) }
    }
    const ev = new Set(inp.eval)
    const sum = seed.cats.map(() => new Float32Array(384 + V))
    const cnt = seed.cats.map(() => 0)
    seed.map.forEach((c, i) => {
      if (c < 0 || ev.has(i)) return
      const f = feat(i)
      const a = sum[c]
      for (let d = 0; d < 384; d++) a[d] += f.dense[d]
      for (const [h, x] of f.sparse) a[384 + h] += x
      cnt[c]++
    })
    return { sum, cnt, feat }
  })())
}

/**
 * Kategorie seed najlepiej pasujące do słowa według modelu: klasyfikator „najbliższy środek” na słowach spoza zbioru
 * oceny (bez wkładu samego słowa), pewność = softmax podobieństw po wszystkich kategoriach (T = 0,03).
 */
export async function rankSeed(seed: Seed, inp: TaxoInputs, i: number, en: boolean, k = 5): Promise<Cand[]> {
  const m = await seedModel(seed, inp)
  const f = m.feat(i)
  const own = seedOf(seed, i)
  const sp = new Map(f.sparse)
  const sc = seed.cats.map((c) => {
    if (!m.cnt[c.id]) return { c, s: -1 }
    const a = m.sum[c.id]
    const self = c.id === own && !inp.eval.includes(i)
    let dot = 0
    let nn = 0
    for (let d = 0; d < 384; d++) {
      const x = self ? a[d] - f.dense[d] : a[d]
      dot += x * f.dense[d]
      nn += x * x
    }
    for (let d = 384; d < a.length; d++) {
      const v = sp.get(d - 384) ?? 0
      const x = self ? a[d] - v : a[d]
      if (x) {
        dot += x * v
        nn += x * x
      }
    }
    return { c, s: nn > 0 ? dot / Math.sqrt(nn) : -1 }
  })
  sc.sort((a, b) => b.s - a.s)
  const T = 0.03
  const z = sc.reduce((a, x) => a + (x.s > -1 ? Math.exp((x.s - sc[0].s) / T) : 0), 0)
  const out: Cand[] = []
  for (const { c, s } of sc) {
    const p = Math.exp((s - sc[0].s) / T) / z
    if (out.length >= 2 && p < 0.03) break // bez przypadkowych kategorii
    out.push({ value: `s:${c.id}`, label: seedPath(seed, c.id, en), p, src: c.id === own ? 'current' : 'model', members: seedMembers(seed, inp, c.id, i) })
    if (out.length >= k) break
  }
  return out
}

let memCache: Map<number, number[]> | undefined
export function seedMembers(seed: Seed, inp: TaxoInputs, c: number, except = -1, k = 8): string[] {
  if (!memCache) {
    memCache = new Map()
    seed.map.forEach((x, i) => x >= 0 && (memCache!.get(x) ?? memCache!.set(x, []).get(x)!).push(i))
  }
  return [...new Set((memCache.get(c) ?? []).filter((j) => j !== except).map((j) => inp.words[j][0]))].slice(0, k)
}

/** Kategoria seed słowa jako propozycja (źródło: WordNet/Wikidata). */
export function seedCand(seed: Seed, inp: TaxoInputs, i: number, en: boolean): Cand | undefined {
  const c = seedOf(seed, i)
  if (c < 0) return undefined
  return { value: `s:${c}`, label: seedPath(seed, c, en), src: 'wordnet', members: seedMembers(seed, inp, c, i) }
}

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').toLowerCase()
export function seedCatalog(seed: Seed, en: boolean): CatEntry[] {
  return seed.cats.map((c) => ({ value: `s:${c.id}`, label: seedPath(seed, c.id, en), kind: 'seed' as const, key: fold(`${seedPath(seed, c.id)} ${c.en}`) }))
}
