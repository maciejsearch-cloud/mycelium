// Czysta grzybnia – zadania tekstowe ze szkoły (klasy 1–7): zakupy „po P zł za sztukę”, „każdy o masie…”,
// stawka × czas („miesięcznie 15 zł … przez pół roku”), podział („ilu uczniów, jeśli…”), łańcuch wielkości
// („2 razy więcej”, „o 18 więcej niż pierwszego dnia”, „o 23 lata starszy”), obniżki/podwyżki o p%, „stanowi p%”,
// prędkość z godzin, „pewną liczbę zwiększymy 5 razy…” (działania odwrotne). Bez modelu językowego; gdy nie wszystkie
// liczby z treści znajdą rolę albo pasuje kilka odczytań – „nie wiem”.
import type { NumCtx, NumResult } from './czystaLiczby'
import { wordsToDigits } from './czystaLiczby'
import { lexAnalyses } from './morf'
import { Q } from './czystaQ'
import { quantities, unitOf, withUnit, type Qty } from './czystaJednostki'

const N = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:,\\d+)?(?!\\d)|\\d+(?:[.,]\\d+)?)'
const P = (s: string) => Q.parse(s)!
const H = new Q(100n)
const low = (s: string) => s.toLowerCase()
const stem = (w: string) => low(w).replace(/[^\p{L}]/gu, '').slice(0, 5)
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+(?=\p{Lu}|\d)/u).filter(Boolean)
const money = (v: Q) => (v.isInt() ? v.pl() : v.round(2).cmp(v) === 0 && !v.mul(new Q(10n)).isInt() ? v.pl() : v.round(2).pl().replace(/,(\d)$/, ',$10'))
const zl = (gr: Q) => `${money(gr.div(H))} zł`

/** „Podaj wynik zaokrąglony do części setnych” */
function rounding(t: string): number | null {
  const m = /zaokrągl\p{L}* do (?:części )?(dziesiątych|setnych|tysięcznych|jedności|całości)/iu.exec(t)
  return m ? ({ dziesiątych: 1, setnych: 2, tysięcznych: 3, jedności: 0, całości: 0 } as Record<string, number>)[low(m[1])] : null
}

/** to samo słowo: wspólny lemat ze słownika Morfeusza albo wspólny temat 5 liter */
function sameWord(a: string, b: string, ctx: NumCtx): boolean {
  if (stem(a) === stem(b)) return true
  if (!ctx.lex) return false
  const L = (w: string) => new Set(lexAnalyses(ctx.lex!, low(w)).filter(([, t]) => /^(subst|depr)/.test(t)).map(([l]) => low(l.split(':')[0])))
  const x = L(a)
  return [...L(b)].some((l) => x.has(l))
}

