// Czysta grzybnia – jednostki (klasy 1–7): długość, masa, pieniądze, czas, miesiące/lata, pole, objętość.
// Zamiana „3 zł 15 gr = … gr”, „1 cm 2 mm = … cm”, „30,01 zł = … zł … gr”, „ile to lat: 48 miesięcy”,
// „2 kilogramy 54 dekagramy to”, suma wielkości („ile ważyły razem…”) i różnica („o ile cm dłuższa…”).
// Przeliczniki to definicje jednostek (SI i polskie jednostki szkolne), nie wiedza z sieci; każdy krok w śladzie.
import type { NumCtx, NumResult } from './czystaLiczby'
import { Q } from './czystaQ'

type Dim = 'długość' | 'masa' | 'pieniądze' | 'czas' | 'miesiące' | 'pole' | 'objętość'
interface Unit {
  sym: string
  dim: Dim
  /** ile jednostek bazowych wymiaru */
  f: Q
}
const q = (s: string) => Q.parse(s)!
const U: [RegExp, Unit][] = [
  // długość (baza mm)
  [/^(mm|milimetr\p{L}*)$/u, { sym: 'mm', dim: 'długość', f: q('1') }],
  [/^(cm|centymetr\p{L}*)$/u, { sym: 'cm', dim: 'długość', f: q('10') }],
  [/^(dm|decymetr\p{L}*)$/u, { sym: 'dm', dim: 'długość', f: q('100') }],
  [/^(km|kilometr\p{L}*)$/u, { sym: 'km', dim: 'długość', f: q('1000000') }],
  [/^(m|metr|metra|metry|metrów|metrze|metrem|metrami|metrach)$/u, { sym: 'm', dim: 'długość', f: q('1000') }],
  // masa (baza mg)
  [/^(mg|miligram\p{L}*)$/u, { sym: 'mg', dim: 'masa', f: q('1') }],
  [/^(dag|dkg|dekagram\p{L}*|deko)$/u, { sym: 'dag', dim: 'masa', f: q('10000') }],
  [/^(kg|kilogram\p{L}*|kilo)$/u, { sym: 'kg', dim: 'masa', f: q('1000000') }],
  [/^(g|gram|grama|gramy|gramów|gramach|gramami)$/u, { sym: 'g', dim: 'masa', f: q('1000') }],
  [/^(t|ton|tona|tony|tonę|tonie|tonach|tonami)$/u, { sym: 't', dim: 'masa', f: q('1000000000') }],
  // pieniądze (baza gr)
  [/^(gr|grosz\p{L}*)$/u, { sym: 'gr', dim: 'pieniądze', f: q('1') }],
  [/^(zł|złot\p{L}*)$/u, { sym: 'zł', dim: 'pieniądze', f: q('100') }],
  // czas (baza s)
  [/^(s|sek|sekund\p{L}*)$/u, { sym: 's', dim: 'czas', f: q('1') }],
  [/^(min|minut\p{L}*)$/u, { sym: 'min', dim: 'czas', f: q('60') }],
  [/^(h|godz|godzin\p{L}*|godzina)$/u, { sym: 'h', dim: 'czas', f: q('3600') }],
  [/^(dob\p{L}*|dzień|dni|dnia)$/u, { sym: 'doba', dim: 'czas', f: q('86400') }],
  [/^(tydzień|tygodni\p{L}*|tygodnie)$/u, { sym: 'tydzień', dim: 'czas', f: q('604800') }],
  // miesiące i lata (baza: miesiąc)
  [/^(miesiąc\p{L}*|miesięc\p{L}*|miesiące|mies)$/u, { sym: 'miesiąc', dim: 'miesiące', f: q('1') }],
  [/^(kwartał\p{L}*)$/u, { sym: 'kwartał', dim: 'miesiące', f: q('3') }],
  [/^(rok|roku|lat|lata|latach|lata|rokiem|roki)$/u, { sym: 'rok', dim: 'miesiące', f: q('12') }],
  // pole (baza cm²)
  [/^(mm²|mm2)$/u, { sym: 'mm²', dim: 'pole', f: q('0.01') }],
  [/^(cm²|cm2)$/u, { sym: 'cm²', dim: 'pole', f: q('1') }],
  [/^(dm²|dm2)$/u, { sym: 'dm²', dim: 'pole', f: q('100') }],
  [/^(m²|m2)$/u, { sym: 'm²', dim: 'pole', f: q('10000') }],
  [/^(a|ar|ary|arów|arach)$/u, { sym: 'a', dim: 'pole', f: q('1000000') }],
  [/^(ha|hektar\p{L}*)$/u, { sym: 'ha', dim: 'pole', f: q('100000000') }],
  [/^(km²|km2)$/u, { sym: 'km²', dim: 'pole', f: q('10000000000') }],
  // objętość (baza ml = cm³)
  [/^(ml|mililitr\p{L}*|cm³|cm3)$/u, { sym: 'ml', dim: 'objętość', f: q('1') }],
  [/^(l|litr\p{L}*|dm³|dm3)$/u, { sym: 'l', dim: 'objętość', f: q('1000') }],
  [/^(hl|hektolitr\p{L}*)$/u, { sym: 'hl', dim: 'objętość', f: q('100000') }],
  [/^(m³|m3)$/u, { sym: 'm³', dim: 'objętość', f: q('1000000') }],
]
export function unitOf(w: string): Unit | null {
  const x = w.toLowerCase().replace(/\.$/, '')
  for (const [re, u] of U) if (re.test(x)) return u
  return null
}
const fmt = (v: Q) => v.pl()

