// Wiedza czystej grzybni: tylko to, co zatwierdzili LUDZIE (bez Wikidata / Wikisłownika / WordNetu / modeli).
// Źródła: strzępki myc_frags ze źródłem owner / consensus / teach (status verified), zatwierdzone znaczenia z czatu
// (myc_meanings), fakty i pary pytanie→odpowiedź z Ucz AI z prawdą wg konsensusu Weryfikuj (mózg przeglądarki).
// Oraz złożenie odpowiedzi: rozumujący (czysta.ts) → pary pytanie–odpowiedź → fakty → uczciwe „nie wiem, bo …”.
import type { Analysis } from './rozbior'
import { Reasoner, literal, litPl, rulesAndFact, sentences, stem, Tree, DROP_UPOS, DROP_LEM, type Lit, type Method, type Step } from './czysta'
import { tokens as rtokens } from './retrieval'
import { numeric, type NumMethod } from './czystaLiczby'
import type { MorfLex } from './morf'
import { SB_KEY, SB_URL } from './store'

/** źródła strzępków uznawane za decyzję ludzi (inne: wikidata, wiktionary, wordnet, plwordnet, captcha – pominięte) */
export const HUMAN_SOURCES = ['owner', 'consensus', 'teach'] as const
/** relacje strzępków, które czysta grzybnia umie czytać */
export const PURE_RELS = ['jest', 'prawdziwe', 'odpowiedz', 'znaczenie'] as const

export interface PFact {
  id: string
  /** zdanie oznajmujące (fakt albo reguła „Jeśli …, to …” / „Wszystkie … to …”) */
  text: string
  truth: 'tak' | 'nie'
  p: number
  votes: number
  source: string
  at?: string
  /** etykieta „X to y.” zbudowana z trójki (rel „jest”), a nie zdanie napisane przez człowieka */
  label?: boolean
}
export interface PQA {
  id: string
  q: string
  a: string
  p: number
  votes: number
  source: string
  at?: string
}
export interface PureKB {
  facts: PFact[]
  qa: PQA[]
  /** liczba zdań-reguł (warunek / kwantyfikator) – liczona przy wczytaniu tekstowo, dokładnie przy rozbiorze */
  loadedAt: string
  /** pominięte wpisy z powodu źródła (np. Wikidata) – pokazywane uczciwie */
  skipped: number
}

interface FragRow {
  id: number
  subj: string
  rel: string
  obj: string
  source: string
  trust: number
  n_support: number
  updated_at: string
}
interface MeaningRow {
  id: number
  word: string
  meaning: string
  n_votes: number
  decided_by: string | null
  decided_at: string | null
}
const SRC_PL: Record<string, string> = { owner: 'właścicielka', consensus: 'konsensus Weryfikuj', teach: 'nauczyciel + głosowanie' }

