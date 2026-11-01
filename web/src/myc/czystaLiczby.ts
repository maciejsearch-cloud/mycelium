// Czysta grzybnia – reguły liczbowe i analogie (bez modelu językowego): arytmetyka (liczby cyframi i słowami,
// + − × ÷, procenty), zadania tekstowe przez tabelę ról z rozbioru, ciągi liczbowe, liczebniki (zgoda liczebnika
// z rzeczownikiem wg reguł polskiej gramatyki + formy ze słownika Morfeusza), analogie (przekształcenie odmiany
// ze słownika albo relacja wyuczona z faktów zatwierdzonych przez ludzi). Każda reguła zapisuje ślad.
// Uczciwie: reguły napisano znając szablony ćwiczeń selfplay; sprawdzian na zamrożonych parafrazach
// (results/czysta/parafrazy-liczby-v1.json) powstał przed kodem.
import type { ATok, Analysis } from './rozbior'
import type { MorfLex } from './morf'
import { lexAnalyses } from './morf'
import type { Step } from './czysta'
import { school } from './czystaSzkolne'

export type SchoolMethod = 'szkoła: działania' | 'szkoła: procenty' | 'szkoła: jednostki' | 'szkoła: zadanie tekstowe' | 'szkoła: geometria'

export type NumMethod = SchoolMethod | 'arytmetyka' | 'zadanie tekstowe' | 'ciąg' | 'liczebniki' | 'analogia (odmiana)' | 'analogia (relacja z faktów)'
export interface NumResult {
  answer: string
  method: NumMethod
  /** fakty użyte w analogii (id) */
  used?: string[]
}
export interface NumCtx {
  parse: (s: string) => Analysis
  lex?: MorfLex
  trace: Step[]
  /** zdania prawdziwe wg ludzi (do analogii z relacji) */
  facts?: { id: string; text: string }[]
}

// ------------------------------------------------------------------ liczby słowami (lematy SGJP)
export const NUM_WORDS: Record<string, number> = {
  zero: 0, jeden: 1, dwa: 2, trzy: 3, cztery: 4, pięć: 5, sześć: 6, siedem: 7, osiem: 8, dziewięć: 9, dziesięć: 10,
  jedenaście: 11, dwanaście: 12, trzynaście: 13, czternaście: 14, piętnaście: 15, szesnaście: 16, siedemnaście: 17,
  osiemnaście: 18, dziewiętnaście: 19, dwadzieścia: 20, trzydzieści: 30, czterdzieści: 40, pięćdziesiąt: 50,
  sześćdziesiąt: 60, siedemdziesiąt: 70, osiemdziesiąt: 80, dziewięćdziesiąt: 90, sto: 100, dwieście: 200, trzysta: 300,
  czterysta: 400, pięćset: 500, sześćset: 600, siedemset: 700, osiemset: 800, dziewięćset: 900, tysiąc: 1000,
}
const low = (s?: string | null) => (s || '').toLowerCase()

/** Wartość jednego słowa-liczebnika: wprost albo przez lemat Morfeusza (pięciu → pięć). */
export function wordValue(w: string, lex?: MorfLex): number | undefined {
  const f = low(w)
  if (f in NUM_WORDS) return NUM_WORDS[f]
  if (lex) for (const [lem, tag] of lexAnalyses(lex, f)) if (tag.startsWith('num') && lem in NUM_WORDS) return NUM_WORDS[lem]
  return undefined
}

/** Zamienia liczebniki słowami na cyfry („dwadzieścia pięć” → „25”, „sto” → „100”); trace: co zamieniono. */
export function wordsToDigits(text: string, lex?: MorfLex, trace?: Step[]): string {
  const re = /\p{L}+|\d+(?:[.,]\d+)?|\s+|[^\s\p{L}\d]/gu
  const parts = text.match(re) ?? []
  const out: string[] = []
  let i = 0
  const changed: string[] = []
  while (i < parts.length) {
    const v = /\p{L}/u.test(parts[i]) ? wordValue(parts[i], lex) : undefined
    if (v === undefined) {
      out.push(parts[i++])
      continue
    }
    // ciąg słów-liczebników (z odstępami): sumujemy, tysiąc mnoży
    let total = 0
    let cur = v
    const words = [parts[i]]
    let j = i + 1
    while (j + 1 < parts.length && /^\s+$/.test(parts[j])) {
      const w = wordValue(parts[j + 1], lex)
      if (w === undefined) break
      if (w === 1000) {
        total += (cur || 1) * 1000
        cur = 0
      } else if (w < cur || cur === 0) cur += w
      else break
      words.push(parts[j + 1])
      j += 2
    }
    if (cur === 1000) {
      total += 1000
      cur = 0
    }
    const n = total + cur
    // „jeden” bez innych liczebników bywa zaimkiem („jeden z…”) – zostawiamy
    if (n === 1 && words.length === 1 && low(words[0]) !== 'jeden') {
      out.push(parts[i++])
      continue
    }
    changed.push(`„${words.join(' ')}” = ${n}`)
    out.push(String(n))
    i = j
  }
  if (changed.length) trace?.push({ kind: 'rozbiór', text: `liczebniki słowami: ${changed.join(', ')}` })
  return out.join('')
}

const nums = (s: string) => [...s.matchAll(/-?\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')))
const fmtN = (x: number) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1e6) / 1e6).replace('.', ','))