// ------------------------------------------------------------------ zakupy
interface Buy {
  noun?: string
  n: Q
  price: Qty // cena jednostkowa (pieniądze, w gr)
  text: string
}
function purchases(t: string): { buys: Buy[]; fixed: Qty[] } {
  const buys: Buy[] = []
  const fixed: Qty[] = []
  const used = new Set<number>()
  // „30 lizaków w cenie 35 gr za sztukę”, „2 długopisy po 2,85 zł”, „0,3 kg mandarynek po 4,89 zł za kilogram”
  const re = new RegExp(`${N}\\s*([\\p{L}]+)?(?:\\s+[\\p{L}]+){0,3}?\\s+(?:po|w cenie)\\s+${N}\\s*(zł|gr|złot\\p{L}*|grosz\\p{L}*)(?:\\s+za\\s+(?:sztukę|kilogram|kg|litr|metr|opakowanie|paczkę|jeden|jedną|jedno|\\p{L}+))?`, 'giu')
  for (const m of t.matchAll(re)) {
    const u = unitOf(m[4])!
    const n = P(m[1])
    buys.push({ n, price: { v: P(m[3]).mul(u.f), dim: 'pieniądze', text: `${m[3]} ${m[4]}`, units: [u], at: m.index! }, text: m[0] })
    for (let i = m.index!; i < m.index! + m[0].length; i++) used.add(i)
  }
  // „bombonierkę za 27 zł” – rzecz o stałej cenie (nie „zapłacił za zakupy 39 zł”)
  for (const m of t.matchAll(new RegExp(`(\\p{L}+)\\s+za\\s+${N}\\s*(zł|gr|złot\\p{L}*|grosz\\p{L}*)`, 'giu'))) {
    if (used.has(m.index!) || /^(zapłaci\p{L}*|zakupy|wszystko|całość|razem|kosztowa\p{L}*)$/iu.test(m[1])) continue
    if (/za\s+zakupy|zapłaci/i.test(t.slice(Math.max(0, m.index! - 20), m.index! + m[0].length))) continue
    const u = unitOf(m[3])!
    fixed.push({ v: P(m[2]).mul(u.f), dim: 'pieniądze', text: `${m[1]} za ${m[2]} ${m[3]}`, units: [u], at: m.index! })
  }
  // „kupił lizaki po 50 gr za sztukę” – liczba sztuk nieznana (n = 0 → do obliczenia)
  for (const m of t.matchAll(new RegExp(`(?<!\\p{L})(\\p{L}+)\\s+po\\s+${N}\\s*(zł|gr|złot\\p{L}*|grosz\\p{L}*)(?:\\s+za\\s+(?:sztukę|kilogram|kg|litr|opakowanie))?`, 'giu'))) {
    if (used.has(m.index!) || /^\d/.test(t.slice(Math.max(0, m.index! - 8), m.index!).trim().split(' ').pop() ?? '')) continue
    const u = unitOf(m[3])!
    buys.push({ n: new Q(0n), price: { v: P(m[2]).mul(u.f), dim: 'pieniądze', text: `${m[2]} ${m[3]}`, units: [u], at: m.index! }, text: m[0], noun: m[1] })
  }
  return { buys, fixed }
}
export function shopping(text: string, ctx: NumCtx): NumResult | null {
  const t = wordsToDigits(text.replace(/\s+/g, ' '), ctx.lex)
  const sents = sentencesOf(t)
  const q = sents.findLast((s) => /\?\s*$/.test(s) || /^oblicz/i.test(s)) ?? ''
  const { buys, fixed } = purchases(t)
  if (!buys.length) {
    // „zapłaciła 113,42 zł za 26,5 litra benzyny. … ile złotych kosztuje litr” – cena jednostkowa
    const m = new RegExp(`${N}\\s*(zł|gr|złot\\p{L}*)\\s+za\\s+${N}\\s*([\\p{L}]+)`, 'iu').exec(t)
    if (m && /kosztuje (?:jeden |1 )?(\p{L}+)/iu.test(q) && !quantities(q).length) {
      const per = unitOf(m[4])
      const ask = unitOf(/kosztuje (?:jeden |1 )?(\p{L}+)/iu.exec(q)![1])
      if (per && ask && per.dim === ask.dim) {
        const cost = P(m[1]).mul(unitOf(m[2])!.f)
        const amount = P(m[3]).mul(per.f).div(ask.f)
        let r = cost.div(amount)
        ctx.trace.push({ kind: 'reguła', text: `cena za 1 ${ask.sym} = ${m[1]} ${m[2]} : ${amount.pl()} = ${zl(r)}` })
        const k = rounding(t) ?? 2
        r = r.div(H).round(k).mul(H)
        if (k !== null) ctx.trace.push({ kind: 'wniosek', text: `zaokrąglenie do ${k === 2 ? 'groszy' : `${k} miejsc`} → ${zl(r)}` })
        return { answer: zl(r), method: 'szkoła: zadanie tekstowe' }
      }
    }
    return null
  }
  ctx.trace.push({ kind: 'rozbiór', text: `zakupy: ${buys.map((b) => b.text).join('; ')}${fixed.length ? `; stała cena: ${fixed.map((f) => f.text).join('; ')}` : ''}` })
  const total = buys.reduce((a, b) => a.add(b.n.mul(b.price.v)), new Q(0n)).add(fixed.reduce((a, f) => a.add(f.v), new Q(0n)))
  for (const b of buys) ctx.trace.push({ kind: 'reguła', text: `${b.n.pl()} · ${b.price.text} = ${zl(b.n.mul(b.price.v))}` })
  // ile sztuk, gdy dana jest kwota całości: „Za zakupy zapłacił 39 zł. Ile lizaków kupił?”
  const paid = new RegExp(`(?:zapłaci\\p{L}*|wyda\\p{L}*|kosztowa\\p{L}*)(?:\\s+\\p{L}+){0,3}?\\s+${N}\\s*(zł|gr|złot\\p{L}*)|za zakupy (?:zapłaci\\p{L}* )?${N}\\s*(zł|gr|złot\\p{L}*)`, 'iu').exec(t)
  const askN = /^(ile|ilu)\s+(\p{L}+)/iu.exec(q)
  if (askN && !/zapłaci|kosztowa|wyda|złotych|zł(?![\p{L}\d])/iu.test(q) && buys.length === 1 && buys[0].noun && sameWord(buys[0].noun, askN[2], ctx) && paid) {
    const v = P(paid[1] ?? paid[3]).mul(unitOf(paid[2] ?? paid[4])!.f)
    const rest = v.sub(fixed.reduce((a, f) => a.add(f.v), new Q(0n)))
    const n = rest.div(buys[0].price.v)
    ctx.trace.push({ kind: 'reguła', text: `${zl(v)}${fixed.length ? ` − ${fixed.map((f) => f.text.split(' za ')[1]).join(' − ')}` : ''} = ${zl(rest)}; ${zl(rest)} : ${buys[0].price.text} = ${n.pl()}` })
    if (!n.isInt() || n.n <= 0n) {
      ctx.trace.push({ kind: 'brak', text: 'liczba sztuk nie wychodzi całkowita – nie zgaduję' })
      return null
    }
    return { answer: n.pl(), method: 'szkoła: zadanie tekstowe' }
  }
  if (buys.some((b) => b.noun)) return null
  // bezpiecznik: pytanie nie o sumę zakupów („ile mu zostało”, „ile kosztował kilogram mieszanki”, „jedna sztuka”)
  if (/(zostało|zostanie|reszt\p{L}*|brakuje|kilogram\p{L}* |litr\p{L}* |(?<![\p{L}\d])(jeden|jedna|jedno|1)\s+\p{L}+|średni\p{L}*|mieszank\p{L}*)/iu.test(q)) {
    ctx.trace.push({ kind: 'brak', text: 'bezpiecznik: pytanie nie dotyczy kwoty za całe zakupy – nie podaję sumy' })
    return null
  }
  // bezpiecznik: każda liczba z treści musi należeć do jakiegoś zakupu („mając przy sobie 7,50 zł” – nie wiem, co z nią zrobić)
  const usedN = buys.reduce((a, b) => a + (b.n.n === 0n ? 1 : 2), 0) + fixed.length
  const allN = [...t.matchAll(new RegExp(N, 'gu'))].length
  if (allN > usedN) {
    ctx.trace.push({ kind: 'brak', text: `bezpiecznik: w treści jest ${allN} liczb, zakupy używają ${usedN} – któraś liczba nie ma roli` })
    return null
  }
  if (!/(ile|oblicz).*(zapłaci|kosztowa|wyda|złotych|zł(?![\p{L}\d])|pieniędzy|kwot)/iu.test(q) || quantities(q).some((x) => x.dim === 'pieniądze')) return null
  let r = total
  const k = rounding(t)
  if (k !== null) {
    r = r.div(H).round(k).mul(H)
    ctx.trace.push({ kind: 'wniosek', text: `zaokrąglenie do ${k === 2 ? 'części setnych (groszy)' : `${k} miejsc`}: ${zl(total)} → ${zl(r)}` })
  }
  ctx.trace.push({ kind: 'wniosek', text: `razem: ${zl(r)}` })
  const grOnly = buys.every((b) => b.price.units[0].sym === 'gr') && !fixed.length
  return { answer: grOnly && r.cmp(H) >= 0 ? `${r.pl()} gr = ${zl(r)}` : zl(r), method: 'szkoła: zadanie tekstowe' }
}