/** Wielkość: liczba + jednostka, także złożona „3 zł 15 gr”, „2 h i 40 min”. */
export interface Qty {
  v: Q // w jednostkach bazowych
  dim: Dim
  text: string
  units: Unit[]
  at: number
}
const NUMU = /(\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?(?!\d)|\d+(?:[.,]\d+)?)\s*([\p{L}]+[²³23]?)/gu
export function quantities(text: string): Qty[] {
  const out: Qty[] = []
  for (const m of text.matchAll(NUMU)) {
    const u = unitOf(m[2])
    if (!u) continue
    const v = Q.parse(m[1])!.mul(u.f)
    const prev = out[out.length - 1]
    const gap = prev ? text.slice(prev.at + prev.text.length, m.index) : ''
    // „3 zł 15 gr”, „2 h i 40 min”: ta sama wielkość, mniejsza jednostka, tuż obok
    if (prev && prev.dim === u.dim && /^\s*(i\s+)?$/.test(gap) && prev.units[prev.units.length - 1].f.cmp(u.f) > 0) {
      prev.v = prev.v.add(v)
      prev.text = text.slice(prev.at, m.index! + m[0].length)
      prev.units.push(u)
      continue
    }
    out.push({ v, dim: u.dim, text: m[0], units: [u], at: m.index! })
  }
  return out
}

/** nazwy jednostek-słów odmienione przy liczbie (1 rok, 2–4 lata, 5 lat; ułamek – „roku”) */
const WORDS: Record<string, [string, string, string, string]> = {
  rok: ['rok', 'lata', 'lat', 'roku'],
  miesiąc: ['miesiąc', 'miesiące', 'miesięcy', 'miesiąca'],
  kwartał: ['kwartał', 'kwartały', 'kwartałów', 'kwartału'],
  doba: ['doba', 'doby', 'dób', 'doby'],
  tydzień: ['tydzień', 'tygodnie', 'tygodni', 'tygodnia'],
}
export function withUnit(v: Q, u: Unit): string {
  const w = WORDS[u.sym]
  if (!w) return `${v.pl()} ${u.sym}`
  if (!v.isInt()) return `${v.pl()} ${w[3]}`
  const n = v.n < 0n ? -v.n : v.n
  const f = n === 1n ? w[0] : n % 10n >= 2n && n % 10n <= 4n && !(n % 100n >= 12n && n % 100n <= 14n) ? w[1] : w[2]
  return `${v.pl()} ${f}`
}
/** najmniejsza z jednostek zadania – w niej pokazuję rachunek */
const smallest = (us: Unit[]) => us.reduce((a, b) => (b.f.cmp(a.f) < 0 ? b : a))