// ------------------------------------------------------------------ arytmetyka (bezpieczny parser, bez eval)
const OPS_WORDS: [RegExp, string][] = [
  [/\bpomno[żz]on[aey]? przez\b|\brazy\b|\bx\b|×|\*/giu, ' * '],
  [/\bpodzieli[ćc] przez\b|\bpodzielon[aey]? przez\b|\bdzielone przez\b|÷|:/giu, ' / '],
  [/\bplus\b|\bdoda[ćc]\b|\bdodać\b|\+/giu, ' + '],
  [/\bminus\b|\bodj[ąa][ćc]\b|−/giu, ' - '],
]
type Tok = { t: 'n'; v: number } | { t: 'o'; v: string }
function tokensOf(expr: string): Tok[] | null {
  const out: Tok[] = []
  const re = /\s*(\d+(?:[.,]\d+)?|[-+*/()])\s*/gy
  let m: RegExpExecArray | null
  let at = 0
  while (at < expr.length && (m = re.exec(expr))) {
    at = re.lastIndex
    out.push(/\d/.test(m[1]) ? { t: 'n', v: Number(m[1].replace(',', '.')) } : { t: 'o', v: m[1] })
  }
  return at >= expr.trim().length || expr.slice(at).trim() === '' ? out : null
}
/** Shunting-yard: kolejność działań (× ÷ przed + −), nawiasy. Zwraca wynik i kroki. */
export function evaluate(expr: string, steps: string[]): number | null {
  const toks = tokensOf(expr)
  if (!toks || !toks.length) return null
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const outq: Tok[] = []
  const st: string[] = []
  let prev: Tok | undefined
  for (const k of toks) {
    if (k.t === 'n') outq.push(k)
    else if (k.v === '(') st.push('(')
    else if (k.v === ')') {
      while (st.length && st[st.length - 1] !== '(') outq.push({ t: 'o', v: st.pop()! })
      if (st.pop() !== '(') return null
    } else {
      if (!prev || (prev.t === 'o' && prev.v !== ')')) return null // bez liczb ujemnych na początku
      while (st.length && st[st.length - 1] !== '(' && prec[st[st.length - 1]] >= prec[k.v]) outq.push({ t: 'o', v: st.pop()! })
      st.push(k.v)
    }
    prev = k
  }
  while (st.length) {
    const o = st.pop()!
    if (o === '(') return null
    outq.push({ t: 'o', v: o })
  }
  const S: number[] = []
  const SYM: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }
  for (const k of outq) {
    if (k.t === 'n') S.push(k.v)
    else {
      const b = S.pop()
      const a = S.pop()
      if (a === undefined || b === undefined) return null
      if (k.v === '/' && b === 0) return null
      const r = k.v === '+' ? a + b : k.v === '-' ? a - b : k.v === '*' ? a * b : a / b
      steps.push(`${fmtN(a)} ${SYM[k.v]} ${fmtN(b)} = ${fmtN(r)}`)
      S.push(r)
    }
  }
  return S.length === 1 ? S[0] : null
}

export function arithmetic(text: string, ctx: NumCtx): NumResult | null {
  const q = wordsToDigits(text, ctx.lex)
  const m = /\bile\s+(?:to\s+|wynosi\s+|jest\s+|będzie\s+)?(.+?)\??\s*$/iu.exec(q.trim())
  if (!m) return null
  let e = m[1].trim()
  // procent: „P% z N” / „P procent z N”
  const pc = /^(\d+(?:[.,]\d+)?)\s*(?:%|procent\w*)\s*(?:z|od)\s*(\d+(?:[.,]\d+)?)$/iu.exec(e)
  if (pc) {
    const p = Number(pc[1].replace(',', '.'))
    const n = Number(pc[2].replace(',', '.'))
    const r = (p / 100) * n
    ctx.trace.push({ kind: 'reguła', text: `procent: ${fmtN(p)}% z ${fmtN(n)} = ${fmtN(p)} ÷ 100 × ${fmtN(n)} = ${fmtN(r)}` })
    return { answer: fmtN(r), method: 'arytmetyka' }
  }
  for (const [re, op] of OPS_WORDS) e = e.replace(re, op)
  if (!/\d/.test(e) || !/[-+*/]/.test(e)) return null
  const steps: string[] = []
  const r = evaluate(e, steps)
  if (r === null) {
    ctx.trace.push({ kind: 'brak', text: `nie umiem odczytać działania „${m[1]}”` })
    return null
  }
  ctx.trace.push({ kind: 'rozbiór', text: `działanie: ${e.replace(/\s+/g, ' ').trim()}` })
  for (const s of steps) ctx.trace.push({ kind: 'wniosek', text: s })
  return { answer: fmtN(r), method: 'arytmetyka' }
}

// ------------------------------------------------------------------ ciągi
type SeqRule = { name: string; next: number; why: string }
function seqRule(xs: number[]): SeqRule | null {
  const n = xs.length
  if (n < 3) return null
  const d = xs.slice(1).map((x, i) => x - xs[i])
  if (d.every((v) => v === d[0])) return { name: 'stała różnica', next: xs[n - 1] + d[0], why: `różnice ${d.join(', ')} → +${d[0]}` }
  if (xs.every((x) => x !== 0)) {
    const q = xs.slice(1).map((x, i) => x / xs[i])
    if (q.every((v) => Math.abs(v - q[0]) < 1e-9) && q[0] !== 1) return { name: 'stały iloraz', next: xs[n - 1] * q[0], why: `ilorazy ${q.map(fmtN).join(', ')} → ×${fmtN(q[0])}` }
  }
  if (n >= 4) {
    const d2 = d.slice(1).map((x, i) => x - d[i])
    if (d2.every((v) => v === d2[0])) {
      const nd = d[d.length - 1] + d2[0]
      return { name: 'różnice drugiego rzędu', next: xs[n - 1] + nd, why: `różnice ${d.join(', ')}; ich różnice ${d2.join(', ')} → następna różnica ${nd}` }
    }
  }
  return null
}
function simpleRule(xs: number[]): SeqRule | null {
  if (xs.length >= 2 && xs.every((x) => x === xs[0])) return { name: 'stała', next: xs[0], why: `wszystkie = ${xs[0]}` }
  if (xs.length === 2) return null
  return seqRule(xs)
}