// ------------------------------------------------------------------ „N jednakowych X, każdy o masie m” / stawka × czas / podział
const RATE: [RegExp, string][] = [
  [/(?<![\p{L}\d])(miesięcznie|co miesiąc|na miesiąc|w miesiącu)(?![\p{L}\d])/iu, 'miesiąc'],
  [/(?<![\p{L}\d])(dziennie|codziennie|na dzień|każdego dnia)(?![\p{L}\d])/iu, 'doba'],
  [/(?<![\p{L}\d])(tygodniowo|co tydzień|na tydzień|w tygodniu)(?![\p{L}\d])/iu, 'tydzień'],
  [/(?<![\p{L}\d])(rocznie|co roku|na rok|w roku)(?![\p{L}\d])/iu, 'rok'],
  [/(?<![\p{L}\d])(na godzinę|w ciągu godziny|godzinowo)(?![\p{L}\d])/iu, 'h'],
]
export function perEach(text: string, ctx: NumCtx): NumResult | null {
  const t = wordsToDigits(text.replace(/\s+/g, ' '), ctx.lex)
  const sents = sentencesOf(t)
  const q = sents.findLast((s) => /\?\s*$/.test(s)) ?? ''
  const body = sents.filter((s) => s !== q).join(' ')
  // „sześć jednakowych jogurtów, każdy o masie 0,15 kg … Ile kilogramów ważyły wszystkie”
  let m = new RegExp(`${N}\\s+(?:jednakowych\\s+)?(\\p{L}+),?\\s+(?:każd\\p{L}*|każdy z nich)\\s+(?:o\\s+(?:masie|długości|cenie|pojemności|objętości)\\s+|waży\\s+|ma\\s+|kosztuje\\s+)?${N}\\s*(\\p{L}+)`, 'iu').exec(t)
  if (m && /^ile(?![\p{L}\d])/iu.test(q) && /(wszystk|razem|łącznie|w sumie)/iu.test(q)) {
    const u = unitOf(m[4])
    if (u) {
      const r = P(m[1]).mul(P(m[3]))
      ctx.trace.push({ kind: 'reguła', text: `${m[1]} × ${m[3]} ${u.sym} (każdy) = ${withUnit(r, u)}` })
      return { answer: withUnit(r, u), method: 'szkoła: zadanie tekstowe' }
    }
  }
  // stawka × czas: „wydaje miesięcznie 15 złotych … przez pół roku”
  for (const [re, per] of RATE) {
    if (!re.test(body)) continue
    const xs = quantities(body).filter((x) => x.dim !== 'czas' && x.dim !== 'miesiące')
    const qq = q.replace(/(?<![\p{L}\d])pół roku(?![\p{L}\d])/iu, '6 miesięcy').replace(/(?<![\p{L}\d])półtora roku(?![\p{L}\d])/iu, '18 miesięcy').replace(/(?<![\p{L}\d])przez rok(?![\p{L}\d])/iu, 'przez 1 rok').replace(/(?<![\p{L}\d])przez tydzień(?![\p{L}\d])/iu, 'przez 1 tydzień').replace(/(?<![\p{L}\d])przez miesiąc(?![\p{L}\d])/iu, 'przez 1 miesiąc')
    const dur = quantities(qq).filter((x) => x.dim === 'czas' || x.dim === 'miesiące')
    const perU = unitOf(per)!
    if (xs.length === 1 && dur.length === 1 && dur[0].dim === perU.dim) {
      const k = dur[0].v.div(perU.f)
      const r = xs[0].v.mul(k).div(xs[0].units[0].f)
      ctx.trace.push({ kind: 'reguła', text: `stawka ${xs[0].text} na ${per}; ${dur[0].text} = ${k.pl()} × ${per} → ${xs[0].v.div(xs[0].units[0].f).pl()} · ${k.pl()} = ${withUnit(r, xs[0].units[0])}` })
      return { answer: withUnit(r, xs[0].units[0]), method: 'szkoła: zadanie tekstowe' }
    }
  }
  // podział: „Każdy uczeń zjada 42 kg owoców … Ilu uczniów …, jeśli … 18 270 kg owoców?”
  m = /^(ilu|ile)\s+(\p{L}+)/iu.exec(q)
  if (m) {
    const each = new RegExp(`(?:każd\\p{L}*|jeden|jedna|jedno|na jednego|na jedną)\\s+(\\p{L}+)[^.?]*?${N}\\s*(\\p{L}+)`, 'iu').exec(t)
    if (each && sameWord(each[1], m[2], ctx)) {
      const u = unitOf(each[3])
      const all = quantities(t).filter((x) => u && x.dim === u.dim)
      if (u && all.length === 2) {
        const per = all.find((x) => x.text.startsWith(each[2])) ?? all[0]
        const tot = all.find((x) => x !== per)!
        if (tot.v.cmp(per.v) > 0) {
          const r = tot.v.div(per.v)
          ctx.trace.push({ kind: 'reguła', text: `na jednego „${each[1]}” ${per.text}; razem ${tot.text} → ${tot.text} : ${per.text} = ${r.pl()}` })
          if (!r.isInt()) {
            ctx.trace.push({ kind: 'brak', text: 'liczba osób/rzeczy nie wychodzi całkowita – nie zgaduję' })
            return null
          }
          return { answer: r.pl(), method: 'szkoła: zadanie tekstowe' }
        }
      }
    }
  }
  return null
}