/** wartość w jednej jednostce; „zł … gr” – część całkowita w większej, reszta w mniejszej */
function express(x: Qty, targets: Unit[], ctx: NumCtx): string | null {
  if (targets.some((t) => t.dim !== x.dim)) {
    ctx.trace.push({ kind: 'brak', text: `jednostki różnych wielkości (${x.dim} i ${targets.map((t) => t.dim).join(', ')})` })
    return null
  }
  const s = smallest([...x.units, ...targets])
  const inS = x.v.div(s.f)
  if (targets.length === 1) {
    const t = targets[0]
    const r = x.v.div(t.f)
    const k = t.f.div(s.f)
    ctx.trace.push({ kind: 'reguła', text: t === s || t.sym === s.sym ? `${x.text} = ${withUnit(inS, s)}` : `${x.text} = ${withUnit(inS, s)}; 1 ${t.sym} = ${withUnit(k, s)} → ${inS.pl()} : ${k.pl()} = ${withUnit(r, t)}` })
    return withUnit(r, t)
  }
  const parts: string[] = []
  let rest = x.v
  targets.forEach((t, i) => {
    const d = rest.div(t.f)
    const whole = i === targets.length - 1 ? d : new Q(d.n / d.d)
    rest = rest.sub(whole.mul(t.f))
    parts.push(withUnit(whole, t))
  })
  ctx.trace.push({ kind: 'reguła', text: `${x.text} = ${withUnit(inS, s)} → ${parts.join(' ')} (całe ${targets[0].sym}, reszta w ${targets[targets.length - 1].sym})` })
  return parts.join(' ')
}