export function sequence(text: string, ctx: NumCtx): NumResult | null {
  if (!/ciąg|następn|dalej|wyraz|po\s+\d/i.test(text)) return null
  const t = wordsToDigits(text, ctx.lex).replace(/podaj liczbę\.?/i, '')
  const xs = nums(t)
  if (xs.length < 3) return null
  ctx.trace.push({ kind: 'rozbiór', text: `wyrazy ciągu: ${xs.join(', ')}` })
  const r = seqRule(xs)
  if (r) {
    ctx.trace.push({ kind: 'reguła', text: `${r.name}: ${r.why}` }, { kind: 'wniosek', text: `następny wyraz = ${fmtN(r.next)}` })
    return { answer: fmtN(r.next), method: 'ciąg' }
  }
  // na przemian: wyrazy nieparzyste i parzyste osobno (≥ 2 w każdej części)
  if (xs.length >= 4) {
    const odd = xs.filter((_, i) => i % 2 === 0)
    const even = xs.filter((_, i) => i % 2 === 1)
    const ro = simpleRule(odd)
    const re = simpleRule(even)
    if (ro && re) {
      const nextOdd = xs.length % 2 === 0
      const r2 = nextOdd ? ro : re
      ctx.trace.push(
        { kind: 'reguła', text: `na przemian – miejsca nieparzyste ${odd.join(', ')} (${ro.name}), parzyste ${even.join(', ')} (${re.name})` },
        { kind: 'wniosek', text: `następne miejsce jest ${nextOdd ? 'nieparzyste' : 'parzyste'}: ${r2.why} → ${fmtN(r2.next)}` },
      )
      return { answer: fmtN(r2.next), method: 'ciąg' }
    }
  }
  ctx.trace.push({ kind: 'brak', text: 'ciąg nie ma stałej różnicy, stałego ilorazu, stałych różnic drugiego rzędu ani wzoru na przemian' })
  return null
}

// ------------------------------------------------------------------ opcje „Wybierz …: a, b, c.”
export function options(text: string): string[] | null {
  const m = /wybierz[^:]*:\s*([^?]+?)\.?\s*$/iu.exec(text.trim())
  if (!m) return null
  const xs = m[1].split(/,\s*|\s+albo\s+|\s+lub\s+/).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean)
  return xs.length >= 2 ? xs : null
}

// ------------------------------------------------------------------ liczebniki
const tagOf = (tag: string) => {
  const p = tag.split(':')
  return { pos: p[0], num: p[1], cas: p[2], rest: p.slice(3) }
}
export function numerals(text: string, ctx: NumCtx): NumResult | null {
  const opts = options(text)
  if (!opts || !ctx.lex) return null
  const head = text.split(/wybierz/i)[0]
  const t = wordsToDigits(head, ctx.lex)
  const ns = nums(t)
  if (ns.length !== 1 || !Number.isInteger(ns[0]) || ns[0] < 1) return null
  const n = ns[0]
  // reguła polskiej gramatyki (rzeczowniki niemęskoosobowe): 1 → l. poj. mianownik; 2–4 (bez 12–14) na końcu → l. mn.
  // mianownik; pozostałe (5–21, 25–31…, 100, 1000) → l. mn. dopełniacz
  const want = n === 1 ? ['sg', 'nom'] : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? ['pl', 'nom'] : ['pl', 'gen']
  const why = n === 1 ? '1 → liczba pojedyncza, mianownik' : want[1] === 'nom' ? `${n} kończy się na 2–4 (nie 12–14) → liczba mnoga, mianownik` : `${n} → liczba mnoga, dopełniacz (5 i więcej, 12–14, końcówki 0, 1, 5–9)`
  ctx.trace.push({ kind: 'reguła', text: `zgoda liczebnika z rzeczownikiem: ${why}` })
  // lemat rzeczownika z nawiasu „(kot)” – formy innych lematów (np. „kot” jako dopełniacz od „kota”) odpadają
  const base = /\(([^)]+)\)/.exec(head)?.[1]?.trim().toLowerCase()
  const baseLem = base ? new Set(lexAnalyses(ctx.lex, base).filter(([, tag]) => /^(subst|depr):sg:nom/.test(tag)).map(([l]) => l.split(':')[0])) : new Set<string>()
  if (baseLem.size) ctx.trace.push({ kind: 'fakt', text: `rzeczownik w nawiasie: „${base}” (lemat ${[...baseLem].join(', ')})` })
  const fit = opts.filter((o) => lexAnalyses(ctx.lex!, o).some(([lem, tag]) => {
    const x = tagOf(tag)
    return (x.pos === 'subst' || x.pos === 'depr') && x.num === want[0] && x.cas === want[1] && (!baseLem.size || baseLem.has(lem.split(':')[0]))
  }))
  for (const o of opts) {
    const an = lexAnalyses(ctx.lex, o).filter(([, tag]) => tag.startsWith('subst')).map(([, tag]) => tag.split(':').slice(1, 3).join(':'))
    ctx.trace.push({ kind: 'fakt', text: `„${o}” wg słownika: ${an.length ? [...new Set(an)].join(', ') : 'brak w słowniku'}` })
  }
  if (fit.length !== 1) {
    ctx.trace.push({ kind: 'brak', text: fit.length ? `kilka form pasuje (${fit.join(', ')}) – nie zgaduję` : 'żadna forma nie ma w słowniku potrzebnej liczby i przypadka' })
    return null
  }
  ctx.trace.push({ kind: 'wniosek', text: `forma ${want[0] === 'sg' ? 'l. poj.' : 'l. mn.'} ${want[1] === 'nom' ? 'mianownik' : 'dopełniacz'}: ${fit[0]}` })
  return { answer: fit[0], method: 'liczebniki' }
}

