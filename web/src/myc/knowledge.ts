// Pamięć wiedzy obok modelu: wszystko, co grzybnia ZATWIERDZIŁA, w jednym indeksie BM25 – czat używa tego od razu,
// bez czekania na trening. Każdy wpis ma pochodzenie: źródło, datę zatwierdzenia, liczbę głosów / poparć.
// Wpisy: zatwierdzone znaczenia z czatu (myc_meanings), zweryfikowane strzępki (myc_frags status=verified, także
// poprawki odpowiedzi z Weryfikuj: rel='odpowiedz'), fakty z konsensusu Weryfikuj (przekazywane z mózgu przeglądarki).
// Tylko odczyt (publiczne RLS). Pusty stan jest uczciwy: brak zatwierdzonych wpisów = brak wpisów.
import { Index, type Doc } from './retrieval'
import { SB_KEY, SB_URL } from './store'

export interface KItem {
  id: string
  kind: 'meaning' | 'frag' | 'correction' | 'fact' | 'seed'
  /** tekst do wyszukiwania i wyświetlenia */
  text: string
  /** źródło (np. „głosowanie w Weryfikuj”, „właścicielka”, „Wikidata Q1”) */
  source: string
  approvedAt?: string
  votes: number
  trust: number
  /** fałsz według grzybni (np. „Bateria litowa lubi mróz.” → nie) */
  false?: boolean
  /** link do źródła (fakty startowe z Wikidata / Wikisłownika) */
  url?: string
}

interface SeedFact {
  subj: string
  rel: string
  obj: string
  text: string
  source: 'wikidata' | 'wiktionary'
  url: string
  licence: string
  retrieved: string
  sha: string
}
/** Fakty startowe (scripts/build_seed_facts.py): Wikidata CC0 + Wikisłownik CC BY-SA, z linkiem i datą pobrania.
 *  NIE są zatwierdzone przez ludzi – zaufanie ze źródła (0,9 / 0,8), 0 głosów; w czacie opisane jako źródło startowe. */
export function fromSeedFact(f: SeedFact): KItem {
  return {
    id: `seed:${f.sha}`,
    kind: 'seed',
    text: f.text.replace(/\.$/, ''),
    source: `${f.source === 'wikidata' ? 'Wikidata (CC0)' : 'Wikisłownik (CC BY-SA 4.0)'}, pobrano ${f.retrieved}: ${f.url}`,
    approvedAt: undefined,
    votes: 0,
    trust: f.source === 'wikidata' ? 0.9 : 0.8,
    url: f.url,
  }
}
let seedFacts: Promise<KItem[]> | undefined
export const loadSeedFacts = () =>
  (seedFacts ??= fetch(`${import.meta.env.BASE_URL}data/seed/facts.json`)
    .then((r) => (r.ok ? (r.json() as Promise<{ facts: SeedFact[] }>) : { facts: [] }))
    .then((d) => d.facts.map(fromSeedFact))
    .catch(() => []))

const H = { apikey: SB_KEY }
const REL_SKIP = new Set(['intencja', 'pojecie', 'zawiera', 'obejmuje', 'temat', 'tlumaczenie', 'przedstawia'])

type Fetch = (url: string) => Promise<unknown[]>
const getRows: Fetch = async (url) => {
  const r = await fetch(url, { headers: H })
  if (!r.ok) throw new Error(`knowledge ${r.status}`)
  return (await r.json()) as unknown[]
}

interface MeaningRow {
  id: number
  word: string
  meaning: string
  register: string
  n_votes: number
  decided_by: string | null
  decided_at: string | null
}
interface FragRow {
  id: number
  subj: string
  rel: string
  obj: string
  source: string
  source_ref: string | null
  trust: number
  n_support: number
  updated_at: string
}

const srcName = (s: string) =>
  ({ owner: 'właścicielka (złota etykieta)', consensus: 'konsensus głosów w Weryfikuj', teach: 'nauczyciel + głosowanie', wikidata: 'Wikidata', wiktionary: 'Wikisłownik', plwordnet: 'plWordNet', wordnet: 'WordNet' })[s] ?? s

export function fromMeaning(m: MeaningRow): KItem {
  return {
    id: `meaning:${m.id}`,
    kind: 'meaning',
    text: `${m.word}${m.register !== 'neutralne' ? ` (${m.register})` : ''} – ${m.meaning}`,
    source: m.decided_by === 'owner' ? 'znaczenie z czatu, zatwierdziła właścicielka' : 'znaczenie z czatu, zatwierdzone w głosowaniu',
    approvedAt: m.decided_at ?? undefined,
    votes: m.n_votes,
    trust: m.decided_by === 'owner' ? 1 : 0.95,
  }
}

