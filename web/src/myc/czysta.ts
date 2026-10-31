// Czysta grzybnia: odpowiada WYŁĄCZNIE to, czego grzybnia nauczyła się sama albo co zatwierdzili ludzie.
// Bez modelu językowego (żadnego Qwena / LM v4), bez Wikipedii i Wikidata, bez zewnętrznych modeli i osadzeń.
// Składniki: (1) model rozbioru wytrenowany przez sieć (opublikowany, niezależnie zweryfikowany), (2) słownik odmiany
// Morfeusz 2 / SGJP i schematy Walenty – TYLKO jako słownik (lemat, przypadek), (3) rozumujący z ról zdania – port 1:1
// src/iot_mycelium/rozbior/logika.py (te same stałe i kolejność reguł), (4) fakty, reguły i pary pytanie–odpowiedź
// zatwierdzone przez ludzi (Weryfikuj, Ucz AI, poprawki odpowiedzi). Gdy brakuje danych: uczciwe „nie wiem, bo …”.
import type { ATok, Analysis } from './rozbior'

// ------------------------------------------------------------------ stałe (identyczne z logika.py)
export const DROP_UPOS = new Set(['PUNCT', 'SCONJ', 'CCONJ', 'ADP', 'AUX', 'PART'])
export const DROP_LEM = new Set(['nie', 'czy', 'to', 'wiadomo', 'że', 'pewno', 'na', 'być', 'ten', 'tym', 'razem', 'zawsze', 'potem', 'jeśli', 'gdy', 'ponieważ'])
/** kwantyfikatory: początek słowa → all / some / none / notall (kolejność ma znaczenie, jak w Pythonie) */
export const Q_WORDS: [string, Quant][] = [['nie wszys', 'notall'], ['wszys', 'all'], ['każd', 'all'], ['niektór', 'some'], ['któr', 'some'], ['jakie', 'some'], ['jakiś', 'some'], ['żadn', 'none'], ['żaden', 'none']]
/** jedyna para przeciwieństw (z szablonów ćwiczeń) */
export const ANT: Record<string, string> = { mały: 'duży', duży: 'mały' }
/** zdania-opakowania: „wiadomo, że”, „nieprawda, że”, „okazało się, że” */
export const WRAP = new Set(['wiadomo', 'nieprawda', 'okazać'])
const INSTR = /^(odpowiedz|podaj|wybierz)\b/i
export type Quant = 'all' | 'some' | 'none' | 'notall'
export const Q_PL: Record<Quant, string> = { all: 'wszystkie / każdy', some: 'niektóre / któreś', none: 'żaden', notall: 'nie wszystkie' }
/** kwadrat logiczny: (przesłanka, pytanie) → odpowiedź */
export const SQUARE: Record<string, string> = {
  'all|all': 'tak', 'all|some': 'tak', 'all|none': 'nie', 'all|notall': 'nie',
  'none|all': 'nie', 'none|some': 'nie', 'none|none': 'tak', 'none|notall': 'tak',
  'some|all': 'nie wiadomo', 'some|some': 'tak', 'some|none': 'nie', 'some|notall': 'nie wiadomo',
  'notall|all': 'nie', 'notall|some': 'nie wiadomo', 'notall|none': 'nie wiadomo', 'notall|notall': 'tak',
}
export const INCOMPATIBLE = new Set(['all|none', 'none|all', 'all|notall', 'notall|all', 'some|none', 'none|some'])

const base = (r: string) => (r || '').split(':')[0]
const low = (s?: string | null) => (s || '').toLowerCase()
const isUpper1 = (s: string) => !!s && s[0] !== s[0].toLowerCase() && s[0] === s[0].toUpperCase()

/** Temat do porównań: lemat bez końcowej samogłoski, 5 znaków (jak logika.stem). */
export function stem(lemma: string): string {
  let w = low(lemma)
  while (w.length > 2 && 'aeiouyąę'.includes(w[w.length - 1])) w = w.slice(0, -1)
  return w.slice(0, 5)
}

// ------------------------------------------------------------------ ślad rozumowania
export type StepKind = 'wejście' | 'rozbiór' | 'reguła' | 'fakt' | 'wniosek' | 'kwantyfikator' | 'sprzeczność' | 'rola' | 'brak' | 'wiedza'
export interface Step {
  kind: StepKind
  text: string
}