// ------------------------------------------------------------------ analogie
function lemmasTags(lex: MorfLex, w: string): [string, string][] {
  return lexAnalyses(lex, w)
}
/** różnica cech między dwiema interpretacjami tego samego lematu: pozycje tagu, które się zmieniają */
function tagDiff(a: string, b: string): string | null {
  const x = a.split(':')
  const y = b.split(':')
  if (x[0] !== y[0] && !(x[0] === 'subst' && y[0] === 'depr')) return null
  if (x.length !== y.length) return null
  const d: string[] = []
  for (let i = 1; i < x.length; i++) if (x[i] !== y[i]) d.push(`${i}:${x[i]}>${y[i]}`)
  return d.length ? d.join(',') : null
}
const GRAM_PL: Record<string, string> = { sg: 'l. poj.', pl: 'l. mn.', nom: 'mianownik', gen: 'dopełniacz', dat: 'celownik', acc: 'biernik', inst: 'narzędnik', loc: 'miejscownik', voc: 'wołacz', pos: 'stopień równy', com: 'stopień wyższy', sup: 'stopień najwyższy' }
const diffPl = (d: string) => d.split(',').map((p) => p.split(':')[1].split('>').map((v) => GRAM_PL[v] ?? v).join(' → ')).join('; ')

export function analogy(text: string, ctx: NumCtx): NumResult | null {
  const m = /^\s*([\p{L}-]+)\s*:\s*([\p{L}-]+)\s*=\s*([\p{L}-]+)\s*:\s*\?/u.exec(text)
  if (!m) return null
  const [, A, B, C] = m
  const opts = options(text) ?? []
  ctx.trace.push({ kind: 'rozbiór', text: `analogia ${A} : ${B} = ${C} : ?${opts.length ? `; opcje: ${opts.join(', ')}` : ''}` })
  // 1) odmiana: B to inna forma tego samego lematu co A (przypadek, liczba, stopień) → to samo przekształcenie dla C
  if (ctx.lex && opts.length) {
    const la = lemmasTags(ctx.lex, A)
    const lb = lemmasTags(ctx.lex, B)
    const diffs = new Set<string>()
    for (const [l1, t1] of la) for (const [l2, t2] of lb) if (l1 === l2) {
      const d = tagDiff(t1, t2)
      if (d) diffs.add(d)
    }
    if (diffs.size) {
      const lc = lemmasTags(ctx.lex, C)
      const hits = new Map<string, string>()
      for (const o of opts) {
        for (const [l3, t3] of lc) for (const [l4, t4] of lemmasTags(ctx.lex, o)) {
          const d = l3 === l4 ? tagDiff(t3, t4) : null
          if (d && diffs.has(d)) hits.set(o, d)
        }
      }
      if (hits.size === 1) {
        const [o, d] = [...hits][0]
        ctx.trace.push({ kind: 'reguła', text: `„${B}” to forma „${A}” (ten sam lemat w słowniku): ${diffPl(d)}` }, { kind: 'wniosek', text: `to samo przekształcenie „${C}” → „${o}”` })
        return { answer: o, method: 'analogia (odmiana)' }
      }
      ctx.trace.push({ kind: 'brak', text: hits.size ? `kilka opcji pasuje do przekształcenia (${[...hits.keys()].join(', ')})` : `„${B}” to odmiana „${A}”, ale żadna opcja nie jest tak samo odmienionym „${C}”` })
    }
  }
  // 2) relacja wyuczona: zdanie zatwierdzone przez ludzi z A i B → słowa łączące (relacja); szukamy faktu z C i opcją
  const facts = ctx.facts ?? []
  if (facts.length) {
    const lem = (s: string) => ctx.parse(s).tokens
    // lematy słowa: ze słownika (wszystkie interpretacje) i z rozbioru – rozbiór bywa niespójny
    const lemSet = (form: string, parsed?: string): Set<string> => {
      const k = new Set<string>([low(form)]) // sama forma też – słownik nie zna każdego słowa („cielę”)
      if (parsed) k.add(low(parsed))
      if (ctx.lex) for (const [l] of lemmasTags(ctx.lex, low(form))) k.add(low(l.split(':')[0]))
      return k
    }
    const lemOf = (w: string) => lemSet(w)
    const POS: Record<string, RegExp> = { VERB: /^(fin|praet|inf|impt|bedzie|imps|pcon|pant|ger|pact|ppas|winien)/, AUX: /^(fin|praet|inf|bedzie)/, NOUN: /^(subst|depr)/, PROPN: /^(subst|depr)/, ADJ: /^adj/, ADV: /^adv/ }
    // lemat do ramy: interpretacja ze słownika zgodna z częścią mowy z rozbioru (stała dla tej samej formy)
    const canon = (t: ATok) => {
      const re = POS[t.upos]
      const ls = ctx.lex ? lemmasTags(ctx.lex, low(t.form)).filter(([, tag]) => !re || re.test(tag)).map(([l]) => low(l.split(':')[0])).sort() : []
      return ls[0] ?? low(t.lemma || t.form)
    }
    // przypadki możliwe dla formy (słownik + rozbiór) – „igły” to dopełniacz l. poj. albo mianownik/biernik l. mn.
    const cases = (t: ATok, k: Set<string>) => {
      const c = new Set<string>()
      if (t.feats?.Case) c.add(t.feats.Case.toLowerCase())
      if (ctx.lex) for (const [l, tag] of lemmasTags(ctx.lex, low(t.form))) if (k.has(low(l.split(':')[0]))) for (const x of (tag.split(':')[2] ?? '').split('.')) if (x) c.add(x)
      return c
    }
    type Rel = { rest: string; xc: Set<string>; yc: Set<string> }
    // rama relacji: pozostałe słowa zdania (lematy, bez kolejności) + możliwe przypadki X i Y – „Lis mieszka w norze.” i
    // „W budzie mieszka pies.” mają tę samą ramę {mieszkać, w}, X w mianowniku, Y w miejscowniku
    const relOf = (toks: ATok[], x: Set<string>, y: Set<string>): Rel | null => {
      const hit = (t: ATok, k: Set<string>) => [...lemSet(t.form, t.lemma)].some((l) => k.has(l))
      const ix = toks.findIndex((t) => t.upos !== 'PUNCT' && hit(t, x))
      const iy = toks.findIndex((t, i) => i !== ix && t.upos !== 'PUNCT' && hit(t, y))
      if (ix < 0 || iy < 0) return null
      const rest = toks.filter((t, i) => i !== ix && i !== iy && t.upos !== 'PUNCT').map(canon).sort().join(' ')
      return { rest, xc: cases(toks[ix], x), yc: cases(toks[iy], y) }
    }
    const meet = (a: Set<string>, b: Set<string>) => !a.size || !b.size || [...a].some((x) => b.has(x))
    const sameRel = (a: Rel | null, b: Rel) => !!a && a.rest === b.rest && meet(a.xc, b.xc) && meet(a.yc, b.yc)
    const relPl = (r: Rel) => r.rest || '(sąsiedztwo)'
    const casePl = (c: Set<string>) => [...c].map((x) => GRAM_PL[x] ?? x).join('/')
    const [la, lb, lc] = [A, B, C].map(lemOf)
    let rel: { r: Rel; id: string; text: string } | undefined
    for (const f of facts) {
      const r = relOf(lem(f.text), la, lb)
      if (r) {
        rel = { r, id: f.id, text: f.text }
        break
      }
    }
    if (rel) {
      ctx.trace.push({ kind: 'fakt', text: `„${rel.text}” łączy ${A} i ${B} relacją „${relPl(rel.r)}” (${A}: ${casePl(rel.r.xc)}; ${B}: ${casePl(rel.r.yc)})` })
      const hits: { o: string; id: string; text: string }[] = []
      for (const o of opts.length ? opts : []) {
        const lo = lemOf(o)
        for (const f of facts) if (sameRel(relOf(lem(f.text), lc, lo), rel.r)) hits.push({ o, id: f.id, text: f.text })
      }
      const uniq = [...new Set(hits.map((h) => h.o))]
      if (uniq.length === 1) {
        const h = hits[0]
        ctx.trace.push({ kind: 'fakt', text: `„${h.text}” łączy ${C} i ${h.o} tą samą relacją` }, { kind: 'wniosek', text: `${C} : ${h.o}` })
        return { answer: h.o, method: 'analogia (relacja z faktów)', used: [rel.id, h.id] }
      }
      ctx.trace.push({ kind: 'brak', text: uniq.length ? `kilka opcji ma tę relację (${uniq.join(', ')})` : `brak zatwierdzonego faktu łączącego „${C}” z którąś opcją relacją „${relPl(rel.r)}”` })
      return null
    }
  }
  ctx.trace.push({ kind: 'brak', text: `brak zatwierdzonego faktu łączącego „${A}” i „${B}” (np. zdania „${A} … ${B}.”) i nie jest to odmiana tego samego słowa – naucz relacji faktem` })
  return null
}

