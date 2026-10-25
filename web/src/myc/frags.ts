// „Strzępki” – wielowarstwowa wiedza grzybni (po nitce do kłębka).
// Warstwa 0: atomowe fakty (podmiot – relacja – obiekt) ze źródłem; 1: pojęcia; 2: tematy.
// Zapis tylko przez RPC myc_frag_add (zaufanie liczy baza ze źródła), odczyt publiczny (RLS).
import { ids, SB_KEY, SB_URL } from './store'
import type { Grounded } from './ground'

export interface Frag {
  id: number
  layer: number
  subj: string
  rel: string
  obj: string
  lang?: string
  source: string
  source_ref?: string | null
  trust: number
  status: 'active' | 'conflict' | 'verified' | 'rejected'
  n_support?: number
  created_at?: string
}
export interface FragLink {
  src: number
  dst: number
  kind: string
  weight: number
}
export interface NewFrag {
  layer: number
  subj: string
  rel: string
  obj: string
  lang?: 'pl' | 'en' | 'xx'
  source: 'wikidata' | 'plwordnet' | 'wordnet' | 'wiktionary' | 'consensus' | 'teach' | 'captcha' | 'chat' | 'link'
  ref?: string
  hint?: number
}
type Ref = Pick<NewFrag, 'layer' | 'subj' | 'rel' | 'obj'>
export interface NewLink {
  src: Ref
  dst: Ref
  kind: string
  w?: number
}

const REST = `${SB_URL}/rest/v1`
const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
export const ROOM = 'main'

/** Klucz identyczny z myc_frag_key w SQL i fragments.py. */
export const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
export const fragKey = (f: Ref) => `${f.layer}:${norm(f.subj)}|${f.rel}|${norm(f.obj)}`

export const REL_LABEL: Record<string, [string, string]> = {
  jest: ['jest', 'is a'],
  tlumaczenie: ['po angielsku', 'in English'],
  intencja: ['intencja', 'intent'],
  prawdziwe: ['prawdziwe?', 'true?'],
  odpowiedz: ['odpowiedź', 'answer'],
  przedstawia: ['przedstawia', 'shows'],
  definicja: ['definicja', 'definition'],
  znaczenie: ['znaczy', 'means'],
  rejestr: ['rejestr', 'register'],
  populacja: ['liczba ludności', 'population'],
  powierzchnia: ['powierzchnia', 'area'],
  stolica: ['stolica', 'capital'],
  wysokosc: ['wysokość n.p.m.', 'elevation'],
  rok: ['rok', 'year'],
  data_urodzenia: ['data urodzenia', 'born'],
  data_smierci: ['data śmierci', 'died'],
  pojecie: ['pojęcie', 'concept'],
  zawiera: ['zawiera', 'contains'],
  obejmuje: ['obejmuje', 'covers'],
  temat: ['temat', 'topic'],
}
export const relName = (r: string, en: boolean) => REL_LABEL[r]?.[en ? 1 : 0] ?? r
export const fragText = (f: Pick<Frag, 'subj' | 'rel' | 'obj' | 'layer'>, en: boolean) =>
  f.layer > 0 ? `${f.subj} (${relName(f.rel, en)})` : `${f.subj} – ${relName(f.rel, en)} – ${f.obj}`