export function fromFrag(f: FragRow): KItem | undefined {
  if (REL_SKIP.has(f.rel)) return undefined
  const corr = f.rel === 'odpowiedz' && (f.source_ref ?? '').startsWith('answer:')
  const ref = corr ? (f.source_ref ?? '').split(' ').slice(1).join(' ') : ''
  const text =
    f.rel === 'prawdziwe'
      ? `${f.subj} – ${f.obj === 'tak' ? 'prawda' : f.obj === 'nie' ? 'NIEPRAWDA' : f.obj}`
      : f.rel === 'odpowiedz'
        ? `${f.subj} → ${f.obj}`
        : f.rel === 'znaczenie'
          ? `${f.subj} – ${f.obj}`
          : `${f.subj} – ${f.rel.replace(/_/g, ' ')} – ${f.obj}`
  return {
    id: `frag:${f.id}`,
    kind: corr ? 'correction' : 'frag',
    text,
    source: corr ? `poprawka odpowiedzi czatu (Weryfikuj, ${srcName(f.source)})${ref ? `; źródło: ${ref}` : ''}` : `strzępek #${f.id} (${srcName(f.source)})`,
    approvedAt: f.updated_at,
    votes: f.n_support,
    trust: f.trust,
    false: f.rel === 'prawdziwe' && f.obj === 'nie',
  }
}

let cache: { at: number; items: KItem[] } | undefined
/** Wczytuje zatwierdzoną wiedzę z bazy (pamięć podręczna 5 min). */
export async function loadKnowledge(get: Fetch = getRows, room = 'main'): Promise<KItem[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.items
  const [ms, fs, sf] = await Promise.all([
    get(`${SB_URL}/rest/v1/myc_meanings?select=id,word,meaning,register,n_votes,decided_by,decided_at&room=eq.${room}&status=eq.approved&order=decided_at.desc&limit=2000`).catch(() => []),
    get(`${SB_URL}/rest/v1/myc_frags?select=id,subj,rel,obj,source,source_ref,trust,n_support,updated_at&room=eq.${room}&status=eq.verified&layer=eq.0&order=updated_at.desc&limit=3000`).catch(() => []),
    get === getRows && room === 'main' ? loadSeedFacts() : Promise.resolve([] as KItem[]),
  ])
  // zatwierdzone przez ludzi najpierw; fakty startowe ze źródłami za nimi
  const items = [...(ms as MeaningRow[]).map(fromMeaning), ...(fs as FragRow[]).map(fromFrag).filter((x): x is KItem => !!x), ...sf]
  cache = { at: Date.now(), items }
  return items
}
export const knowledgeCount = () => cache?.items.length

/** Fakty z konsensusu Weryfikuj (mózg przeglądarki) → wpisy pamięci (tylko z głosami). */
export function fromFactDocs(docs: Doc[], conf: number): KItem[] {
  return docs
    .filter((d) => !d.dict && d.votes > 0 && d.p >= conf && (d.truth === 'tak' || d.truth === 'nie'))
    .map((d) => ({ id: `fact:${d.id}`, kind: 'fact' as const, text: `${d.text} – ${d.truth === 'tak' ? 'prawda' : 'NIEPRAWDA'}`, source: `konsensus Weryfikuj (${Math.round(d.p * 100)}%)`, votes: d.votes, trust: d.p, false: d.truth === 'nie' }))
}

export interface KHit extends KItem {
  score: number
  cover: number
}
/** Indeks pamięci; trafienie liczy się tylko przy pokryciu ≥ 0,75 słów pytania (inaczej to tylko podobny temat). */
export class Knowledge {
  private idx: Index
  private by: Map<string, KItem>
  items: KItem[]
  constructor(items: KItem[]) {
    this.items = items
    this.by = new Map(items.map((i) => [i.id, i]))
    this.idx = new Index(items.map((i) => ({ id: i.id, text: i.text, truth: 'tak', p: i.trust, votes: i.votes, source: i.source })))
  }
  search(q: string, k = 3, minCover = 0.75): KHit[] {
    return this.idx
      .search(q, k * 3)
      .filter((d) => d.cover >= minCover && d.score >= 1)
      .slice(0, k)
      .map((d) => ({ ...this.by.get(d.id)!, score: d.score, cover: d.cover }))
  }
}
