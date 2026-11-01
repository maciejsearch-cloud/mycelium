// Samoorganizująca się taksonomia słów: wersje liczone na węzłach (src/iot_mycelium/mesh/taxo.py),
// publikowane po niezależnym przeliczeniu metryk. Tu: odczyt wersji, drzewa i pozycje do Weryfikuj.
import { SB_URL } from './store'
import { fragRpc } from './frags'

export interface TaxoRow {
  id: number
  version: number | null
  status: 'pending' | 'published' | 'rejected' | 'expired'
  path: string | null
  acc: number | null
  nmi: number | null
  purity: number | null
  metrics: { acc?: number; nmi_cat?: number; purity_cat?: number; nmi_leaf?: number; n_nodes?: number; n_leaves?: number; by_level?: Record<string, number>; named_hyper?: number; eval_n?: number }
  params: { beta?: number; k1?: number; min?: number; frag?: number }
  n_corr: number
  proposer: string
  verifier: string | null
  verify_acc: number | null
  reason: string | null
  ms: number | null
  created_at: string
  decided_at: string | null
}
export interface TaxoNode {
  id: number
  p: number
  lvl: number
  n: number
  coh: number
  top: number[]
  leaf?: boolean
  name_pl: string
  name_en: string
  cov: number
  src: 'hyper' | 'medoid' | 'owner' | 'seed' | 'auto'
  /** id kategorii w drzewie seed (src = 'seed') */
  seed?: number
  qid?: string
  label_src?: string
  /** grupa automatyczna bez nazwy ze źródła ani od człowieka – tylko wewnętrznie, nie pokazujemy jej nazwy */
  hidden?: boolean
  owner_name?: boolean
  merged?: boolean
  hyper?: number
  /** nazwa z pliku wersji (przed nadaniem czytelnej nazwy w UI) */
  raw_pl?: string
  raw_en?: string
}
export interface TaxoVersion {
  version: number
  params: TaxoRow['params']
  metrics: TaxoRow['metrics']
  nodes: TaxoNode[]
  leaf: number[]
  margin: number[]
  n_corr: number
  /** własne kategorie słów (poprawki właściciela): indeks słowa → nazwa */
  own?: Record<string, string>
  /** słowa zgłoszone jako „to nie jest słowo” */
  bad?: number[]
}
export interface TaxoInputs {
  words: [string, 'pl' | 'en'][]
  gold: number[]
  taxonomy: { id: string; parent: string | null; pl: string; en: string }[]
  eval: number[]
  sources: string[]
  hyper: { names: [string, string][]; ptr: number[]; idx: number[] }
}

export const LEVEL: [string, string][] = [
  ['temat', 'topic'],
  ['kategoria', 'category'],
  ['podkategoria', 'subcategory'],
  ['strzępek', 'fragment'],
]