async function rpc<T>(fn: string, body: unknown, timeout = 8000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(`${REST}/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: ctrl.signal })
    const txt = await r.text()
    if (!r.ok) throw Object.assign(new Error((txt && (JSON.parse(txt) as { message?: string }).message) || String(r.status)), { status: r.status })
    return (txt ? JSON.parse(txt) : null) as T
  } finally {
    clearTimeout(t)
  }
}
async function get<T>(path: string, timeout = 8000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(REST + path, { headers: H, signal: ctrl.signal })
    if (!r.ok) throw new Error(String(r.status))
    return (await r.json()) as T
  } finally {
    clearTimeout(t)
  }
}
export { rpc as fragRpc }

export function addFrags(frags: NewFrag[], links: NewLink[] = [], room = ROOM) {
  return rpc<{ frags: number; links: number; conflicts: number }>('myc_frag_add', { p_node: ids.node, p_frags: frags, p_links: links, p_room: room })
}

const FIELDS = 'id,layer,subj,rel,obj,lang,source,source_ref,trust,status,n_support,created_at'
const enc = (s: string) => encodeURIComponent(s.replace(/[,()*"\\]/g, ' '))

/** Strzępki o podanych podmiotach (bez odrzuconych). */
export async function fragsAbout(subjects: string[], room = ROOM, limit = 40): Promise<Frag[]> {
  const ss = [...new Set(subjects.map(norm).filter((s) => s.length >= 2))].slice(0, 8)
  if (!ss.length) return []
  const or = ss.map((s) => `subj.ilike.${enc(s)}`).join(',')
  return get<Frag[]>(`/myc_frags?select=${FIELDS}&room=eq.${room}&status=neq.rejected&or=(${or})&order=layer,trust.desc&limit=${limit}`)
}
export const fragsById = (idsList: number[], room = ROOM) =>
  idsList.length ? get<Frag[]>(`/myc_frags?select=${FIELDS}&room=eq.${room}&id=in.(${[...new Set(idsList)].slice(0, 150).join(',')})`) : Promise.resolve([])
export const linksFrom = (src: number[]) =>
  src.length ? get<FragLink[]>(`/myc_frag_links?select=src,dst,kind,weight&src=in.(${[...new Set(src)].slice(0, 150).join(',')})&limit=600`) : Promise.resolve([])
export const linksTo = (dst: number[]) =>
  dst.length ? get<FragLink[]>(`/myc_frag_links?select=src,dst,kind,weight&dst=in.(${[...new Set(dst)].slice(0, 150).join(',')})&limit=600`) : Promise.resolve([])

export interface Thread {
  start: Frag
  path: { frag: Frag; via: string }[]
}
const UP = new Set(['part_of', 'is_a', 'supports'])
/** Po nitce do kłębka: od strzępków o encji w górę warstw (strzępek → pojęcie → temat), maks. 3 skoki. */
export async function threads(subjects: string[], room = ROOM): Promise<{ threads: Thread[]; frags: Map<number, Frag> }> {
  const base = (await fragsAbout(subjects, room)).filter((f) => f.layer === 0 && f.trust >= 0.3)
  const all = new Map<number, Frag>(base.map((f) => [f.id, f]))
  const up = new Map<number, FragLink[]>()
  let frontier = base.map((f) => f.id)
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const ls = (await linksFrom(frontier)).filter((l) => UP.has(l.kind))
    for (const l of ls) up.set(l.src, [...(up.get(l.src) ?? []), l])
    const need = ls.map((l) => l.dst).filter((d) => !all.has(d))
    for (const f of await fragsById(need, room)) all.set(f.id, f)
    frontier = [...new Set(need)]
  }
  const out: Thread[] = []
  for (const f of base.sort((a, b) => (b.status === 'verified' ? 1 : 0) - (a.status === 'verified' ? 1 : 0) || b.trust - a.trust).slice(0, 6)) {
    const path: Thread['path'] = []
    let cur = f.id
    const seen = new Set([cur])
    for (let i = 0; i < 4; i++) {
      const nxt = (up.get(cur) ?? [])
        .map((l) => ({ l, d: all.get(l.dst) }))
        .filter((x) => x.d && !seen.has(x.d.id) && x.d.status !== 'rejected')
        .sort((a, b) => (a.l.kind === 'is_a' ? -1 : 0) - (b.l.kind === 'is_a' ? -1 : 0) || b.d!.layer - a.d!.layer)[0]
      if (!nxt) break
      path.push({ frag: nxt.d!, via: nxt.l.kind })
      seen.add(nxt.d!.id)
      cur = nxt.d!.id
    }
    out.push({ start: f, path })
  }
  return { threads: out, frags: all }
}

/** Kandydaci na encję w pytaniu: słowa i 2–3-wyrazowe zbitki (bez słów pytających). */
const STOP = new Set(
  'co to jest czym kto kim jaki jaka jakie ile czy jak gdzie kiedy oznacza znaczy powiedz mi o the what who is are a an of in on and lub albo oraz się sie po angielsku po polsku tłumaczenie translate'.split(' '),
)
export function subjectsIn(q: string): string[] {
  const ws = (q.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).filter((w) => !STOP.has(w.toLowerCase()))
  const out: string[] = []
  for (let n = 3; n >= 1; n--) for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(' '))
  return out.filter((s) => s.length >= 3).slice(0, 8)
}

// ---------- ekstrakcja w przeglądarce (zadania węzła) ----------

const PROP_REL: Record<string, string> = { P1082: 'populacja', P2046: 'powierzchnia', P36: 'stolica', P2044: 'wysokosc', P571: 'rok', P569: 'data_urodzenia', P570: 'data_smierci' }

/** Odpowiedź ugruntowana w Wikidata → strzępek + pojęcie + temat. */
export function fromGrounded(g: Grounded): { frags: NewFrag[]; links: NewLink[] } {
  const rel = PROP_REL[g.prop]
  if (!rel) return { frags: [], links: [] }
  const f: NewFrag = { layer: 0, subj: g.label, rel, obj: g.value, lang: 'pl', source: 'wikidata', ref: `${g.qid}${g.asOf ? `@${g.asOf}` : ''}` }
  const c: NewFrag = { layer: 1, subj: g.label, rel: 'pojecie', obj: '', lang: 'pl', source: 'link', hint: 0.9 }
  const t: NewFrag = { layer: 2, subj: 'Geografia i fakty', rel: 'temat', obj: '', lang: 'pl', source: 'link', hint: 0.9 }
  return { frags: [f, c, t], links: [{ src: f, dst: c, kind: 'part_of', w: 0.9 }, { src: c, dst: t, kind: 'part_of' }] }
}

/** Definicja z Wikisłownika → strzępek „słowo – definicja – …” przypięty do pojęcia słowa. */
export function fromDefinition(word: string, gloss: string, lang: 'pl' | 'en' = 'pl'): { frags: NewFrag[]; links: NewLink[] } {
  const g = gloss.trim().slice(0, 300)
  if (!g || !word.trim()) return { frags: [], links: [] }
  const f: NewFrag = { layer: 0, subj: word.trim(), rel: 'definicja', obj: g, lang, source: 'wiktionary', ref: 'wiktionary' }
  const c: NewFrag = { layer: 1, subj: word.trim(), rel: 'pojecie', obj: '', lang, source: 'link', hint: 0.8 }
  return { frags: [f, c], links: [{ src: f, dst: c, kind: 'part_of', w: 0.8 }] }
}

/** Zapis w tle (nie blokuje czatu); błędy (limiter/sieć) pomijamy – strzępek wróci przy kolejnym pytaniu. */
export function learn(x: { frags: NewFrag[]; links: NewLink[] }) {
  if (x.frags.length) void addFrags(x.frags, x.links).catch(() => undefined)
}

// ---------- statystyki ----------

export interface FragStat {
  layer: number
  n: number
  conflict: number
  verified: number
  rejected: number
  links: number
}
export interface FragDay {
  day: string
  layer: number
  n: number
  links: number
}
export const fragStats = (room = ROOM) => rpc<FragStat[]>('myc_frag_stats', { p_room: room })
export const fragDaily = (room = ROOM) => rpc<FragDay[]>('myc_frag_daily', { p_room: room })
export const conflictFrags = (room = ROOM, limit = 40) =>
  get<Frag[]>(`/myc_frags?select=${FIELDS}&room=eq.${room}&status=eq.conflict&order=subj,id&limit=${limit}`)
export const recentFrags = (room = ROOM, limit = 30) =>
  get<Frag[]>(`/myc_frags?select=${FIELDS}&room=eq.${room}&layer=eq.0&status=neq.rejected&source=in.(consensus,teach,captcha,chat,wikidata,wiktionary)&trust=lt.0.95&order=id.desc&limit=${limit}`)
/** Próbka grafu do wizualizacji: tematy, najliczniejsze pojęcia i ich strzępki. */
export async function graphSample(room = ROOM, nConcepts = 40, perConcept = 3) {
  const topics = await get<Frag[]>(`/myc_frags?select=${FIELDS}&room=eq.${room}&layer=eq.2&order=id&limit=30`)
  const tl = await linksTo(topics.map((t) => t.id))
  // pojęcia najbliżej tematów (po kolejności łączy – deterministycznie)
  const conceptIds = [...new Set(tl.map((l) => l.src))]
  const per = new Map<number, number>()
  const chosen: number[] = []
  const byTopic = new Map<number, number[]>()
  for (const l of tl) byTopic.set(l.dst, [...(byTopic.get(l.dst) ?? []), l.src])
  // po równo z każdego tematu
  for (let r = 0; chosen.length < nConcepts && r < 50; r++)
    for (const [, cs] of byTopic) if (cs[r] !== undefined && !chosen.includes(cs[r]) && chosen.length < nConcepts) chosen.push(cs[r])
  void conceptIds
  const concepts = (await fragsById(chosen, room)).filter((f) => f.layer === 1)
  const cl = await linksTo(concepts.map((c) => c.id))
  const leafIds: number[] = []
  for (const l of cl) {
    const k = per.get(l.dst) ?? 0
    if (k < perConcept && l.kind !== 'is_a' && l.kind !== 'translation' && l.kind !== 'synonym') {
      leafIds.push(l.src)
      per.set(l.dst, k + 1)
    }
  }
  const leaves = (await fragsById(leafIds, room)).filter((f) => f.layer === 0)
  const links = [...tl.filter((l) => chosen.includes(l.src)), ...cl.filter((l) => leafIds.includes(l.src) || concepts.some((c) => c.id === l.src))]
  return { nodes: [...topics, ...concepts, ...leaves], links }
}