// ------------------------------------------------------------------ zadania tekstowe (tabela ról)
const GAIN = new Set(['dostać', 'otrzymać', 'kupić', 'znaleźć', 'zebrać', 'zarobić', 'wygrać', 'dokupić', 'dodać', 'przynieść', 'zerwać', 'złowić', 'upiec', 'narysować', 'zrobić', 'dołożyć', 'uzbierać'])
const LOSS = new Set(['oddać', 'dać', 'zgubić', 'zjeść', 'sprzedać', 'wydać', 'stracić', 'zużyć', 'podarować', 'pożyczyć', 'zabrać', 'wypić', 'rozdać', 'ubyć', 'zniszczyć', 'wyrzucić', 'przegrać', 'zapłacić'])
/** Czasowniki ruchu z przedrostkiem: od-/u-/wy- = rzecz odchodzi (ubywa), przy-/do- = przychodzi (przybywa). */
const MOTION = '(jść|iść|lecieć|latywać|biec|biegnąć|płynąć|jechać|frunąć|fruwać|wieźć|nieść|ciec|pełznąć|skoczyć|wędrować)'
const AWAY = new RegExp(`^(od|ode|u|wy|z|ze)${MOTION}$`)
const TOWARD = new RegExp(`^(przy|przyj|do|nad)${MOTION}$`)
/** Zniknięcie rzeczy liczonej (rzecz jest podmiotem): „dwie piłki pękły”. */
const VANISH = new Set(['pęknąć', 'zniknąć', 'zginąć', 'uschnąć', 'zepsuć', 'rozbić', 'stłuc', 'zgnić', 'spaść', 'zwiędnąć'])
const STATE = new Set(['mieć', 'być', 'stać', 'leżeć', 'znajdować', 'wisieć', 'rosnąć', 'siedzieć', 'mieszkać'])
const ABBR: Record<string, string> = { zł: 'złoty', gr: 'grosz', kg: 'kilogram', g: 'gram', km: 'kilometr', m: 'metr', cm: 'centymetr', l: 'litr' }