export const taxoList = () => fragRpc<TaxoRow[]>('myc_tax_list', { p_limit: 200 })
const vcache = new Map<string, Promise<TaxoVersion>>()
export function taxoVersion(path: string) {
  let p = vcache.get(path)
  if (!p) {
    p = fetch(`${SB_URL}/storage/v1/object/public/myc-models/${path}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<TaxoVersion>
      })
      .then(readable)
    vcache.set(path, p)
  }
  return p
}

let inputs: Promise<TaxoInputs> | undefined
export const taxoInputs = () =>
  (inputs ??= fetch(`${import.meta.env.BASE_URL}data/taxo/inputs.json`).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json() as Promise<TaxoInputs>
  }))

export const nodeName = (n: TaxoNode, en: boolean) => (n.hidden ? (en ? 'unnamed group' : 'grupa bez nazwy') : en ? n.name_en : n.name_pl)

/** Rdzeń nazwy bez dopisku „(słowo)” – do wykrywania powtórzeń w ścieżce. */
const stem = (s: string) => s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()

/** Ścieżka bez powtórzeń („X › X” → „X”); zostaje ostatni, najbardziej szczegółowy element. */
export function pathLabel(nodes: TaxoNode[], en: boolean): string {
  const out: string[] = []
  for (const n of nodes) {
    if (n.hidden) continue // grupy automatyczne bez nazwy nie trafiają do ścieżki
    const name = nodeName(n, en)
    const last = out[out.length - 1]
    // powtórzenia nazwy i kolejne grupy bez nazwy („≈ …”) zwijamy do najgłębszej
    if (out.length && (stem(last) === stem(name) || (last.startsWith('≈') && name.startsWith('≈')))) out[out.length - 1] = name
    else out.push(name)
  }
  return out.join(' › ')
}

/** Członkowie węzła (słowa w liściach poddrzewa). */
export function membersOf(v: TaxoVersion): number[][] {
  const out: number[][] = v.nodes.map(() => [])
  v.leaf.forEach((lf, i) => {
    for (let x = lf; x >= 0; x = v.nodes[x].p) out[x].push(i)
  })
  return out
}

/**
 * Widoczne nazwy: tylko kategorie z drzewa seed (WordNet/plWordNet/Wikidata, z pochodzeniem) i nazwy nadane przez
 * człowieka. Grupy automatyczne (dawniej „~jalapa”, nazwy zgadywane z hiperonimu albo z członków) są tylko wewnętrzne.
 */
export function readable(v: TaxoVersion): TaxoVersion {
  for (const n of v.nodes) {
    if (n.raw_pl !== undefined) return v
    n.raw_pl = n.name_pl
    n.raw_en = n.name_en
    n.hidden = !(n.src === 'seed' || n.src === 'owner' || n.owner_name)
  }
  return v
}

/** Hiperonimy słowa z WordNetu (indeksy w inputs.hyper.names). */
export const hypersOf = (inp: TaxoInputs, i: number) => inp.hyper.idx.slice(inp.hyper.ptr[i], inp.hyper.ptr[i + 1])

/** Ścieżka kategorii słownikowej (np. „Zwierzę › Owad”). */
export function goldPath(inp: TaxoInputs, g: number, en: boolean): string {
  const byId = new Map(inp.taxonomy.map((t) => [t.id, t]))
  const out: string[] = []
  for (let t: TaxoInputs['taxonomy'][number] | undefined = inp.taxonomy[g]; t; t = t.parent ? byId.get(t.parent) : undefined) out.unshift(en ? t.en : t.pl)
  return out.join(' › ')
}

// ---------------------------------------------------------------- ocena kandydatów przez model (osadzenia)
let embP: Promise<Float32Array> | undefined
/** Osadzenia słów (MiniLM, int8 → znormalizowane float32), te same co w budowniczym taksonomii. */
export function taxoEmb(n: number, dim = 384) {
  return (embP ??= fetch(`${import.meta.env.BASE_URL}data/taxo/emb.bin`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.arrayBuffer()
    })
    .then((buf) => {
      const q = new Int8Array(buf)
      const e = new Float32Array(n * dim)
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let d = 0; d < dim; d++) s += q[i * dim + d] ** 2
        const k = 1 / Math.sqrt(s || 1)
        for (let d = 0; d < dim; d++) e[i * dim + d] = q[i * dim + d] * k
      }
      return e
    }))
}

export interface Cand {
  value: string
  label: string
  /** pewność modelu (softmax podobieństw do kategorii), dla WordNetu brak */
  p?: number
  src: 'model' | 'wordnet' | 'current'
  members?: string[]
  node?: number
}

export function pathOfWord(v: TaxoVersion, i: number): TaxoNode[] {
  const out: TaxoNode[] = []
  let x: number = v.leaf[i]
  while (x >= 0) {
    out.unshift(v.nodes[x])
    x = v.nodes[x].p
  }
  return out
}

/** Najnowsza opublikowana wersja (z drzewem) i poprzednia – do wykrywania nowych kategorii. */
export async function latestTaxo(rows?: TaxoRow[]) {
  rows ??= await taxoList()
  const pub = rows.filter((r) => r.status === 'published' && r.path).sort((a, b) => b.version! - a.version!)
  if (!pub.length) return undefined
  const [cur, prev] = await Promise.all([taxoVersion(pub[0].path!), pub[1] ? taxoVersion(pub[1].path!).catch(() => undefined) : Promise.resolve(undefined)])
  return { row: pub[0], cur, prev }
}

export interface CatEntry {
  value: string
  label: string
  kind: 'seed' | 'group' | 'wordnet' | 'hyper'
  key: string
}
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').toLowerCase()
/** Wszystkie istniejące kategorie do podpowiedzi (grupy tej wersji, kategorie słownikowe, hiperonimy PL+EN). */
export function catalog(v: TaxoVersion, inp: TaxoInputs, en: boolean): CatEntry[] {
  const out: CatEntry[] = []
  for (const n of v.nodes) {
    if (n.lvl < 1 || n.hidden) continue
    const path: TaxoNode[] = []
    for (let x = n.id; x >= 0; x = v.nodes[x].p) path.unshift(v.nodes[x])
    const label = pathLabel(path, en)
    out.push({ value: `c:${v.version}:${n.id}`, label, kind: 'group', key: fold(`${label} ${n.raw_pl ?? ''} ${n.raw_en ?? ''} ${n.name_en}`) })
  }
  inp.taxonomy.forEach((t, g) => out.push({ value: `g:${t.id}`, label: goldPath(inp, g, en), kind: 'wordnet', key: fold(`${t.pl} ${t.en}`) }))
  inp.hyper.names.forEach(([hen, hpl], h) => out.push({ value: `h:${h}`, label: (en ? hen : hpl || hen) + (!en && !hpl ? ' (EN)' : ''), kind: 'hyper', key: fold(`${hpl} ${hen}`) }))
  return out
}
export function searchCats(cat: CatEntry[], q: string, k = 8): CatEntry[] {
  const f = fold(q.trim())
  if (f.length < 2) return []
  const starts: CatEntry[] = []
  const has: CatEntry[] = []
  for (const c of cat) {
    if (c.key.split(/[\s›()]+/).some((w) => w.startsWith(f))) starts.push(c)
    else if (c.key.includes(f)) has.push(c)
  }
  const seen = new Set<string>()
  return [...starts, ...has].filter((c) => !seen.has(c.label) && (seen.add(c.label), true)).slice(0, k)
}

export interface TaxoQuality {
  built: string
  rule: string
  zipf: number[]
  wiktionary: number[]
  wiki_hits: Record<string, number>
  suspect: number[]
}
let qualP: Promise<TaxoQuality | undefined> | undefined
/** Jakość słów (scripts/flag_taxo_words.py): częstość, Wikisłownik, trafienia w Wikipedii. Brak pliku = brak danych. */
export const taxoQuality = () =>
  (qualP ??= fetch(`${import.meta.env.BASE_URL}data/taxo/quality.json`)
    .then((r) => (r.ok ? (r.json() as Promise<TaxoQuality>) : undefined))
    .catch(() => undefined))