const isEnglish = (s: string) => /^[a-z0-9 ,.'’?!;:-]+$/i.test(s) && !/[ąćęłńóśźż]/i.test(s) && /\b(the|is|a|of|my|me|you|i|to|what|how)\b/i.test(s)

export function fromFrags(rows: FragRow[]): { facts: PFact[]; qa: PQA[] } {
  const facts: PFact[] = []
  const qa: PQA[] = []
  for (const f of rows) {
    const src = `strzępek #${f.id} (${SRC_PL[f.source] ?? f.source})`
    const base = { p: f.trust, votes: f.n_support, source: src, at: f.updated_at }
    if (f.rel === 'odpowiedz') qa.push({ id: `frag:${f.id}`, q: f.subj, a: f.obj, ...base })
    else if (f.rel === 'znaczenie') qa.push({ id: `frag:${f.id}`, q: `Co to jest ${f.subj}?`, a: f.obj, ...base })
    else if (f.rel === 'prawdziwe' && (f.obj === 'tak' || f.obj === 'nie') && !/\?\s*$/.test(f.subj)) facts.push({ id: `frag:${f.id}`, text: f.subj.trim().replace(/([^.!])$/, '$1.'), truth: f.obj, ...base })
    else if (f.rel === 'jest' && f.subj && f.obj) facts.push({ id: `frag:${f.id}`, text: `${f.subj} to ${f.obj.toLowerCase()}.`, truth: 'tak', label: true, ...base })
  }
  return { facts, qa }
}

/** Fakty / pary z Ucz AI z prawdą wg konsensusu (brain.factDocs + FACT_CONF): tylko z głosami, p ≥ progu. */
export function fromDocs(docs: { id: string; text: string; truth: string; p: number; votes: number; source: string; dict?: boolean }[], conf: number): { facts: PFact[]; qa: PQA[] } {
  const facts: PFact[] = []
  const qa: PQA[] = []
  for (const d of docs) {
    if (d.dict || d.votes <= 0 || d.p < conf || (d.truth !== 'tak' && d.truth !== 'nie')) continue
    const src = `${d.source}, konsensus Weryfikuj ${Math.round(d.p * 100)}% (${d.votes} gł.)`
    if (d.text.includes(' → ')) {
      if (d.truth !== 'tak') continue
      const [q, a] = d.text.split(' → ')
      qa.push({ id: `doc:${d.id}`, q, a, p: d.p, votes: d.votes, source: src })
    } else if (!/\?\s*$/.test(d.text)) facts.push({ id: `doc:${d.id}`, text: d.text.trim().replace(/([^.!])$/, '$1.'), truth: d.truth, p: d.p, votes: d.votes, source: src })
  }
  return { facts, qa }
}

export async function loadHumanRows(room = 'main'): Promise<{ frags: FragRow[]; meanings: MeaningRow[]; skipped: number }> {
  const H = { apikey: SB_KEY }
  const get = async <T,>(path: string): Promise<T[]> => {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H, signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`${path.split('?')[0]}: ${r.status}`)
    return (await r.json()) as T[]
  }
  const [frags, meanings, all] = await Promise.all([
    get<FragRow>(`myc_frags?select=id,subj,rel,obj,source,trust,n_support,updated_at&room=eq.${room}&status=eq.verified&layer=eq.0&source=in.(${HUMAN_SOURCES.join(',')})&rel=in.(${PURE_RELS.join(',')})&order=updated_at.desc&limit=3000`),
    get<MeaningRow>(`myc_meanings?select=id,word,meaning,n_votes,decided_by,decided_at&room=eq.${room}&status=eq.approved&limit=2000`),
    get<{ source: string }>(`myc_frags?select=source&room=eq.${room}&status=eq.verified&layer=eq.0&rel=in.(${PURE_RELS.join(',')})&limit=5000`),
  ])
  const skipped = all.filter((x) => !(HUMAN_SOURCES as readonly string[]).includes(x.source)).length
  return { frags: frags.filter((f) => !isEnglish(f.subj)), meanings, skipped }
}

export function buildKB(rows: { frags: FragRow[]; meanings: MeaningRow[]; skipped: number }, docs: ReturnType<typeof fromDocs>): PureKB {
  const a = fromFrags(rows.frags)
  const m: PQA[] = rows.meanings.map((x) => ({ id: `meaning:${x.id}`, q: `Co to jest ${x.word}?`, a: x.meaning, p: x.decided_by === 'owner' ? 1 : 0.95, votes: x.n_votes, source: x.decided_by === 'owner' ? 'znaczenie z czatu (właścicielka)' : 'znaczenie z czatu (głosowanie)', at: x.decided_at ?? undefined }))
  return { facts: [...a.facts, ...docs.facts], qa: [...a.qa, ...m, ...docs.qa], loadedAt: new Date().toISOString(), skipped: rows.skipped }
}

/** Widok wiedzy tylko ze zdań (bez etykiet „X to y.” z trójek „jest”). */
export const onlySentences = (kb: PureKB): PureKB => ({ ...kb, facts: kb.facts.filter((f) => !f.label) })

/** Czy zdanie jest regułą (warunek albo kwantyfikator ogólny) – tylko po słowach, do liczników. */
export const looksLikeRule = (s: string) => /^\s*(jeśli|jeżeli|gdy|kiedy|o ile)\b|\b(wszystkie|wszyscy|każdy|każda|każde|żaden|żadna|żadne|niektóre|niektórzy)\b/i.test(s)