export function wordProblem(text: string, ctx: NumCtx): NumResult | null {
  const sents = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const q = sents.findLast((s) => /\?\s*$/.test(s))
  if (!q || !/^\s*ile\b/i.test(q)) return null
  const body = sents.filter((s) => s !== q)
  if (!body.length) return null
  const lemmaOf = (t: ATok) => ABBR[low(t.form)] ?? low(t.lemma || t.form)
  const Tq = ctx.parse(wordsToDigits(q, ctx.lex)).tokens
  // pytany rzeczownik: pierwszy rzeczownik po „ile”; właściciel: imię (podmiot albo celownik „zostało Ali”)
  const noun = Tq.find((t, i) => i > 0 && (t.upos === 'NOUN' || ABBR[low(t.form)]))
  if (!noun) return null
  const what = lemmaOf(noun)
  // ta sama rzecz: lemat z rozbioru, lematy ze słownika albo wspólny temat (5 liter) – rozbiór bywa niespójny („kredek”/„kredka”)
  const keys = (t: ATok): Set<string> => {
    const k = new Set([lemmaOf(t), low(t.form)])
    if (ctx.lex) for (const [l, tag] of lexAnalyses(ctx.lex, low(t.form))) if (/^(subst|depr)/.test(tag)) k.add(low(l.split(':')[0]))
    for (const x of [...k]) if (x.length >= 5) k.add(x.slice(0, 5))
    return k
  }
  const whatKeys = keys(noun)
  const sameThing = (t: ATok | undefined) => !!t && [...keys(t)].some((x) => whatKeys.has(x))
  // osoba: lemat imienia ze słownika (wielka litera), inaczej z rozbioru
  const person = (t: ATok): string => {
    if (ctx.lex) for (const [l] of lexAnalyses(ctx.lex, t.form)) if (/^\p{Lu}/u.test(l)) return low(l.split(':')[0])
    return low(t.lemma || t.form)
  }
  const ownerQ = Tq.find((t) => t.upos === 'PROPN' || (t.upos === 'NOUN' && /^\p{Lu}/u.test(t.form) && t.i > 1))
  const owner = ownerQ ? person(ownerQ) : null
  const together = /\b(razem|łącznie|w sumie|wszystkich)\b/i.test(q)
  ctx.trace.push({ kind: 'rozbiór', text: `pytanie o liczbę: „${what}”${owner ? `, czyje: ${ownerQ!.lemma}` : ''}${together ? ', razem' : ''}` })
  const ledger = new Map<string, number>()
  const SCENE = '·'
  let lastOwner: string | null = null
  let sumAll = 0
  let nAll = 0
  let unknown = false
  // bezpieczniki: każda liczba z treści musi zostać użyta, nie można oddać tego, czego się nie ma,
  // a dwie liczby nie mogą wisieć na jednym czasowniku, gdy w zdaniu są dwa – wtedy „nie wiem” zamiast zgadywania
  let given = 0
  let used = 0
  let unsafe = ''
  for (const s0 of body) {
    const s = wordsToDigits(s0, ctx.lex, ctx.trace)
    const T = ctx.parse(s).tokens
    const tk = (i: number) => T[i - 1]
    const verbOf = (t: ATok): ATok | undefined => {
      let x: ATok | undefined = t
      for (let k = 0; k < 6 && x; k++) {
        if (x.upos === 'VERB' || (x.upos === 'AUX' && x.head === 0)) return x
        x = x.head ? tk(x.head) : undefined
      }
      return T.find((y) => y.head === 0)
    }
    // odcinki zdania: przecinek albo spójnik „i/a/oraz/ale/potem” zaczyna nowy odcinek; liczba należy do czasownika swojego
    // odcinka (dwa czasowniki i dwie liczby w jednym zdaniu); odcinek bez czasownika („a od taty 5”) dziedziczy poprzedni
    const seg = new Map<number, number>()
    {
      let k = 0
      for (const t of T) {
        if (t.form === ',' || (t.upos === 'CCONJ' && ['i', 'a', 'oraz', 'ale', 'lecz'].includes(low(t.form)))) k++
        seg.set(t.i, k)
      }
    }
    const segVerb = (n: ATok): ATok | undefined => {
      const k = seg.get(n.i)!
      for (let j = k; j >= 0; j--) {
        const vs = T.filter((t) => seg.get(t.i) === j && t.upos === 'VERB')
        if (vs.length === 1) return vs[0]
        if (vs.length > 1) return j === k ? verbOf(n) : vs[vs.length - 1]
      }
      return verbOf(n)
    }
    const sameSeg = (a: ATok | undefined, n: ATok) => {
      if (!a) return false
      const ka = seg.get(a.i)!
      const kn = seg.get(n.i)!
      if (ka === kn) return true
      // odcinek bez czasownika należy do poprzedniego
      for (let j = kn; j > ka; j--) if (T.some((t) => seg.get(t.i) === j && t.upos === 'VERB')) return false
      return ka < kn && T.some((t) => seg.get(t.i) === ka && t.upos === 'VERB')
    }
    // mnożenie: „W k pudełkach jest po y kredek”, „6 rzędów po 8 książek”
    const po = T.findIndex((t) => low(t.form) === 'po')
    const ns = T.filter((t) => /^\d+(?:[.,]\d+)?$/.test(t.form))
    given += (s.match(/\d+(?:[.,]\d+)?/g) ?? []).length
    const nVerbs = T.filter((t) => t.upos === 'VERB').length
    const verbUse = new Map<number, number>()
    // bezpiecznik: „po” bez liczby tuż za nim („po południu”) to nie podział – nie mnożę, a gdy są dwie liczby, nie zgaduję
    if (po >= 0 && ns.length === 2 && !/^\d/.test(T[po + 1]?.form ?? '')) {
      unsafe ||= `„po ${T[po + 1]?.form ?? ''}” nie jest podziałem „po N”, a w zdaniu są dwie liczby – nie wiem, co z czym mnożyć`
    }
    if (po >= 0 && ns.length === 2 && /^\d/.test(T[po + 1]?.form ?? '')) {
      const per = ns.find((t) => t.i > po + 1) ?? ns[1]
      const k = ns.find((t) => t !== per)!
      const v = Number(k.form.replace(',', '.')) * Number(per.form.replace(',', '.'))
      ctx.trace.push({ kind: 'reguła', text: `„po ${per.form}” przy ${k.form} grupach → mnożenie: ${k.form} × ${per.form} = ${v}` })
      ledger.set(SCENE, (ledger.get(SCENE) ?? 0) + v)
      sumAll += v
      nAll++
      used += 2
      continue
    }
    // krotność: „zwiększyła się 3-krotnie / trzykrotnie”
    const kr = /(\d+)\s*-?\s*krotnie|(\p{L}+)krotnie/iu.exec(s)
    if (kr) {
      const k = kr[1] ? Number(kr[1]) : wordValue(kr[2], ctx.lex)
      const down = /zmniejsz|spad|zmal/i.test(s)
      const who = T.find((t) => t.upos === 'PROPN')
      const o = who ? person(who) : (lastOwner ?? SCENE)
      if (k && ledger.has(o)) {
        const v = down ? ledger.get(o)! / k : ledger.get(o)! * k
        ctx.trace.push({ kind: 'reguła', text: `${down ? 'zmniejszenie' : 'zwiększenie'} ${k}-krotne: ${fmtN(ledger.get(o)!)} ${down ? '÷' : '×'} ${k} = ${fmtN(v)}` })
        ledger.set(o, v)
        used += 1
        continue
      }
      unsafe ||= `„${kr[0]}” – nie wiem, czyją liczbę zmienić (brak stanu dla ${o === SCENE ? 'tej osoby' : o})`
    }
    // bezpiecznik: porównanie przymiotnikiem/przysłówkiem w stopniu wyższym („o 4 lata starszy”) – reguły znają tylko „o N więcej/mniej”
    if (ns.length && T.some((t) => t.feats?.Degree === 'Cmp' && !['więcej', 'mniej'].includes(low(t.form)))) {
      unsafe ||= `porównanie „${T.find((t) => t.feats?.Degree === 'Cmp')!.form}” – znam tylko „o N więcej/mniej”`
    }
    for (const nt of ns) {
      const val = Number(nt.form.replace(',', '.'))
      // rzeczownik liczony: najbliższy rzeczownik zależny od liczby lub nadrzędny dla niej; bez niego – pytany (elipsa)
      // rzeczownik liczony: najbliższy rzeczownik zależny od liczby (nie odbiorca w celowniku) albo nadrzędny dla niej
      const kids = T.filter((t) => t.head === nt.i && (t.upos === 'NOUN' || ABBR[low(t.form)]) && (t.feats?.Case !== 'Dat' || sameThing(t))).sort((a, b) => Math.abs(a.i - nt.i) - Math.abs(b.i - nt.i))
      const next = tk(nt.i + 1)
      const nn = kids[0] ?? (next && next.upos === 'NOUN' && next.feats?.Case !== 'Dat' ? next : undefined) ?? (nt.head ? tk(nt.head) : undefined)
      // rzeczownik w wyrażeniu przyimkowym („od mamy”, „na lody”) nie jest liczoną rzeczą – wtedy elipsa
      const inPP = !!nn && T.some((t) => t.upos === 'ADP' && t.head === nn.i)
      const nounOk = nn && (nn.upos === 'NOUN' || ABBR[low(nn.form)]) && !inPP
      const v = segVerb(nt)
      const vl = v ? low(v.lemma) : ''
      const subj = T.find((t) => t.part === 'podmiot' && t.head === v?.i && (t.upos === 'PROPN' || t.upos === 'NOUN' || t.upos === 'PRON'))
      let o: string = subj && subj.upos === 'PROPN' ? person(subj) : subj && subj.upos === 'PRON' ? SCENE : (lastOwner ?? SCENE)
      const thingSubj = (subj?.upos === 'NOUN' && sameThing(subj)) || (!!nn && !!v && sameThing(nn) && nn.feats?.Case === 'Nom' && seg.get(nn.i) === seg.get(v.i)) || (!!nn && nn === v)
      if (thingSubj) o = lastOwner ?? SCENE // „W koszu było 24 jabłka” – rzecz jako podmiot
      // o N więcej / mniej niż ktoś
      const cmp = T.some((t) => ['więcej', 'mniej'].includes(low(t.form))) && T.some((t) => low(t.form) === 'o' && t.i < nt.i)
      if (nounOk && !sameThing(nn) && !ABBR[low(nn?.form ?? '')]) {
        ctx.trace.push({ kind: 'fakt', text: `${nt.form} ${nn?.form ?? ''} – inna rzecz niż „${what}”, pomijam` })
        used++
        continue
      }
      const za = T.find((t) => t.head === (nn?.i ?? -1) && low(t.form) === 'za')
      const rec = T.find((t) => t.head === v?.i && t.feats?.Case === 'Dat' && (t.upos === 'PROPN' || t.upos === 'NOUN') && sameSeg(t, nt) && !sameThing(t))
      // źródło „od kogoś” – w tym samym odcinku co liczba (albo w odcinku-elipsie)
      const od = T.find((t) => low(t.form) === 'od' && seg.get(t.i) === seg.get(nt.i)) ?? T.find((t) => low(t.form) === 'od' && sameSeg(t, nt) && !T.some((x) => x.i > t.i && x.i < nt.i && x.upos === 'VERB'))
      nAll++
      sumAll += val
      let op: '=' | '+' | '-' | null = null
      let why = ''
      if (cmp) {
        const more = T.some((t) => low(t.form) === 'więcej')
        const base = lastOwner && ledger.has(lastOwner) ? ledger.get(lastOwner)! : null
        if (base !== null) {
          const r = more ? base + val : base - val
          ctx.trace.push({ kind: 'reguła', text: `„o ${val} ${more ? 'więcej' : 'mniej'}” niż ${lastOwner}: ${base} ${more ? '+' : '−'} ${val} = ${r}` })
          ledger.set(o === lastOwner ? SCENE : o, r)
          if (o !== lastOwner) lastOwner = o
          used++
          continue
        }
      }
      if (za) [op, why] = ['-', `„za ${val}” – zapłata`]
      else if (STATE.has(vl) && !ledger.has(o)) [op, why] = ['=', `„${v?.form}” – stan początkowy`]
      else if (rec && person(rec) !== o) [op, why] = ['-', `„${v?.form}” z odbiorcą w celowniku (${rec.form}) – ubywa`]
      else if (od) [op, why] = ['+', `„${v?.form} … od ${tk(od.i + 1)?.form ?? ''}” – przybywa`]
      else if (GAIN.has(vl)) [op, why] = ['+', `„${v?.form}” – przybywa`]
      else if (LOSS.has(vl)) [op, why] = ['-', `„${v?.form}” – ubywa`]
      else if (STATE.has(vl)) [op, why] = ['=', `„${v?.form}” – stan`]
      else if (AWAY.test(vl)) [op, why] = ['-', `„${v?.form}” – czasownik ruchu z przedrostkiem „od-/u-/wy-”: odchodzi, ubywa`]
      else if (TOWARD.test(vl)) [op, why] = ['+', `„${v?.form}” – czasownik ruchu z przedrostkiem „przy-/do-”: przychodzi, przybywa`]
      else if (thingSubj && VANISH.has(vl)) [op, why] = ['-', `„${v?.form}” – rzecz przestaje istnieć, ubywa`]
      else if (!ledger.has(o) && ledger.size === 0) [op, why] = ['=', `„${v?.form ?? '?'}” – pierwsza wzmianka o liczbie, stan początkowy`]
      if (!op) {
        ctx.trace.push({ kind: 'brak', text: `nie wiem, czy „${v?.form ?? '?'}” dodaje, czy odejmuje` })
        unknown = true
        continue
      }
      const vk = v ? v.i * 100 + seg.get(nt.i)! : -1
      if (v) verbUse.set(vk, (verbUse.get(vk) ?? 0) + 1)
      if (v && nVerbs > 1 && verbUse.get(vk)! > 1) unsafe ||= `dwie liczby przy jednym czasowniku „${v.form}”, choć w zdaniu są dwa czasowniki – rozbiór niepewny`
      if (op === '-' && !ledger.has(o)) unsafe ||= `${o === SCENE ? 'ktoś' : o} oddaje ${val}, choć nie wiem, ile miał – rozbiór niepewny`
      used++
      const before = ledger.get(o) ?? 0
      const after = op === '=' ? val : op === '+' ? before + val : before - val
      ledger.set(o, after)
      ctx.trace.push({ kind: 'reguła', text: `${o === SCENE ? '' : `${o}: `}${why}: ${op === '=' ? val : `${before} ${op === '+' ? '+' : '−'} ${val} = ${after}`}` })
      if (o !== SCENE) lastOwner = o
    }
  }
  if (unknown && !together) return null
  if (!unknown && used < given) unsafe ||= `w treści jest ${given} liczb, użyłem ${used} – któraś liczba nie pasuje do żadnej reguły`
  if (!unsafe && [...ledger.values()].some((x) => x < 0)) unsafe = 'wyszła ujemna liczba rzeczy – rozbiór niepewny'
  if (unsafe) {
    ctx.trace.push({ kind: 'brak', text: `bezpiecznik: ${unsafe}` })
    return null
  }
  let ans: number | undefined
  if (unknown && together) {
    ans = sumAll
    ctx.trace.push({ kind: 'wniosek', text: `„razem” → suma wszystkich liczb „${what}”: ${fmtN(sumAll)}` })
  } else if (owner && ledger.has(owner)) ans = ledger.get(owner)
  else if (ledger.size === 1) ans = [...ledger.values()][0]
  else if (together && nAll) ans = [...ledger.values()].reduce((a, b) => a + b, 0)
  if (ans !== undefined && !Number.isFinite(ans)) {
    ctx.trace.push({ kind: 'brak', text: 'wynik nie jest liczbą – nie zgaduję' })
    return null
  }
  if (ans === undefined) {
    ctx.trace.push({ kind: 'brak', text: owner ? `nie ma w treści liczby „${what}” dla ${owner}` : 'kilka osób w treści – nie wiem, o kogo chodzi' })
    return null
  }
  ctx.trace.push({ kind: 'wniosek', text: `odpowiedź: ${fmtN(ans)}` })
  return { answer: fmtN(ans), method: 'zadanie tekstowe' }
}

/** Kolejność: zadania szkolne (czystaSzkolne.ts) → analogia → liczebniki → ciąg → zadanie tekstowe → arytmetyka. */
export function numeric(text: string, ctx: NumCtx): NumResult | null {
  for (const f of [school, analogy, numerals, sequence, wordProblem, arithmetic]) {
    const mark = ctx.trace.length
    try {
      const r = f(text, ctx)
      if (r) return r
    } catch {
      ctx.trace.splice(mark)
    }
  }
  return null
}