// ------------------------------------------------------------------ łańcuch wielkości
const ORD: Record<string, number> = { pierwsz: 1, drugi: 2, drug: 2, trzeci: 3, czwart: 4, piąt: 5, szóst: 6, siódm: 7 }
const ordOf = (s: string) => {
  for (const [k, v] of Object.entries(ORD)) if (new RegExp(`(?<![\\p{L}\\d])${k}\\p{L}*`, 'iu').test(s)) return v
  return 0
}
const CMP_UP = /(więcej|starsz\p{L}*|dłuższ\p{L}*|wyższ\p{L}*|droższ\p{L}*|cięższ\p{L}*|szybsz\p{L}*|większ\p{L}*|później)/iu
const CMP_DOWN = /(mniej|młodsz\p{L}*|krótsz\p{L}*|niższ\p{L}*|tańsz\p{L}*|lżejsz\p{L}*|wolniejsz\p{L}*|mniejsz\p{L}*|wcześniej)/iu
const STOP = new Set(['jest', 'było', 'była', 'był', 'ma', 'mają', 'miał', 'miała', 'jego', 'jej', 'ich', 'niego', 'niej', 'nich', 'od', 'niż', 'razy', 'więcej', 'mniej', 'o', 'a', 'i', 'w', 'na', 'do', 'z', 'ze', 'się', 'tym', 'ten', 'ta', 'to', 'lat', 'lata', 'rok', 'dnia', 'dzień', 'jeszcze', 'też', 'także', 'ile', 'ilu', 'razem', 'wszystkich', 'łącznie'])
interface Ent {
  v: Q
  label: Set<string>
  ord: number
  text: string
}
export function chain(text: string, ctx: NumCtx): NumResult | null {
  const t = wordsToDigits(text.replace(/\s+/g, ' '), ctx.lex)
  const sents = sentencesOf(t)
  const q = sents.findLast((s) => /\?\s*$/.test(s)) ?? ''
  if (!/^(ile|ilu|o ile|o ilu)(?![\p{L}\d])/iu.test(q) || /\d/.test(q)) return null
  if (/(?<!\p{L})(po|każd\p{L}*|za|zapłaci\p{L}*|procent\p{L}*|%|odda\p{L}*|zjad\p{L}*|zjadł\p{L}*|zgubi\p{L}*|ubył\p{L}*|odjecha\p{L}*|odlecia\p{L}*|zabra\p{L}*|straci\p{L}*|zuży\p{L}*|pękł\p{L}*|uciekł\p{L}*)(?!\p{L})/iu.test(t)) return null
  const body = sents.filter((s) => s !== q).join(' ')
  const clauses = body.split(/[.;:]\s*|,\s*(?:a\s+)?|\s+a\s+|\s+oraz\s+|\s+i\s+(?=\d)/u).filter((c) => /\d/.test(c))
  const ents: Ent[] = []
  let kinds = 0
  let rel = 0
  for (const c of clauses) {
    const ns = [...c.matchAll(new RegExp(N, 'g'))]
    if (ns.length !== 1) return null
    const v = P(ns[0][1])
    const after = c.slice(ns[0].index! + ns[0][0].length)
    const words = c.split(/[^\p{L}]+/u).filter((w) => w && !STOP.has(low(w)))
    const label = new Set(words.map(stem))
    if (/^\s*(rodzaj\p{L}*|gatunk\p{L}*|typ\p{L}*|kolory|kolorów)(\s|$)/iu.test(after)) {
      kinds = Number(v.n)
      ctx.trace.push({ kind: 'fakt', text: `„${c.trim()}” – liczba rodzajów (${v.pl()}), nie ilość` })
      continue
    }
    // odniesienie: „niż pierwszego dnia”, „niż metalowych”, „od niego” – inaczej poprzednia wielkość
    const refM = /(?<!\p{L})(?:niż|od)\s+(\p{L}+)/iu.exec(c)
    const pick = (): Ent | undefined => {
      if (!ents.length) return undefined
      if (refM) {
        const o = ordOf(refM[1])
        if (o) return ents[o - 1]
        const s = stem(refM[1])
        const hit = ents.filter((e) => e.label.has(s))
        if (hit.length === 1) return hit[0]
      }
      return ents[ents.length - 1]
    }
    const times = /^\s*razy\s/iu.test(after)
    const by = new RegExp(`(?<!\\p{L})o\\s+${N}`, 'u').test(c)
    const up = CMP_UP.test(c)
    const down = CMP_DOWN.test(c)
    if ((times || by) && up !== down) {
      const ref = pick()
      if (!ref) return null
      const r = times ? (up ? ref.v.mul(v) : ref.v.div(v)) : up ? ref.v.add(v) : ref.v.sub(v)
      rel++
      ctx.trace.push({ kind: 'reguła', text: `„${c.trim()}” → ${ref.v.pl()} ${times ? (up ? '·' : ':') : up ? '+' : '−'} ${v.pl()} = ${r.pl()}` })
      ents.push({ v: r, label, ord: ordOf(c) || ents.length + 1, text: c.trim() })
    } else if (!times && !by && !up && !down) {
      ents.push({ v, label, ord: ordOf(c) || ents.length + 1, text: c.trim() })
      ctx.trace.push({ kind: 'fakt', text: `„${c.trim()}” → ${v.pl()}` })
    } else return null
  }
  if (ents.length < 2) return null
  if (kinds && kinds !== ents.length) {
    ctx.trace.push({ kind: 'brak', text: `w treści ${kinds} rodzaje, a wielkości ${ents.length} – nie zgaduję` })
    return null
  }
  const qx = q.toLowerCase()
  const unit = quantities(body)[0]?.units[0]
  const fmtA = (v: Q) => (unit && (unit.dim === 'pieniądze' || unit.dim === 'długość' || unit.dim === 'masa') ? withUnit(v, unit) : v.pl())
  if (/^o (ile|ilu)(?![\p{L}\d])/u.test(qx)) {
    if (ents.length !== 2) return null
    const [a, b] = ents[0].v.cmp(ents[1].v) >= 0 ? [ents[0], ents[1]] : [ents[1], ents[0]]
    const r = a.v.sub(b.v)
    ctx.trace.push({ kind: 'wniosek', text: `„o ile” = różnica: ${a.v.pl()} − ${b.v.pl()} = ${r.pl()}` })
    return { answer: fmtA(r), method: 'szkoła: zadanie tekstowe' }
  }
  if (/(?<![\p{L}\d])(razem|łącznie|w sumie|wszystk\p{L}*|ogółem)(?![\p{L}\d])/iu.test(qx)) {
    if (!rel && ents.length < 2) return null
    const r = ents.reduce((a, e) => a.add(e.v), new Q(0n))
    ctx.trace.push({ kind: 'wniosek', text: `razem: ${ents.map((e) => e.v.pl()).join(' + ')} = ${r.pl()}` })
    return { answer: fmtA(r), method: 'szkoła: zadanie tekstowe' }
  }
  if (!rel) return null
  // o którą wielkość pytamy: liczebnik porządkowy („drugiego dnia”) albo słowa wspólne z pytaniem
  const o = ordOf(qx)
  let target: Ent | undefined = o ? ents.find((e) => e.ord === o) : undefined
  if (!target) {
    const qs = new Set(q.split(/[^\p{L}]+/u).filter((w) => w && !STOP.has(low(w))).map(stem))
    const sc = ents.map((e) => [...e.label].filter((x) => qs.has(x)).length)
    const best = Math.max(...sc)
    if (best > 0 && sc.filter((x) => x === best).length === 1) target = ents[sc.indexOf(best)]
  }
  if (!target) {
    ctx.trace.push({ kind: 'brak', text: 'nie wiem, o którą wielkość pyta pytanie' })
    return null
  }
  ctx.trace.push({ kind: 'wniosek', text: `pytanie dotyczy: „${target.text}” → ${target.v.pl()}` })
  return { answer: fmtA(target.v), method: 'szkoła: zadanie tekstowe' }
}