// ------------------------------------------------------------------ drzewo
export class Tree {
  toks: ATok[]
  kids = new Map<number, number[]>()
  constructor(toks: ATok[]) {
    this.toks = toks
    for (const t of toks) {
      if (!this.kids.has(t.head)) this.kids.set(t.head, [])
      this.kids.get(t.head)!.push(t.i)
    }
  }
  t(i: number): ATok {
    // jak Python toks[i-1] (i = 0 → ostatni token; w logika.py nie występuje poza „prev” przy i > 1)
    return this.toks[i - 1] ?? this.toks[this.toks.length - 1]
  }
  root(): number {
    const r = this.toks.find((t) => t.head === 0)
    if (!r) throw new Error('brak korzenia')
    return r.i
  }
  ch(i: number): number[] {
    return this.kids.get(i) ?? []
  }
  sub(i: number, stop: Set<number> = new Set()): number[] {
    const out: number[] = []
    const st = [i]
    while (st.length) {
      const x = st.pop()!
      out.push(x)
      for (const c of this.ch(x)) if (!stop.has(c)) st.push(c)
    }
    return out.sort((a, b) => a - b)
  }
}

/** Literał: zbiór tematów słów treści + biegunowość (pol = true: twierdzenie, false: przeczenie). */
export interface Lit {
  key: string
  words: string[]
  pol: boolean
}
const mkLit = (words: Iterable<string>, pol: boolean): Lit => {
  const w = [...new Set(words)].sort()
  return { key: w.join('|'), words: w, pol }
}
export const neg = (l: Lit): Lit => ({ ...l, pol: !l.pol })
const same = (a: Lit, b: Lit) => a.key === b.key && a.pol === b.pol
export const litPl = (l: Lit) => `${l.pol ? '' : '¬'}{${l.words.join(', ')}}`

function _lit(T: Tree, head: number, stop: Set<number>, ids?: number[]): Lit | null {
  const xs = ids ?? T.sub(head, stop)
  let n = false
  const key = new Set<string>()
  for (const i of xs) {
    const t = T.t(i)
    const lem = low(t.lemma || t.form)
    if (t.part === 'przeczenie' || lem === 'nie') {
      n = !n
      continue
    }
    if (t.form.length === 1 && isUpper1(t.form)) {
      key.add(t.form)
      continue
    }
    if (DROP_UPOS.has(t.upos) || DROP_LEM.has(lem) || WRAP.has(lem) || lem === 'się') continue
    key.add(stem(lem))
  }
  return key.size ? mkLit(key, !n) : null
}

/** Zdanie składowe od `head`; „nieprawda, że X” = ¬X, „wiadomo, że X” = X. */
export function literal(T: Tree, head: number, stop?: Set<number>): Lit | null {
  const lem = low(T.t(head).lemma)
  if (WRAP.has(lem)) {
    const sub = T.sub(head, new Set(stop ?? []))
    const marks = sub.filter((i) => T.t(i).deprel === 'mark' && T.t(i).upos === 'SCONJ')
    if (!marks.length) return null
    const m = Math.max(...marks)
    const span = sub.filter((i) => i > m)
    const x = _lit(T, head, new Set(), span)
    const nneg = sub.filter((i) => low(T.t(i).lemma) === 'nieprawda' && i < m).length
    return x ? (nneg % 2 ? neg(x) : x) : null
  }
  return _lit(T, head, new Set(stop ?? []))
}

export type Parse = (s: string) => Analysis
export type Rule = [Lit, Lit]

export function splitCond(s: string, T: Tree): [string, string] | null {
  const toks = T.toks
  const k = toks.length && toks[0].upos === 'ADV' ? 1 : 0
  if (toks.length <= k || toks[k].upos !== 'SCONJ' || !s.includes(',')) return null
  const at = s.indexOf(',')
  let a = s.slice(0, at)
  let b = s.slice(at + 1)
  a = a.split(/\s+/).filter(Boolean).slice(k + 1).join(' ')
  b = b.trim().replace(/^\s*to\s+/, '')
  return a && b ? [a + '.', b] : null
}