export function units(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ').trim()
  // 1) „X = … U” albo „X = … U1 … U2”
  let m = /([^.:=]*?)\s*=\s*((?:(?:…|\.{2,}|_+)\s*[\p{L}²³]+\s*){1,3})\.?$/u.exec(t)
  if (m) {
    const xs = quantities(m[1])
    const targets = [...m[2].matchAll(/(?:…|\.{2,}|_+)\s*([\p{L}²³]+)/gu)].map((x) => unitOf(x[1]))
    if (xs.length === 1 && targets.length && targets.every(Boolean)) {
      ctx.trace.push({ kind: 'rozbiór', text: `zamiana: ${xs[0].text} → ${targets.map((u) => u!.sym).join(' ')}` })
      const r = express(xs[0], targets as Unit[], ctx)
      if (r) return { answer: r, method: 'szkoła: jednostki' }
    }
  }
  // 2) „ile to lat: 48 miesięcy”, „Ile to gramów 2 kg?”, „Zamień 3 m na cm”, „Wyraź 2 h w minutach”
  m = /ile (?:to|jest|wynosi|ma) ([\p{L}²³]+)\s*:?\s*(.+?)\??$/iu.exec(t) ?? /(?:zamień|wyraź|zapisz)\s+(.+?)\s+(?:na|w)\s+([\p{L}²³]+)\.?$/iu.exec(t)
  if (m) {
    const swap = /zamień|wyraź|zapisz/i.test(m[0].split(/\s/)[0])
    const [uw, rest] = swap ? [m[2], m[1]] : [m[1], m[2]]
    const u = unitOf(uw)
    const xs = quantities(rest)
    if (u && xs.length === 1) {
      ctx.trace.push({ kind: 'rozbiór', text: `zamiana: ${xs[0].text} → ${u.sym}` })
      const r = express(xs[0], [u], ctx)
      if (r) return { answer: r, method: 'szkoła: jednostki' }
    }
  }
  // 3) „2 kilogramy 54 dekagramy to” – wielkość złożona bez wskazanej jednostki: w największej i najmniejszej
  m = /^(.+?)\s+to\s*(…|\.{2,}|_+)?\.?$/u.exec(t)
  if (m) {
    const xs = quantities(m[1])
    if (xs.length === 1 && xs[0].units.length >= 2 && xs[0].text.length >= m[1].replace(/\s+$/, '').length - 1) {
      const big = xs[0].units[0]
      const small = xs[0].units[xs[0].units.length - 1]
      ctx.trace.push({ kind: 'rozbiór', text: `wielkość złożona: ${xs[0].text}` })
      const a = express(xs[0], [big], ctx)
      const b = express(xs[0], [small], ctx)
      if (a && b) return { answer: `${a} = ${b}`, method: 'szkoła: jednostki' }
    }
  }
  // 4) suma: „Ile ważyły razem …?” – wszystkie wielkości tego samego rodzaju
  const sents = t.split(/(?<=[.!?])\s+/)
  const qs = sents[sents.length - 1]
  if (/\?$/.test(qs) && /^ile(?![\p{L}\d])/iu.test(qs) && /(?<![\p{L}\d])(razem|łącznie|w sumie|wszystk\p{L}*)(?![\p{L}\d])/iu.test(qs)) {
    const xs = quantities(sents.slice(0, -1).join(' '))
    const qx = quantities(qs)
    if (xs.length >= 2 && !qx.length && xs.every((x) => x.dim === xs[0].dim) && !/(?<![\p{L}\d])(po|każd\p{L}*|razy)(?![\p{L}\d])/iu.test(t)) {
      const sum = xs.reduce((a, x) => a.add(x.v), new Q(0n))
      // jednostka odpowiedzi: najczęstsza w treści
      const cnt = new Map<string, [Unit, number]>()
      for (const x of xs) for (const u of x.units.slice(0, 1)) cnt.set(u.sym, [u, (cnt.get(u.sym)?.[1] ?? 0) + 1])
      const u = [...cnt.values()].sort((a, b) => b[1] - a[1])[0][0]
      const r = sum.div(u.f)
      ctx.trace.push({ kind: 'rozbiór', text: `wielkości (${xs[0].dim}): ${xs.map((x) => x.text).join(', ')}` })
      ctx.trace.push({ kind: 'reguła', text: `„razem” → suma: ${xs.map((x) => fmt(x.v.div(u.f))).join(' + ')} = ${withUnit(r, u)}` })
      return { answer: withUnit(r, u), method: 'szkoła: jednostki' }
    }
  }
  // 5) różnica: „O ile cm kredka Jurka jest dłuższa?”, „Oblicz, o ile więcej kosztuje sól.”
  const qd = sents.findLast((s) => /(?<![\p{L}\d])o ile(?![\p{L}\d])/iu.test(s))
  if (qd && /(dłuższ|krótsz|wyższ|niższ|więcej|mniej|droższ|tańsz|cięższ|lżejsz|starsz|młodsz|dalej|bliżej|szybciej|wolniej)/iu.test(qd)) {
    const xs = quantities(sents.filter((s) => s !== qd).join(' '))
    if (xs.length === 2 && xs[0].dim === xs[1].dim && !quantities(qd).length && !/(?<![\p{L}\d])(po|każd\p{L}*|razy|razem)(?![\p{L}\d])/iu.test(t)) {
      const [a, b] = xs[0].v.cmp(xs[1].v) >= 0 ? [xs[0], xs[1]] : [xs[1], xs[0]]
      const u = xs[0].units[0]
      const r = a.v.sub(b.v).div(u.f)
      ctx.trace.push({ kind: 'reguła', text: `„o ile” = różnica dwóch wielkości: ${a.text} − ${b.text} = ${withUnit(r, u)}` })
      return { answer: withUnit(r, u), method: 'szkoła: jednostki' }
    }
  }
  return null
}
