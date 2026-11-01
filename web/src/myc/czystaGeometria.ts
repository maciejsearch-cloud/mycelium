// Czysta grzybnia – geometria szkolna (klasy 3–7): obwód i pole kwadratu, prostokąta, trójkąta, rombu,
// równoległoboku, trapezu; brakujący bok z obwodu; boki „2 razy dłuższy”, „o 4 cm krótszy”; przekątne;
// suma krawędzi, pole powierzchni i objętość sześcianu i prostopadłościanu; zamiana jednostek pola (a, ha).
// Wzory to definicje z podstawy programowej, nie wiedza z sieci. Brak danej albo niejasna rola liczby → „nie wiem”.
import type { NumCtx, NumResult } from './czystaLiczby'
import { wordsToDigits } from './czystaLiczby'
import { Q } from './czystaQ'
import { quantities, unitOf, withUnit, type Qty } from './czystaJednostki'

type Fig = 'kwadrat' | 'prostokąt' | 'trójkąt' | 'romb' | 'równoległobok' | 'trapez' | 'sześcian' | 'prostopadłościan'
const FIGS: [RegExp, Fig][] = [
  [/kwadrat/iu, 'kwadrat'],
  [/prostokąt(?!n)|działk/iu, 'prostokąt'],
  [/trójkąt/iu, 'trójkąt'],
  [/romb/iu, 'romb'],
  [/równoległobok/iu, 'równoległobok'],
  [/trapez/iu, 'trapez'],
  [/sześcian/iu, 'sześcian'],
  [/prostopadłościan/iu, 'prostopadłościan'],
]
type Role = 'bok' | 'obwód' | 'przekątna' | 'wysokość' | 'krawędź' | 'podstawa' | 'pole'
const ORD: [RegExp, number][] = [[/pierwsz/iu, 1], [/drug/iu, 2], [/trzec/iu, 3], [/czwart/iu, 4]]
const ordIn = (s: string) => ORD.find(([re]) => re.test(s))?.[1] ?? 0
interface Val {
  role: Role
  v: Q // w jednostkach bazowych wymiaru (mm dla długości)
  text: string
}
const UP = /(dłuższ|wyższ|większ)/iu
const N = '(\\d+(?:[.,]\\d+)?)'

function roleOf(c: string): Role {
  if (/obw[oó]d/iu.test(c)) return 'obwód'
  if (/przekątn/iu.test(c)) return 'przekątna'
  if (/wysokoś/iu.test(c)) return 'wysokość'
  if (/krawęd/iu.test(c)) return 'krawędź'
  if (/podstaw/iu.test(c)) return 'podstawa'
  if (/(?<!\p{L})pole(?!\p{L})|pola(?!\p{L})|powierzchni/iu.test(c) && !/oblicz/iu.test(c)) return 'pole'
  return 'bok'
}