// ------------------------------------------------------------------ procenty w treści
const PCT_WORD: Record<string, number> = { dwu: 2, trzy: 3, cztero: 4, pięcio: 5, sześcio: 6, siedmio: 7, ośmio: 8, dziewięcio: 9, dziesięcio: 10, piętnasto: 15, dwudziesto: 20, dwudziestopięcio: 25, trzydziesto: 30, czterdziesto: 40, pięćdziesięcio: 50, siedemdziesięcio: 70, osiemdziesięcio: 80 }
export function percentStory(text: string, ctx: NumCtx): NumResult | null {
  let t = text.replace(/\s+/g, ' ').replace(/(\d)\s+%/g, '$1%')
  t = t.replace(/(\p{L}+)procentow\p{L}*/giu, (m0, p) => (low(p) in PCT_WORD ? `${PCT_WORD[low(p)]}% ${m0}` : m0))
  const sents = sentencesOf(t)
  const q = sents.findLast((s) => /\?\s*$/.test(s) || /^oblicz/i.test(s)) ?? ''
  // „gra kosztowała o 12 złotych mniej” po p% obniżce → cena = 12 : p%
  let m = new RegExp(`${N}%[^.?]*?o\\s+${N}\\s*(zł|złot\\p{L}*)\\s+(mniej|więcej)`, 'iu').exec(t)
  if (m && /(przed|poprzedni|pierwotn|wcześniej)/iu.test(q)) {
    const r = P(m[2]).div(P(m[1]).div(H))
    ctx.trace.push({ kind: 'reguła', text: `${m[1]}% ceny = ${m[2]} zł → cena = ${m[2]} : ${m[1]}% = ${money(r)} zł` })
    return { answer: `${money(r)} zł`, method: 'szkoła: procenty' }
  }
  // obniżki / podwyżki o p% (także „dwukrotnie o 5%”)
  const changes = [...t.matchAll(new RegExp(`(obniż\\p{L}*|podwyż\\p{L}*|podniesi\\p{L}*|zmniejsz\\p{L}*|zwiększ\\p{L}*|wzrosł\\p{L}*|spadł\\p{L}*)(?:\\s+[\\p{L}–—-]+){0,4}?\\s+(dwukrotnie\\s+|trzykrotnie\\s+)?o\\s+${N}%`, 'giu'))]
  if (changes.length) {
    const prices = quantities(sents[0] ?? '').filter((x) => x.dim === 'pieniądze')
    const start = prices[0] ?? quantities(t).find((x) => x.dim === 'pieniądze')
    if (!start) return null
    let v = start.v
    for (const c of changes) {
      const k = c[2] ? (/dwu/i.test(c[2]) ? 2 : 3) : 1
      const down = /obniż|zmniejsz|spadł/i.test(c[1])
      for (let i = 0; i < k; i++) {
        const nv = down ? v.mul(H.sub(P(c[3]))).div(H) : v.mul(H.add(P(c[3]))).div(H)
        ctx.trace.push({ kind: 'reguła', text: `${down ? 'obniżka' : 'podwyżka'} o ${c[3]}%: ${zl(v)} · ${down ? 100 - Number(c[3]) : 100 + Number(c[3])}% = ${zl(nv)}` })
        v = nv
      }
    }
    if (/(?<![\p{L}\d])o ile(?![\p{L}\d])|różnic\p{L}*/iu.test(q)) {
      const d = start.v.cmp(v) > 0 ? start.v.sub(v) : v.sub(start.v)
      ctx.trace.push({ kind: 'wniosek', text: `różnica: ${zl(start.v)} − ${zl(v)} = ${zl(d)}` })
      return { answer: zl(d), method: 'szkoła: procenty' }
    }
    if (/(ile kosztuj|cen\p{L}* .*po|po (obu|obniż|podwyż)|kosztuje\p{L}* teraz|ile (teraz|obecnie))/iu.test(q)) {
      ctx.trace.push({ kind: 'wniosek', text: `cena końcowa: ${zl(v)}` })
      return { answer: zl(v), method: 'szkoła: procenty' }
    }
    return null
  }
  // „białko stanowi 16,5%” / „woda stanowi 0,65 masy”: część = całość · p, albo całość = część : p
  m = new RegExp(`(\\p{L}+)\\s+stanowi\\s+(?:około\\s+)?${N}(%|\\s+(?:masy|ceny|długości|objętości|powierzchni|liczby))`, 'iu').exec(t)
  if (m) {
    const f = m[3] === '%' ? P(m[2]).div(H) : P(m[2])
    const qq = quantities(q)
    const bodyQ = quantities(sents.filter((s) => s !== q).join(' '))
    if (qq.length === 1 && bodyQ.length === 0) {
      const r = qq[0].v.div(f).div(qq[0].units[0].f)
      ctx.trace.push({ kind: 'reguła', text: `„${m[1]}” = ${m[2]}${m[3] === '%' ? '%' : ''} całości i waży ${qq[0].text} → całość = ${qq[0].text} : ${f.pl()} = ${withUnit(r, qq[0].units[0])}` })
      return { answer: withUnit(r, qq[0].units[0]), method: 'szkoła: procenty' }
    }
    if (qq.length === 0 && bodyQ.length === 1 && new RegExp(stem(m[1]).slice(0, 4), 'iu').test(q)) {
      const r = bodyQ[0].v.mul(f).div(bodyQ[0].units[0].f)
      ctx.trace.push({ kind: 'reguła', text: `„${m[1]}” = ${m[2]}${m[3] === '%' ? '%' : ''} z ${bodyQ[0].text} → ${bodyQ[0].text} · ${f.pl()} = ${withUnit(r, bodyQ[0].units[0])}` })
      return { answer: withUnit(r, bodyQ[0].units[0]), method: 'szkoła: procenty' }
    }
  }
  return null
}