/** Zdanie oznajmujące → reguły (zdanie okolicznikowe → nadrzędne) albo fakt. */
export function rulesAndFact(T: Tree, s = '', parse?: Parse): [Rule[], Lit[]] {
  const sc = parse ? splitCond(s, T) : null
  if (sc && parse) {
    const Ta = new Tree(parse(sc[0]).tokens)
    const Tb = new Tree(parse(sc[1]).tokens)
    const a = literal(Ta, Ta.root())
    const b = literal(Tb, Tb.root())
    return [a && b ? [[a, b]] : [], []]
  }
  const r = T.root()
  const adv = T.ch(r).filter((c) => (base(T.t(c).deprel) === 'advcl' && T.t(c).part === 'orzeczenie') || (base(T.t(c).deprel) === 'advcl' && ['VERB', 'ADJ', 'NOUN'].includes(T.t(c).upos)))
  if (adv.length) {
    const a = literal(T, adv[0])
    const b = literal(T, r, new Set(adv))
    return [a && b ? [[a, b]] : [], []]
  }
  const x = literal(T, r)
  return [[], x ? [x] : []]
}

/** Domknięcie: modus ponens (A, A→B ⊢ B) i modus tollens (¬B, A→B ⊢ ¬A), do 10 przebiegów. */
export function closure(facts: Lit[], rules: Rule[], trace?: Step[]): Lit[] {
  const f = new Map<string, Lit>()
  const k = (l: Lit) => `${l.pol ? '+' : '-'}${l.key}`
  for (const x of facts) f.set(k(x), x)
  for (let it = 0; it < 10; it++) {
    const n = f.size
    for (const [a, b] of rules) {
      if (f.has(k(a)) && !f.has(k(b))) {
        f.set(k(b), b)
        trace?.push({ kind: 'wniosek', text: `modus ponens: ${litPl(a)} i (${litPl(a)} → ${litPl(b)}) ⊢ ${litPl(b)}` })
      }
      const nb = neg(b)
      if (f.has(k(nb)) && !f.has(k(neg(a)))) {
        f.set(k(neg(a)), neg(a))
        trace?.push({ kind: 'wniosek', text: `modus tollens: ${litPl(nb)} i (${litPl(a)} → ${litPl(b)}) ⊢ ${litPl(neg(a))}` })
      }
    }
    if (f.size === n) break
  }
  return [...f.values()]
}

// ------------------------------------------------------------------ kwantyfikatory
export interface QInfo {
  q: Quant
  cls: string
  key: Set<string>
  nominal: boolean
}
const setKey = (s: Set<string>) => [...s].sort().join('|')

export function quant(T: Tree): QInfo | null {
  for (const t of T.toks) {
    const f = low(t.form)
    const prev = t.i > 1 ? low(T.t(t.i - 1).form) : ''
    let q = Q_WORDS.find(([k]) => (prev + ' ' + f).startsWith(k) || f.startsWith(k))?.[1]
    if (!q) continue
    if (prev === 'nie' && q === 'all') q = 'notall'
    let clsI: number | null = t.head && ['NOUN', 'PROPN'].includes(T.t(t.head).upos) ? t.head : t.upos === 'NOUN' ? t.i : null
    if (clsI == null) clsI = T.toks.slice(t.i).find((x) => x.upos === 'NOUN')?.i ?? null
    if (clsI == null) return null
    const cls = stem(T.t(clsI).lemma || '')
    const r = T.root()
    const pred = T.t(r)
    const qneg = new Set(prev === 'nie' ? [t.i - 1] : [])
    const near = [...T.ch(r), ...T.ch(r).flatMap((w) => T.ch(w))]
    let n = near.some((c) => T.t(c).part === 'przeczenie' && !qneg.has(c))
    if (T.t(r).i === clsI) return null
    const nominal = ['NOUN', 'PROPN'].includes(pred.upos) && stem(pred.lemma || '') !== cls
    const skip = new Set([clsI, t.i, ...(prev === 'nie' ? [t.i - 1] : [])])
    const key = new Set(
      T.toks
        .filter((x) => !skip.has(x.i) && !DROP_UPOS.has(x.upos) && !DROP_LEM.has(low(x.lemma)) && !/^(osobni|każd|czy)/.test(low(x.form)))
        .map((x) => stem(x.lemma || '')),
    )
    if (q === 'none') n = false // „żadne X nie są P” – podwójne przeczenie w polszczyźnie
    if (n) q = ({ all: 'none', some: 'notall', notall: 'some', none: 'all' } as const)[q]
    return { q, cls, key, nominal }
  }
  return null
}
const antKey = (key: Set<string>) => {
  const m: Record<string, string> = Object.fromEntries(Object.entries(ANT).map(([a, b]) => [stem(a), stem(b)]))
  return new Set([...key].map((k) => m[k] ?? k))
}
const qPl = (x: QInfo) => `${Q_PL[x.q]} ${x.cls}… → {${[...x.key].sort().join(', ')}}`