// ------------------------------------------------------------------ złożenie odpowiedzi
export interface ParsedSentence {
  s: string
  a: Analysis
  conf: number
}
export type Source = 'logika' | 'liczby' | 'para' | 'fakt' | 'brak'
export interface PureAnswer {
  input: string
  /** krótka odpowiedź (tak / nie / nie wiadomo / imię / tekst z wiedzy) albo null = nie wiem */
  answer: string | null
  source: Source
  method?: Method | NumMethod | 'para pytanie–odpowiedź' | 'fakt z wiedzy'
  trace: Step[]
  used: (PFact | PQA)[]
  conf: number
  parses: ParsedSentence[]
  /** czego brakuje (gdy answer = null) */
  missing: string[]
  ms: number
}
export type ParseFn = (s: string) => { a: Analysis; conf: number } | undefined

const WH = new Set(['kto', 'kogo', 'komu', 'kim', 'co', 'czego', 'czemu', 'czym', 'gdzie', 'dokąd', 'skąd', 'kiedy', 'ile', 'ilu', 'dlaczego', 'jak', 'jaki', 'jaka', 'jakie', 'jakiego', 'jakim', 'który', 'która', 'które', 'którym', 'którego', 'czy', 'nazywać'])
/** Tematy słów treści zdania (te same reguły odrzucania co w literałach rozumującego) + pytajniki pominięte. */
export function contentStems(a: Analysis): string[] {
  const out: string[] = []
  for (const t of a.tokens) {
    const lem = (t.lemma || t.form).toLowerCase()
    if (t.part === 'przeczenie' || DROP_UPOS.has(t.upos) || DROP_LEM.has(lem) || WH.has(lem) || WH.has(t.form.toLowerCase()) || lem === 'się') continue
    out.push(stem(lem))
  }
  return [...new Set(out)]
}

/** Normalizacja wejścia: białe znaki, cudzysłowy proste → polskie, pytajnik po pytajniku na początku. */
export function normalise(text: string): string {
  let s = text.replace(/\s+/g, ' ').trim()
  s = s.replace(/"([^"]+)"/g, '„$1”')
  if (!/[.?!]$/.test(s) && /^(czy|kto|komu|co|gdzie|kiedy|ile|jak|jaki|jaka|jakie|który|która|które|dlaczego|w którym|na jakim|w jakim)\b/i.test(s)) s += '?'
  return s
}