export function geometry(text: string, ctx: NumCtx): NumResult | null {
  const t = wordsToDigits(text.replace(/\s+/g, ' '), ctx.lex).trim()
  const fig = FIGS.find(([re]) => re.test(t))?.[1]
  if (!fig) return null
  const sents = t.split(/(?<=[.!?])\s+/u)
  // pytanie: zdanie z „oblicz / ile / jaką / wynosi …” – ostatnie takie
  const qi = sents.findLastIndex((s) => /(oblicz|ile\s|jak\p{L}*\s|wynosi\s*…|podaj)/iu.test(s))
  if (qi < 0) return null
  const q = sents[qi]
  const ask = /sum\p{L}* długości wszystkich krawędzi/iu.test(q) ? 'krawędzie' : /objętoś/iu.test(q) ? 'objętość' : /pole powierzchni/iu.test(q) ? 'pole powierzchni' : /(?<!\p{L})pol(e|a)(?!\p{L})|powierzchni/iu.test(q) ? 'pole' : /obw[oó]d/iu.test(q) ? 'obwód' : /(długoś\p{L}* (drugiego |trzeciego )?boku|długości boków|bok\p{L}* (ma|mają) długość)/iu.test(q) ? 'bok' : null
  if (!ask) return null
  // dane: zdania przed pytaniem + część pytania po „o / którego / w którym” (np. „pole kwadratu o boku 5 cm”)
  const qData = q.replace(/^.*?(?=(?:o|którego|której|w którym|w której|jeżeli|jeśli)\s)/iu, '')
  const data = [...sents.slice(0, qi), ...sents.slice(qi + 1), qData === q && !/o\s+\d/.test(q) ? '' : qData].join(' ')
  // przecinek / kropka między cyframi to część ułamka dziesiętnego („12,5 cm”), nie granica zdania
  const clauses = data.split(/(?<!\d),\s*(?:a\s+)?|,(?!\d)\s*(?:a\s+)?|\.(?!\d)\s*|;\s*|\s+a\s+(?=\p{L})/u).filter((c) => /\d/.test(c))
  const vals: Val[] = []
  const lengthUnit = quantities(data).find((x) => x.dim === 'długość')?.units[0]
  const areaQ: Qty[] = []
  for (const c of clauses) {
    const qs = quantities(c)
    const role = roleOf(c)
    const rel = new RegExp(`${N}\\s*razy\\s+(dłuższ|krótsz|wyższ|niższ|większ|mniejsz)|o\\s+${N}\\s*([\\p{L}]+)\\s+(dłuższ|krótsz|wyższ|niższ|większ|mniejsz)`, 'iu').exec(c)
    if (rel) {
      // odniesienie: „od pierwszego”, „od drugiego”, „od niego/niej” = poprzednia wielkość tej samej roli
      const refO = ordIn(c.slice(rel.index + rel[0].length))
      const same = vals.filter((v) => v.role === role || (role === 'bok' && v.role === 'bok'))
      const ref = refO ? same[refO - 1] : same[same.length - 1] ?? vals[vals.length - 1]
      if (!ref) return null
      const up = UP.test(rel[2] ?? rel[5])
      let v: Q
      if (rel[1]) v = up ? ref.v.mul(Q.parse(rel[1])!) : ref.v.div(Q.parse(rel[1])!)
      else {
        const u = unitOf(rel[4])
        if (!u || u.dim !== 'długość') return null
        const d = Q.parse(rel[3])!.mul(u.f)
        v = up ? ref.v.add(d) : ref.v.sub(d)
      }
      vals.push({ role: ref.role, v, text: c.trim() })
      ctx.trace.push({ kind: 'reguła', text: `„${c.trim()}” → ${withUnit(v.div(lengthUnit!.f), lengthUnit!)}` })
      continue
    }
    if (!qs.length) {
      ctx.trace.push({ kind: 'fakt', text: `„${c.trim()}” – liczba bez jednostki długości, pomijam` })
      continue
    }
    for (const x of qs) {
      if (x.dim === 'pole') {
        areaQ.push(x)
        continue
      }
      if (x.dim !== 'długość') return null
      vals.push({ role, v: x.v, text: x.text })
      ctx.trace.push({ kind: 'fakt', text: `${role}: ${x.text}` })
    }
  }
  if (!lengthUnit && !areaQ.length) return null
  const lu = lengthUnit ?? unitOf('m')!
  const get = (r: Role) => vals.filter((v) => v.role === r).map((v) => v.v)
  const sides = get('bok')
  const [P] = get('obwód')
  const diags = get('przekątna')
  const [h] = get('wysokość')
  const edge = get('krawędź')
  const base2 = get('podstawa')
  const L = (v: Q) => withUnit(v.div(lu.f), lu)
  const A = (v: Q) => {
    // pole w mm² → w jednostce² długości (albo prośba „w hektarach / arach / m²”)
    const want = /w hektarach|w ha(?!\p{L})/iu.test(q) ? unitOf('ha') : /w arach/iu.test(q) ? unitOf('a') : /w (m²|m2|metrach kwadratowych)/iu.test(q) ? unitOf('m²') : null
    const sq = unitOf(`${lu.sym}²`)!
    const u = want ?? sq
    return withUnit(v.div(new Q(100n)).div(u.f), u) // mm² → cm² (baza pola) → u
  }
  const two = new Q(2n)
  const four = new Q(4n)
  const done = (s: string, why: string): NumResult => {
    ctx.trace.push({ kind: 'wniosek', text: `${fig}, ${ask}: ${why} = ${s}` })
    return { answer: s, method: 'szkoła: geometria' }
  }
  const area = (a: Q, b: Q) => a.mul(b)
  // kilka figur: pole dane + prostokąt o wymiarach a i b, „razem”
  if (ask === 'pole' && areaQ.length && sides.length === 2 && /razem|łącznie|obie|oba/iu.test(t)) {
    const tot = areaQ.reduce((s, x) => s.add(x.v.mul(new Q(100n))), area(sides[0], sides[1]))
    return done(A(tot), `${areaQ.map((x) => x.text).join(' + ')} + ${L(sides[0])} · ${L(sides[1])}`)
  }
  if (areaQ.length) return null
  switch (fig) {
    case 'kwadrat': {
      const a = sides[0] ?? (P ? P.div(four) : undefined)
      if (sides.length > 1) return null
      if (ask === 'pole' && !a && diags.length === 1) return done(A(diags[0].mul(diags[0]).div(two)), `d · d : 2 = ${L(diags[0])} · ${L(diags[0])} : 2`)
      if (!a) return null
      if (P && !sides.length) ctx.trace.push({ kind: 'reguła', text: `bok = obwód : 4 = ${L(P)} : 4 = ${L(a)}` })
      if (ask === 'pole') return done(A(a.mul(a)), `a · a = ${L(a)} · ${L(a)}`)
      if (ask === 'obwód') return done(L(a.mul(four)), `4 · a = 4 · ${L(a)}`)
      if (ask === 'bok') return done(L(a), 'obwód : 4')
      return null
    }
    case 'prostokąt': {
      let [a, b] = sides
      if (sides.length > 2) return null
      if (a && !b && P) {
        b = P.div(two).sub(a)
        ctx.trace.push({ kind: 'reguła', text: `drugi bok = obwód : 2 − bok = ${L(P)} : 2 − ${L(a)} = ${L(b)}` })
        if (ask === 'bok') return done(L(b), `${L(P)} : 2 − ${L(a)}`)
      }
      if (!a || !b) return null
      if (ask === 'pole') return done(A(a.mul(b)), `a · b = ${L(a)} · ${L(b)}`)
      if (ask === 'obwód') return done(L(a.add(b).mul(two)), `2 · (a + b) = 2 · (${L(a)} + ${L(b)})`)
      return null
    }
    case 'trójkąt': {
      if (ask === 'obwód' && sides.length === 3) return done(L(sides.reduce((s, x) => s.add(x))), sides.map(L).join(' + '))
      if (ask === 'pole' && h && (sides.length === 1 || base2.length === 1)) {
        const a = base2[0] ?? sides[0]
        return done(A(a.mul(h).div(two)), `a · h : 2 = ${L(a)} · ${L(h)} : 2`)
      }
      if (ask === 'bok' && P) {
        if (/równoboczn/iu.test(t) && !sides.length && !base2.length) return done(L(P.div(new Q(3n))), `obwód : 3 = ${L(P)} : 3 (wszystkie boki równe)`)
        const p = base2[0] ?? (/równoramienn/iu.test(t) && /podstaw/iu.test(t) ? sides[0] : undefined)
        if (/równoramienn/iu.test(t) && p) {
          const r = P.sub(p).div(two)
          return done(`${L(r)}, ${L(r)}, ${L(p)}`, `ramię = (obwód − podstawa) : 2 = (${L(P)} − ${L(p)}) : 2 = ${L(r)}`)
        }
      }
      return null
    }
    case 'romb': {
      if (ask === 'pole' && diags.length === 2) return done(A(diags[0].mul(diags[1]).div(two)), `e · f : 2 = ${L(diags[0])} · ${L(diags[1])} : 2`)
      if (ask === 'pole' && sides.length === 1 && h) return done(A(sides[0].mul(h)), `a · h = ${L(sides[0])} · ${L(h)}`)
      if (ask === 'obwód' && sides.length === 1) return done(L(sides[0].mul(four)), `4 · a = 4 · ${L(sides[0])}`)
      return null
    }
    case 'równoległobok': {
      if (ask === 'pole' && h && sides.length === 1) return done(A(sides[0].mul(h)), `a · h = ${L(sides[0])} · ${L(h)}`)
      if (ask === 'obwód' && sides.length === 2) return done(L(sides[0].add(sides[1]).mul(two)), `2 · (a + b)`)
      return null
    }
    case 'trapez': {
      const bs = base2.length === 2 ? base2 : sides.length === 2 && /podstaw/iu.test(t) ? sides : []
      if (ask === 'pole' && h && bs.length === 2) return done(A(bs[0].add(bs[1]).mul(h).div(two)), `(a + b) · h : 2 = (${L(bs[0])} + ${L(bs[1])}) · ${L(h)} : 2`)
      return null
    }
    case 'sześcian': {
      const a = edge[0] ?? sides[0]
      if (!a || edge.length + sides.length !== 1) return null
      if (ask === 'krawędzie') return done(L(a.mul(new Q(12n))), `12 · a = 12 · ${L(a)}`)
      if (ask === 'pole powierzchni') return done(A(a.mul(a).mul(new Q(6n))), `6 · a · a = 6 · ${L(a)} · ${L(a)}`)
      if (ask === 'objętość') {
        const u = lu
        const v = a.div(u.f).mul(a.div(u.f)).mul(a.div(u.f))
        return done(`${v.pl()} ${u.sym}³`, `a · a · a = ${L(a)}³`)
      }
      return null
    }
    case 'prostopadłościan': {
      const e = [...edge, ...sides]
      if (e.length !== 3) return null
      if (ask === 'krawędzie') return done(L(e[0].add(e[1]).add(e[2]).mul(four)), `4 · (a + b + c)`)
      if (ask === 'objętość') {
        const v = e.reduce((s, x) => s.mul(x.div(lu.f)), new Q(1n))
        return done(`${v.pl()} ${lu.sym}³`, `a · b · c = ${e.map(L).join(' · ')}`)
      }
      if (ask === 'pole powierzchni') return done(A(e[0].mul(e[1]).add(e[1].mul(e[2])).add(e[0].mul(e[2])).mul(two)), '2 · (ab + bc + ac)')
      return null
    }
  }
  return null
}