// ------------------------------------------------------------------ prędkość z godzin; działania odwrotne
export function speed(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ')
  if (!/prędkości\p{L}*/iu.test(t) || !/(z jaką|jaka jest|oblicz)/iu.test(t)) return null
  const hours = [...t.matchAll(/godzin\p{L}*\s+(\d{1,2})\s*[:.]\s*(\d{2})/giu)].map((m) => Number(m[1]) * 60 + Number(m[2]))
  const d = quantities(t).filter((x) => x.dim === 'długość')
  if (hours.length !== 2 || d.length !== 1) return null
  let min = hours[1] - hours[0]
  if (min <= 0) min += 24 * 60
  const km = d[0].v.div(unitOf('km')!.f)
  const v = km.mul(new Q(60n)).div(new Q(BigInt(min)))
  ctx.trace.push({ kind: 'reguła', text: `czas jazdy: ${Math.floor(min / 60)} h ${min % 60} min = ${new Q(BigInt(min), 60n).pl()} h; prędkość = droga : czas = ${km.pl()} km : ${new Q(BigInt(min), 60n).pl()} h = ${v.pl()} km/h` })
  return { answer: `${v.pl()} km/h`, method: 'szkoła: zadanie tekstowe' }
}
export function inverse(text: string, ctx: NumCtx): NumResult | null {
  const t = wordsToDigits(text.replace(/\s+/g, ' '), ctx.lex)
  const m = /(?:pewn\p{L}* liczb\p{L}*|tę liczbę|liczbę x|myśloną liczbę)(.+?)(?:,\s*)?(?:otrzymamy|otrzymujemy|dostaniemy|wyjdzie|to otrzymamy)\s+(\d+(?:[.,]\d+)?)/iu.exec(t)
  if (!m || !/(jaka to liczba|jaką liczbę|oblicz tę liczbę|znajdź tę liczbę)/iu.test(t)) return null
  const ops: [string, Q][] = []
  for (const x of m[1].matchAll(new RegExp(`(zwiększ\\p{L}*|zmniejsz\\p{L}*|pomnoż\\p{L}*|podziel\\p{L}*|dodam\\p{L}*|doda\\p{L}*|odejm\\p{L}*)(?:\\s+\\p{L}+){0,3}?\\s+(o\\s+|przez\\s+)?${N}(\\s+razy)?`, 'giu'))) {
    const w = low(x[1])
    const v = P(x[3])
    const op = w.startsWith('zwiększ') ? (x[4] ? '*' : x[2]?.startsWith('o') ? '+' : null) : w.startsWith('zmniejsz') ? (x[4] ? '/' : x[2]?.startsWith('o') ? '-' : null) : w.startsWith('pomnoż') ? '*' : w.startsWith('podziel') ? '/' : w.startsWith('doda') ? '+' : '-'
    if (!op) return null
    ops.push([op, v])
  }
  if (!ops.length || ops.length !== [...m[1].matchAll(new RegExp(N, 'g'))].length) return null
  let r = P(m[2])
  const steps: string[] = []
  for (const [op, v] of [...ops].reverse()) {
    const nr = op === '*' ? r.div(v) : op === '/' ? r.mul(v) : op === '+' ? r.sub(v) : r.add(v)
    steps.push(`cofam „${op === '*' ? '·' : op === '/' ? ':' : op === '+' ? '+' : '−'} ${v.pl()}”: ${r.pl()} ${op === '*' ? ':' : op === '/' ? '·' : op === '+' ? '−' : '+'} ${v.pl()} = ${nr.pl()}`)
    r = nr
  }
  ctx.trace.push({ kind: 'reguła', text: `działania na liczbie: ${ops.map(([o, v]) => `${o === '*' ? '·' : o === '/' ? ':' : o === '+' ? '+' : '−'} ${v.pl()}`).join(', ')}; wynik ${m[2]} → działania odwrotne od końca` })
  for (const s of steps) ctx.trace.push({ kind: 'wniosek', text: s })
  return { answer: r.pl(), method: 'szkoła: zadanie tekstowe' }
}

export function story(text: string, ctx: NumCtx): NumResult | null {
  for (const f of [inverse, speed, percentStory, shopping, perEach, chain]) {
    const mark = ctx.trace.length
    try {
      const r = f(text, ctx)
      if (r) return r
    } catch {
      ctx.trace.splice(mark)
    }
    ctx.trace.splice(mark)
  }
  return null
}