export function answerPure(input: string, parseFn: ParseFn, kb: PureKB | undefined, lex?: MorfLex): PureAnswer {
  const t0 = performance.now()
  const text = normalise(input)
  const trace: Step[] = [{ kind: 'wejście', text: text === input.trim() ? `„${text}”` : `„${input.trim()}” → po normalizacji „${text}”` }]
  const parses: ParsedSentence[] = []
  const cacheP = new Map<string, Analysis>()
  const parse = (s: string): Analysis => {
    const hit = cacheP.get(s)
    if (hit) return hit
    const r = parseFn(s)
    if (!r) throw new Error('model rozbioru niegotowy')
    cacheP.set(s, r.a)
    return r.a
  }
  for (const s of sentences(text)) {
    const r = parseFn(s)
    if (r) parses.push({ s, a: r.a, conf: r.conf })
  }
  const pconf = parses.length ? parses.reduce((x, p) => x + p.conf, 0) / parses.length : 0
  const done = (answer: string | null, source: Source, extra: Partial<PureAnswer>): PureAnswer => ({ input: text, answer, source, trace, used: [], conf: 0, parses, missing: [], ms: performance.now() - t0, ...extra })
  if (!parses.length) return done(null, 'brak', { missing: ['model rozbioru nie jest wczytany albo zdanie jest puste'] })
  trace.push({ kind: 'rozbiór', text: `${parses.length} ${parses.length === 1 ? 'zdanie' : parses.length % 10 >= 2 && parses.length % 10 <= 4 && (parses.length % 100 < 12 || parses.length % 100 > 14) ? 'zdania' : 'zdań'}, pewność rozbioru ${Math.round(pconf * 100)}%` })

  // 1) rozumujący na samym tekście (przesłanki w pytaniu)
  const R = new Reasoner(parse)
  const a1 = R.answer(text)
  trace.push(...R.trace)
  if (a1 != null) return done(a1, 'logika', { method: R.method, conf: pconf })
  // 2) reguły liczbowe i analogie (czystaLiczby.ts): arytmetyka, zadania tekstowe, ciągi, liczebniki, analogie
  const nt: Step[] = []
  const nr = numeric(text, { parse, lex, trace: nt, facts: kb?.facts.filter((f) => f.truth === 'tak').map((f) => ({ id: f.id, text: f.text })) })
  if (nr) {
    // braki rozumującego logicznego nie dotyczą pytania liczbowego – zostaje ślad reguły, która odpowiedziała
    for (let i = trace.length - 1; i >= 0; i--) if (trace[i].kind === 'brak') trace.splice(i, 1)
    trace.push(...nt)
    const used = kb ? kb.facts.filter((f) => nr.used?.includes(f.id)) : []
    return done(nr.answer, nr.method.startsWith('analogia (relacja') ? 'fakt' : 'liczby', { method: nr.method, used, conf: pconf })
  }
  const numMissing = nt.filter((s) => s.kind === 'brak').map((s) => s.text)
  if (numMissing.length) trace.push(...nt)
  const missing = [...R.trace.filter((s) => s.kind === 'brak').map((s) => s.text), ...numMissing]

  const sents = sentences(text)
  const q = sents.filter((s) => s.endsWith('?')).pop()
  if (!kb || !q) return done(null, 'brak', { missing: [...missing, ...(!kb ? ['wiedza zatwierdzona przez ludzi nie wczytała się'] : ['to nie jest pytanie – dodaj „?”'])] })
  const qa = parse(q)
  const qStems = contentStems(qa)
  if (!qStems.length) return done(null, 'brak', { missing: [...missing, 'w pytaniu nie ma słów treści'] })
  trace.push({ kind: 'wiedza', text: `słowa treści pytania: {${qStems.join(', ')}}; szukam w ${kb.qa.length} parach i ${kb.facts.length} faktach zatwierdzonych przez ludzi` })
  const qset = new Set(qStems)
  const sameSet = (xs: string[]) => xs.length === qset.size && xs.every((x) => qset.has(x))
  const prefilter = <T extends { text?: string; q?: string }>(xs: T[], f: (x: T) => string) => {
    const rt = new Set(rtokens(q))
    return xs.filter((x) => rtokens(f(x)).some((w) => rt.has(w)))
  }

  // 2) para pytanie → odpowiedź (te same słowa treści)
  for (const p of prefilter(kb.qa, (x) => x.q)) {
    let st: string[]
    try {
      st = contentStems(parse(normalise(p.q)))
    } catch {
      continue
    }
    if (sameSet(st)) {
      trace.push({ kind: 'wiedza', text: `para „${p.q}” → „${p.a}” ma te same słowa treści` })
      return done(p.a, 'para', { method: 'para pytanie–odpowiedź', used: [p], conf: pconf * p.p })
    }
  }

  // 3) fakty
  const isYN = /^czy\b/i.test(q)
  const cands = prefilter(kb.facts, (x) => x.text)
  if (isYN) {
    const Tq = new Tree(qa.tokens)
    const ql = literal(Tq, Tq.root())
    if (ql) {
      for (const f of cands) {
        let lits: Lit[]
        try {
          const T = new Tree(parse(f.text).tokens)
          lits = rulesAndFact(T, f.text, parse)[1]
        } catch {
          continue
        }
        for (const l0 of lits) {
          const l = f.truth === 'nie' ? { ...l0, pol: !l0.pol } : l0
          if (l.key === ql.key) {
            const ans = l.pol === ql.pol ? 'tak' : 'nie'
            trace.push({ kind: 'fakt', text: `„${f.text}” (${f.truth === 'tak' ? 'prawda' : 'NIEPRAWDA'} wg ludzi) → ${litPl(l)}` })
            trace.push({ kind: 'wniosek', text: `pytanie ${litPl(ql)}: ${ans === 'tak' ? 'ta sama biegunowość → tak' : 'przeciwna biegunowość → nie'}` })
            return done(ans, 'fakt', { method: 'fakt z wiedzy', used: [f], conf: pconf * f.p })
          }
        }
      }
      // reguły i fakty z wiedzy jako przesłanki (tylko zdania prawdziwe wg ludzi)
      const prem = cands.filter((f) => f.truth === 'tak').slice(0, 12)
      if (prem.length) {
        const R2 = new Reasoner(parse)
        const a2 = R2.answer(`${prem.map((f) => f.text).join(' ')} ${q}`)
        if (a2 != null && R2.method && R2.method !== 'fakt') {
          trace.push({ kind: 'wiedza', text: `przesłanki z wiedzy: ${prem.map((f) => `„${f.text}”`).join(', ')}` }, ...R2.trace)
          return done(a2, 'fakt', { method: R2.method, used: prem, conf: pconf * Math.min(...prem.map((f) => f.p)) })
        }
      }
    }
  } else {
    // pytanie otwarte: fakt, który zawiera WSZYSTKIE słowa treści pytania; odpowiedź = pozostałe słowa faktu
    let best: { f: PFact; rest: string; extra: number } | undefined
    const qLemmas = new Set(qa.tokens.map((t) => (t.lemma || t.form).toLowerCase()))
    // bezpiecznik: pytanie o liczbę („Jaka to liczba?”, „Ile …?”, „O ile …?”) – fakt bez liczby nie jest odpowiedzią
    const askNum = /^(ile|ilu)(?![\p{L}])|jak\p{L}* (?:to )?liczb|(?<![\p{L}])o ile(?![\p{L}])|ile razy/iu.test(q)
    const NUMW = /\d|(?<![\p{L}])(zero|jed(en|na|no)|dwa|dwie|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|sto|tysiąc)(?![\p{L}])/iu
    for (const f of cands) {
      if (f.truth !== 'tak') continue
      let fa: Analysis
      try {
        fa = parse(f.text)
      } catch {
        continue
      }
      const fs = new Set(contentStems(fa))
      if (!qStems.every((x) => fs.has(x))) continue
      const rest = fa.tokens.filter((t) => {
        const lem = (t.lemma || t.form).toLowerCase()
        // pomijamy słowa z pytania (ten sam lemat); temat 5-literowy łączy np. „grzybnia” i „grzyba”, więc tu lemat
        return !(t.upos === 'PUNCT' || DROP_UPOS.has(t.upos) || DROP_LEM.has(lem)) && !qLemmas.has(lem)
      })
      if (!rest.length) continue
      if (askNum && !rest.some((t) => NUMW.test(t.form) || t.upos === 'NUM')) continue
      const extra = rest.length
      if (!best || extra < best.extra) best = { f, rest: rest.map((t) => t.form).join(' '), extra }
    }
    if (best) {
      trace.push({ kind: 'fakt', text: `„${best.f.text}” zawiera wszystkie słowa pytania {${qStems.join(', ')}}` })
      trace.push({ kind: 'wniosek', text: `brakujący element = pozostałe słowa faktu: „${best.rest}”` })
      return done(best.rest, 'fakt', { method: 'fakt z wiedzy', used: [best.f], conf: pconf * best.f.p * 0.8 })
    }
  }
  missing.push(
    isYN
      ? `brak zatwierdzonego faktu ani reguły ze słowami {${qStems.join(', ')}} – dodaj fakt (np. zdanie oznajmujące) albo regułę „Jeśli …, to …”`
      : `brak zatwierdzonego faktu, który zawiera wszystkie słowa {${qStems.join(', ')}} i odpowiedź – dodaj fakt zdaniem oznajmującym`,
  )
  trace.push({ kind: 'brak', text: missing[missing.length - 1] })
  return done(null, 'brak', { missing })
}