export function sentences(text: string): string[] {
  const out: string[] = []
  let buf = ''
  let q = false
  for (const ch of text) {
    buf += ch
    if (ch === '„') q = true
    else if (ch === '”') q = false
    else if ('.?!'.includes(ch) && !q) {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter((s) => !INSTR.test(s))
}

// ------------------------------------------------------------------ rozumujący (port logika.Reasoner)
export type Method = 'warunki' | 'fakt' | 'kwantyfikatory' | 'sylogizm' | 'aspekt' | 'sprzeczność' | 'rola' | 'kolejność w czasie' | 'porządek'
export class Reasoner {
  parse: Parse
  trace: Step[] = []
  method?: Method
  constructor(parse: Parse) {
    this.parse = parse
  }
  tree(s: string) {
    return new Tree(this.parse(s).tokens)
  }
  answer(question: string): string | null {
    this.trace = []
    this.method = undefined
    const sents = sentences(question)
    if (!sents.length) return null
    const qs = sents.filter((s) => s.endsWith('?'))
    if (!qs.length) {
      this.trace.push({ kind: 'brak', text: 'brak zdania pytającego (ze znakiem „?”)' })
      return null
    }
    const q = qs[qs.length - 1]
    const body = sents.filter((s) => s !== q)
    try {
      if (q.includes('„') && q.includes('”')) return this.contradiction(q)
      const ql = q.toLowerCase()
      if (/^(kto|komu)\b/.test(ql)) return this.who(body, q)
      if (ql.startsWith('czy')) return this.yesno(body, q)
      this.trace.push({ kind: 'brak', text: 'rozumujący zna tylko pytania „Czy …?”, „Kto …?”, „Komu …?” i „Czy zdania „…” i „…” mogą być prawdziwe?”' })
    } catch {
      this.trace.push({ kind: 'brak', text: 'rozbiór nie dał jednoznacznej struktury (brak korzenia / indeksu) – nie zgaduję' })
      return null
    }
    return null
  }

  yesno(body: string[], q: string): string | null {
    const Ts = body.map((s) => this.tree(s))
    const Tq = this.tree(q)
    const qq = quant(Tq)
    const bq = Ts.map(quant)
    if (qq || bq.some(Boolean)) return this.quantified(Ts, bq, Tq, qq)
    const rules: Rule[] = []
    const facts: Lit[] = []
    Ts.forEach((T, i) => {
      const [r, f] = rulesAndFact(T, body[i], this.parse)
      rules.push(...r)
      facts.push(...f)
      for (const [a, b] of r) this.trace.push({ kind: 'reguła', text: `„${body[i]}” → jeśli ${litPl(a)}, to ${litPl(b)}` })
      for (const x of f) this.trace.push({ kind: 'fakt', text: `„${body[i]}” → ${litPl(x)}` })
    })
    const ql = literal(Tq, Tq.root())
    if (!ql) {
      this.trace.push({ kind: 'brak', text: 'w pytaniu nie ma słów treści (po odrzuceniu spójników, partykuł i „czy”)' })
      return null
    }
    this.trace.push({ kind: 'rozbiór', text: `pytanie → ${litPl(ql)}` })
    if (!rules.length) {
      const asp = this.aspect(Ts, Tq)
      if (asp) return asp
      if (facts.some((f) => f.key === ql.key)) {
        this.method = 'fakt'
        const hit = facts.some((f) => same(f, ql))
        this.trace.push({ kind: 'wniosek', text: hit ? 'ten sam fakt z tą samą biegunowością → tak' : 'ten sam fakt z przeciwną biegunowością → nie' })
        return hit ? 'tak' : 'nie'
      }
      this.trace.push({ kind: 'brak', text: 'żaden fakt nie ma tych samych słów treści co pytanie, a nie ma reguł' })
      return null
    }
    const known = new Set([...rules.flatMap(([a, b]) => [a.key, b.key]), ...facts.map((f) => f.key)])
    if (!known.has(ql.key)) {
      this.trace.push({ kind: 'brak', text: `słowa pytania ${litPl(ql)} nie występują w żadnej regule ani fakcie` })
      return null
    }
    this.method = 'warunki'
    const cl = closure(facts, rules, this.trace)
    if (cl.some((x) => same(x, ql))) return 'tak'
    if (cl.some((x) => same(x, neg(ql)))) return 'nie'
    this.trace.push({ kind: 'wniosek', text: 'ani pytanie, ani jego przeczenie nie wynika z przesłanek (np. afirmacja następnika) → nie wiadomo' })
    return 'nie wiadomo'
  }

  quantified(Ts: Tree[], bq: (QInfo | null)[], Tq: Tree, qq: QInfo | null): string | null {
    const subset: [string, string][] = []
    for (const x of bq) if (x && x.q === 'all' && x.nominal && x.key.size === 1) subset.push([x.cls, [...x.key][0]])
    for (const x of bq) if (x) this.trace.push({ kind: 'kwantyfikator', text: qPl(x) })
    for (const [s, b] of subset) this.trace.push({ kind: 'reguła', text: `zawieranie klas: ${s} ⊂ ${b}` })
    if (!qq) {
      this.method = 'sylogizm'
      const ql = literal(Tq, Tq.root())
      const facts: Lit[] = []
      Ts.forEach((T, i) => {
        if (!bq[i]) facts.push(...rulesAndFact(T)[1])
      })
      for (const f of facts) this.trace.push({ kind: 'fakt', text: litPl(f) })
      const negq = bq.filter((x): x is QInfo => !!x && x.q === 'none')
      if (!ql || !subset.length) {
        this.trace.push({ kind: 'brak', text: 'brak zdania „wszystkie X to Y” (zawierania klas) albo pytanie bez słów treści' })
        return null
      }
      this.trace.push({ kind: 'rozbiór', text: `pytanie → ${litPl(ql)}` })
      const minus = (s: string[], x: string) => s.filter((w) => w !== x).join('|')
      for (const [small, big] of subset) {
        for (const f of facts) {
          if (f.pol && f.words.includes(small) && ql.words.includes(big) && minus(f.words, small) === minus(ql.words, big)) {
            this.trace.push({ kind: 'wniosek', text: `${small} ⊂ ${big}, fakt o ${small} → to samo dla ${big} → tak` })
            return 'tak'
          }
          if (f.pol && f.words.includes(big) && ql.words.includes(small) && minus(f.words, big) === minus(ql.words, small)) {
            this.trace.push({ kind: 'wniosek', text: `fakt o klasie ogólniejszej (${big}) nie przesądza o ${small} → nie wiadomo` })
            return 'nie wiadomo'
          }
        }
        for (const x of negq) {
          const rest = [...x.key].filter((w) => w !== big)
          if (x.cls === big && ql.words.includes(small) && rest.every((w) => ql.words.includes(w))) {
            this.trace.push({ kind: 'wniosek', text: `żadne ${big} + ${small} ⊂ ${big} → nie` })
            return 'nie'
          }
        }
      }
      this.trace.push({ kind: 'brak', text: 'zawieranie klas nie łączy się z faktem ani z pytaniem' })
      return null
    }
    this.method = 'kwantyfikatory'
    this.trace.push({ kind: 'rozbiór', text: `pytanie → ${qPl(qq)}` })
    for (const x of bq) {
      if (!x || x.cls !== qq.cls) continue
      if (setKey(x.key) === setKey(qq.key)) {
        const a = SQUARE[`${x.q}|${qq.q}`]
        this.trace.push({ kind: 'wniosek', text: `kwadrat logiczny: przesłanka „${Q_PL[x.q]}”, pytanie „${Q_PL[qq.q]}” → ${a}` })
        return a
      }
      if (x.q === 'all' && setKey(antKey(x.key)) === setKey(qq.key)) {
        const a = SQUARE[`none|${qq.q}`]
        this.trace.push({ kind: 'wniosek', text: `przeciwieństwo (mały/duży): wszystkie małe = żadne duże → ${a}` })
        return a
      }
    }
    this.trace.push({ kind: 'brak', text: 'żadna przesłanka z kwantyfikatorem nie mówi o tej samej klasie i tej samej cesze' })
    return null
  }

  aspect(Ts: Tree[], Tq: Tree): string | null {
    if (Ts.length !== 1) return null
    const T = Ts[0]
    const a = T.t(T.root()).feats?.Aspect
    const stopped = T.toks.some((t) => low(t.lemma) === 'przerwać')
    const qa = Tq.t(Tq.root()).feats?.Aspect
    if (qa !== 'Perf' || !a) return null
    this.method = 'aspekt'
    if (stopped) {
      this.trace.push({ kind: 'wniosek', text: '„przerwać” w przesłance → czynność nieskończona → nie' })
      return 'nie'
    }
    this.trace.push({ kind: 'wniosek', text: `aspekt orzeczenia przesłanki: ${a === 'Perf' ? 'dokonany → skończona → tak' : 'niedokonany → nie wiadomo, czy skończona'}` })
    return a === 'Perf' ? 'tak' : 'nie wiadomo'
  }

  contradiction(q: string): string | null {
    this.method = 'sprzeczność'
    const parts = [...q.matchAll(/„([^”]+)”/g)].map((m) => m[1])
    if (parts.length !== 2) {
      this.trace.push({ kind: 'brak', text: 'potrzebne dokładnie dwa zdania w cudzysłowie „…”' })
      return null
    }
    const [A, B] = parts.map((p) => this.tree(p + '.'))
    const qa = quant(A)
    const qb = quant(B)
    if (qa && qb) {
      if (qa.cls !== qb.cls || setKey(qa.key) !== setKey(qb.key)) {
        this.trace.push({ kind: 'brak', text: 'zdania mówią o różnych klasach albo cechach' })
        return null
      }
      const bad = INCOMPATIBLE.has(`${qa.q}|${qb.q}`)
      this.trace.push({ kind: 'sprzeczność', text: `„${Q_PL[qa.q]}” i „${Q_PL[qb.q]}” ${bad ? 'się wykluczają → nie' : 'mogą być prawdziwe razem → tak'}` })
      return bad ? 'nie' : 'tak'
    }
    const la = literal(A, A.root())
    const lb = literal(B, B.root())
    if (!la || !lb) return null
    const bad = la.key === lb.key && la.pol !== lb.pol
    this.trace.push({ kind: 'sprzeczność', text: `${litPl(la)} i ${litPl(lb)}: ${bad ? 'to samo z przeciwną biegunowością → nie' : 'nie są swoim przeczeniem → tak'}` })
    return bad ? 'nie' : 'tak'
  }

  who(body: string[], q: string): string | null {
    const ql = q.toLowerCase()
    const Ts = body.map((s) => this.tree(s))
    if (!Ts.length) {
      this.trace.push({ kind: 'brak', text: 'pytanie „kto/komu” bez zdań z opisem sytuacji' })
      return null
    }
    if (ql.includes('pierwszy') || ql.includes('ostatni')) return this.temporal(Ts, ql.includes('ostatni'))
    if (ql.includes('najwyższy') || ql.includes('najniższy')) return this.ordering(Ts, ql.includes('najwyższy'))
    if (Ts.length !== 1) {
      this.trace.push({ kind: 'brak', text: 'pytanie o rolę działa tylko dla jednego zdania opisu' })
      return null
    }
    this.method = 'rola'
    const T = Ts[0]
    const names = T.toks.filter((t) => ['PROPN', 'NOUN'].includes(t.upos) && isUpper1(t.form))
    let c: ATok[]
    if (ql.startsWith('komu')) {
      c = names.filter((t) => t.q === 'KOMU')
      if (!c.length) c = names.filter((t) => t.feats?.Case === 'Dat')
      this.trace.push({ kind: 'rola', text: `„komu?” → dopełnienie w celowniku: ${c.map((t) => t.form).join(', ') || 'brak'}` })
    } else {
      c = names.filter((t) => t.part === 'podmiot' && (t.feats?.Case ?? 'Nom') === 'Nom')
      this.trace.push({ kind: 'rola', text: `„kto?” → podmiot w mianowniku: ${c.map((t) => t.form).join(', ') || 'brak'}` })
      const verb = T.t(T.root())
      const g = verb.feats?.Gender
      if (g && c.length !== 1) {
        const cand = names.filter((t) => t.i !== verb.i && t.feats?.Case === 'Nom' && t.feats?.Gender === g)
        if (cand.length === 1) {
          c = cand
          this.trace.push({ kind: 'rola', text: `zgoda rodzaju orzeczenia „${verb.form}” (${g}) z podmiotem → ${cand[0].form}` })
        }
      }
    }
    if (c.length > 1 && c.some((t) => t.upos === 'PROPN')) c = c.filter((t) => t.upos === 'PROPN')
    if (c.length !== 1) {
      this.trace.push({ kind: 'brak', text: c.length ? `kilku kandydatów (${c.map((t) => t.form).join(', ')}) – nie zgaduję` : 'nie ma kandydata o tej roli' })
      return null
    }
    this.trace.push({ kind: 'wniosek', text: `lemat (mianownik) „${c[0].form}” → ${c[0].lemma}` })
    return c[0].lemma ?? c[0].form
  }

  temporal(Ts: Tree[], last: boolean): string | null {
    this.method = 'kolejność w czasie'
    const before: [string, string][] = []
    for (const T of Ts) {
      const subj = T.toks.filter((t) => t.part === 'podmiot')
      const cmp = T.toks.slice(1).filter((t) => ['PROPN', 'NOUN'].includes(t.upos) && isUpper1(t.form) && t.part !== 'podmiot' && t.head !== 0)
      if (!T.toks.some((t) => low(t.lemma) === 'wcześnie') || subj.length !== 1 || cmp.length !== 1) {
        this.trace.push({ kind: 'brak', text: 'każde zdanie musi mieć „wcześniej niż”, jeden podmiot i jedną osobę porównywaną' })
        return null
      }
      before.push([subj[0].lemma ?? subj[0].form, cmp[0].lemma ?? cmp[0].form])
      this.trace.push({ kind: 'fakt', text: `${before[before.length - 1][0]} < ${before[before.length - 1][1]}` })
    }
    const people = new Set(before.flat())
    const later = new Set(before.map((p) => p[1]))
    const earlier = new Set(before.map((p) => p[0]))
    const ends = [...people].filter((x) => !(last ? earlier : later).has(x)).sort()
    if (ends.length !== 1) return null
    this.trace.push({ kind: 'wniosek', text: `${last ? 'nikt nie jest po' : 'nikt nie jest przed'}: ${ends[0]}` })
    return ends[0]
  }

  ordering(Ts: Tree[], hi: boolean): string | null {
    this.method = 'porządek'
    const vals = new Map<string, number>()
    for (const T of Ts) {
      for (const nt of T.toks.filter((t) => /^\d+$/.test(t.form))) {
        const prev = T.toks.slice(0, nt.i - 1).filter((t) => t.upos === 'PROPN' || (t.part === 'podmiot' && isUpper1(t.form)))
        if (!prev.length) return null
        vals.set(prev[prev.length - 1].lemma ?? '', Number(nt.form))
      }
    }
    if (vals.size < 2) return null
    const best = [...vals.entries()].reduce((a, b) => (hi ? (b[1] > a[1] ? b : a) : b[1] < a[1] ? b : a))
    this.trace.push({ kind: 'wniosek', text: `${[...vals.entries()].map(([k, v]) => `${k}=${v}`).join(', ')} → ${hi ? 'największa' : 'najmniejsza'}: ${best[0]}` })
    return best[0]
  }
}
