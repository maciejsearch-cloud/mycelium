// Czysta grzybnia – zadania szkolne (klasy 1–7): działania zapisane cyframi, ułamki zwykłe i dziesiętne (dokładnie,
// na ułamkach z BigInt), procenty, liczby „o N większe / N razy mniejsze”, NWD/NWW, dzielenie z resztą, porządkowanie.
// Bez modelu językowego: same wzorce polskich poleceń szkolnych + ślad każdego kroku. Gdy polecenie nie pasuje
// do żadnego wzorca – „nie wiem”, nie zgadywanie. Reguły pisane na zestawie dev (benchmarks/szkolne/szkolne_dev_v1.json);
// zamrożony zestaw testowy służy tylko do pomiaru.
import type { NumCtx, NumResult } from './czystaLiczby'
import { units } from './czystaJednostki'
import { story } from './czystaZadania'
import { Q } from './czystaQ'

export { Q }

/** wynik do pokazania: ułamek zwykły, gdy w danych był ułamek zwykły; zaokrąglenia nie dokładamy */
const show = (q: Q, frac = false) => q.pl(frac)

// ------------------------------------------------------------------ liczby w tekście szkolnym
/** liczba z odstępami tysięcy („18 270”, „50 657 747,68”), z przecinkiem dziesiętnym albo ułamek „3/4” */
export const NUM_RE = /\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?(?!\d)|\d+(?:[.,]\d+)?(?:\/\d+)?/g
export const numsQ = (s: string): Q[] => [...s.matchAll(NUM_RE)].map((m) => Q.parse(m[0])!).filter(Boolean)

// ------------------------------------------------------------------ działanie zapisane symbolami
const OPS: Record<string, string> = { '+': '+', '-': '-', '−': '-', '–': '-', '·': '*', '∙': '*', '•': '*', '×': '*', '*': '*', ':': '/', '÷': '/' }
type Tk = { t: 'n'; v: Q; frac: boolean } | { t: 'o'; v: string }
function tokens(expr: string): Tk[] | null {
  const out: Tk[] = []
  const re = /\s*(\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?(?![\d/])|\d+(?:[.,]\d+)?(?:\/\d+)?|[-+−–·∙•×*:÷()])\s*/y
  let at = 0
  let m: RegExpExecArray | null
  while (at < expr.length && (m = re.exec(expr))) {
    at = re.lastIndex
    if (/\d/.test(m[1])) out.push({ t: 'n', v: Q.parse(m[1])!, frac: m[1].includes('/') })
    else out.push({ t: 'o', v: m[1] === '(' || m[1] === ')' ? m[1] : OPS[m[1]] })
  }
  return expr.slice(at).trim() === '' ? out : null
}
const SYM: Record<string, string> = { '+': '+', '-': '−', '*': '·', '/': ':' }
/** kolejność działań (· : przed + −), nawiasy; dokładnie na ułamkach */
export function evalQ(expr: string, steps: string[]): { v: Q; frac: boolean } | null {
  const toks = tokens(expr)
  if (!toks || toks.filter((t) => t.t === 'n').length < 2 || !toks.some((t) => t.t === 'o' && t.v !== '(' && t.v !== ')')) return null
  const frac = toks.some((t) => t.t === 'n' && t.frac)
  const prec: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const outq: Tk[] = []
  const st: string[] = []
  let prev: Tk | undefined
  for (const k of toks) {
    if (k.t === 'n') {
      if (prev?.t === 'n') return null
      outq.push(k)
    } else if (k.v === '(') st.push('(')
    else if (k.v === ')') {
      while (st.length && st[st.length - 1] !== '(') outq.push({ t: 'o', v: st.pop()! })
      if (st.pop() !== '(') return null
    } else {
      if (!prev || (prev.t === 'o' && prev.v !== ')')) return null
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
  const S: Q[] = []
  for (const k of outq) {
    if (k.t === 'n') S.push(k.v)
    else {
      const b = S.pop()
      const a = S.pop()
      if (!a || !b) return null
      if (k.v === '/' && b.n === 0n) return null
      const r = k.v === '+' ? a.add(b) : k.v === '-' ? a.sub(b) : k.v === '*' ? a.mul(b) : a.div(b)
      steps.push(`${show(a, frac)} ${SYM[k.v]} ${show(b, frac)} = ${show(r, frac)}`)
      S.push(r)
    }
  }
  return S.length === 1 ? { v: S[0], frac } : null
}

const INSTR = /^(oblicz\p{L}*|policz\p{L}*|wykonaj\p{L}*|wstaw\p{L}*|wpisz\p{L}*|uzupełnij\p{L}*|podaj\p{L}*|rozwiąż\p{L}*|zapisz\p{L}*)(?![\p{L}\d])/iu
/** „Oblicz. 35 : 7”, „Wstaw prawidłowy wynik dzielenia. 36 : 4 =”, „Oblicz w pamięci. 6 ∙ 0,5”, „Ile to 3 + 4?” */
export function expression(text: string, ctx: NumCtx): NumResult | null {
  const s = text.trim().replace(/\s*(=\s*)?(…|\.{3}|_+|\?)?\s*$/u, (m) => (m.includes('=') || m.includes('…') || m.includes('_') ? '' : m.replace('?', '')))
  // ostatni fragment po kropce/dwukropku polecenia – musi być samym działaniem
  const m = /(?:^|[.:!]\s+|^(?:ile\s+(?:to|jest|wynosi|będzie)\s+))([\d(][\d\s\u00a0.,+\-−–·∙•×*:÷/()]*[\d)])\s*=?\s*$/iu.exec(s)
  if (!m) return null
  const head = s.slice(0, m.index).trim()
  if (head && !INSTR.test(head) && !/^ile(?![\p{L}\d])/iu.test(head) && !/^[\p{L}\s,]*(działa\p{L}*|wynik\p{L}*|sum\p{L}*|różnic\p{L}*|iloczyn\p{L}*|iloraz\p{L}*)[\p{L}\s,.:]*$/iu.test(head)) return null
  const expr = m[1]
  const steps: string[] = []
  const r = evalQ(expr, steps)
  if (!r) return null
  ctx.trace.push({ kind: 'rozbiór', text: `działanie: ${expr.trim()}${r.frac ? ' (ułamki zwykłe – liczę dokładnie)' : ''}` })
  for (const x of steps) ctx.trace.push({ kind: 'wniosek', text: x })
  return { answer: show(r.v, r.frac), method: 'szkoła: działania' }
}

// ------------------------------------------------------------------ liczba „o N większa”, „N razy mniejsza”, „o ile”, „ile razy”
const W = '(\\d+(?:[.,]\\d+)?(?:/\\d+)?)'
export function relative(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ')
  let m = new RegExp(`liczb\\p{L}* (?:jest )?o ${W} (większ|mniejsz)\\p{L}* (?:od|niż) (?:liczby )?${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[1])!, Q.parse(m[3])!]
    const up = m[2].toLowerCase().startsWith('więk')
    const r = up ? b.add(a) : b.sub(a)
    ctx.trace.push({ kind: 'reguła', text: `„o ${m[1]} ${up ? 'większa' : 'mniejsza'} od ${m[3]}” → ${m[3]} ${up ? '+' : '−'} ${m[1]} = ${show(r)}` })
    return { answer: show(r), method: 'szkoła: działania' }
  }
  m = new RegExp(`liczb\\p{L}* (?:jest )?${W} razy (większ|mniejsz)\\p{L}* (?:od|niż) (?:liczby )?${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[1])!, Q.parse(m[3])!]
    const up = m[2].toLowerCase().startsWith('więk')
    const r = up ? b.mul(a) : b.div(a)
    ctx.trace.push({ kind: 'reguła', text: `„${m[1]} razy ${up ? 'większa' : 'mniejsza'} od ${m[3]}” → ${m[3]} ${up ? '·' : ':'} ${m[1]} = ${show(r)}` })
    return { answer: show(r), method: 'szkoła: działania' }
  }
  m = new RegExp(`^o ile (?:liczba )?${W} jest (większ|mniejsz)\\p{L}* (?:od|niż) (?:liczby )?${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[1])!, Q.parse(m[3])!]
    const r = a.sub(b).cmp(new Q(0n)) < 0 ? b.sub(a) : a.sub(b)
    ctx.trace.push({ kind: 'reguła', text: `„o ile” = różnica: ${show(a.cmp(b) > 0 ? a : b)} − ${show(a.cmp(b) > 0 ? b : a)} = ${show(r)}` })
    return { answer: show(r), method: 'szkoła: działania' }
  }
  m = new RegExp(`^ile razy (?:liczba )?${W} jest (?:większ|mniejsz)\\p{L}* (?:od|niż) (?:liczby )?${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[1])!, Q.parse(m[2])!]
    const [hi, lo] = a.cmp(b) >= 0 ? [a, b] : [b, a]
    const r = hi.div(lo)
    ctx.trace.push({ kind: 'reguła', text: `„ile razy” = iloraz: ${show(hi)} : ${show(lo)} = ${show(r)}` })
    return { answer: show(r), method: 'szkoła: działania' }
  }
  // „Oblicz sumę / różnicę / iloczyn / iloraz liczb A i B”
  m = new RegExp(`(sum|różnic|iloczyn|iloraz)\\p{L}* (?:liczb )?${W} i ${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[2])!, Q.parse(m[3])!]
    const k = m[1].toLowerCase()
    const [r, op] = k === 'sum' ? [a.add(b), '+'] : k === 'różnic' ? [a.sub(b), '−'] : k === 'iloczyn' ? [a.mul(b), '·'] : [a.div(b), ':']
    ctx.trace.push({ kind: 'reguła', text: `${m[1]}… liczb ${m[2]} i ${m[3]}: ${m[2]} ${op} ${m[3]} = ${show(r)}` })
    return { answer: show(r), method: 'szkoła: działania' }
  }
  return null
}

// ------------------------------------------------------------------ procenty
export function percent(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ').replace(/(\d)\s+%/g, '$1%')
  // „Znajdź wielkość / liczbę, której P% jest równe X”
  let m = new RegExp(`(?:wielkość|liczb\\p{L}*|kwot\\p{L}*), której ${W}% (?:jest równ\\p{L}*|wynosi|to) ${W}\\s*(\\p{L}*)`, 'iu').exec(t)
  if (m) {
    const [p, x] = [Q.parse(m[1])!, Q.parse(m[2])!]
    const r = x.mul(new Q(100n)).div(p)
    ctx.trace.push({ kind: 'reguła', text: `${m[1]}% całości = ${m[2]} → całość = ${m[2]} : ${m[1]} · 100 = ${show(r)}` })
    return { answer: `${show(r)}${m[3] ? ' ' + m[3] : ''}`, method: 'szkoła: procenty' }
  }
  // „Jakim procentem liczby A jest B?” / „Jaki procent A stanowi B”
  m = new RegExp(`jaki\\p{L}* procent\\p{L}* (?:liczby )?${W} (?:jest|stanowi) (?:liczba )?${W}`, 'iu').exec(t)
  if (m) {
    const [a, b] = [Q.parse(m[1])!, Q.parse(m[2])!]
    const r = b.div(a).mul(new Q(100n))
    ctx.trace.push({ kind: 'reguła', text: `${m[2]} : ${m[1]} · 100% = ${show(r)}%` })
    return { answer: `${show(r)}%`, method: 'szkoła: procenty' }
  }
  // „Oblicz P% liczby N” / „Ile to P% z N?”
  m = new RegExp(`^(?:oblicz\\p{L}*:?|ile (?:to|wynosi|jest) )\\s*${W}% (?:liczby |z |od )?${W}\\s*(\\p{L}*)\\s*\\??$`, 'iu').exec(t.trim())
  if (m) {
    const [p, n] = [Q.parse(m[1])!, Q.parse(m[2])!]
    const r = p.div(new Q(100n)).mul(n)
    ctx.trace.push({ kind: 'reguła', text: `${m[1]}% z ${m[2]} = ${m[1]} : 100 · ${m[2]} = ${show(r)}` })
    return { answer: `${show(r)}${m[3] ? ' ' + m[3] : ''}`, method: 'szkoła: procenty' }
  }
  return null
}

// ------------------------------------------------------------------ NWD / NWW, dzielenie z resztą, porządek, zaokrąglenia
export function numberTheory(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ')
  const gcdW = /(?<![\p{L}\d])NWD(?![\p{L}\d])|największ\p{L}* wspóln\p{L}* dzielnik/iu.test(t)
  const lcmW = /(?<![\p{L}\d])NWW(?![\p{L}\d])|najmniejsz\p{L}* wspóln\p{L}* wielokrotno/iu.test(t)
  if (gcdW !== lcmW) {
    const tail = t.split(/liczb\p{L}*:?/iu).slice(1).join(' ')
    const xs = numsQ(tail || t).filter((q) => q.isInt() && q.n > 0n)
    if (xs.length >= 2 && xs.length <= 4) {
      let g = xs[0].n
      const steps: string[] = []
      for (const x of xs.slice(1)) {
        let [a, b] = [g, x.n]
        while (b) {
          if (gcdW) steps.push(`${a} = ${a / b} · ${b} + ${a % b}`)
          ;[a, b] = [b, a % b]
        }
        g = gcdW ? a : (g * x.n) / a
      }
      ctx.trace.push({ kind: 'reguła', text: gcdW ? 'NWD algorytmem Euklidesa (dzielenie z resztą, aż reszta = 0)' : 'NWW(a, b) = a · b : NWD(a, b)' })
      for (const s of steps) ctx.trace.push({ kind: 'wniosek', text: s })
      ctx.trace.push({ kind: 'wniosek', text: `${gcdW ? 'NWD' : 'NWW'}(${xs.map((x) => x.pl()).join(', ')}) = ${g}` })
      return { answer: String(g), method: 'szkoła: działania' }
    }
  }
  // „W wyniku dzielenia pewnej liczby przez 7 otrzymujemy 4 i resztę 2”
  let m = /dzieleni\p{L}* (?:pewnej |jakiejś )?liczby(?: naturalnej)? przez (\d+) (?:otrzym\p{L}*|dostaj\p{L}*|wychodzi) (\d+) i reszt\p{L}* (\d+)/iu.exec(t)
  if (m) {
    const [d, q, r] = m.slice(1, 4).map(Number)
    if (r < d) {
      ctx.trace.push({ kind: 'reguła', text: `dzielna = dzielnik · iloraz + reszta = ${d} · ${q} + ${r} = ${d * q + r}` })
      return { answer: String(d * q + r), method: 'szkoła: działania' }
    }
  }
  // „… w kolejności rosnącej / malejącej …: a, b, c”
  m = /kolejności (rosnącej|malejącej)|od (najmniejszej|największej) do (?:największej|najmniejszej)/iu.exec(t)
  if (m) {
    const tail = t.slice(m.index + m[0].length)
    const xs = [...tail.matchAll(/\d{1,3}(?:[ \u00a0]\d{3})+(?:,\d+)?(?![\d,])|\d+(?:,\d+)?(?:\/\d+)?/g)].map((x) => ({ s: x[0], q: Q.parse(x[0])! }))
    if (xs.length >= 2) {
      const up = (m[1] ?? m[2]).toLowerCase().startsWith('rosn') || (m[2] ?? '').toLowerCase().startsWith('najmn')
      const out = [...xs].sort((a, b) => (up ? a.q.cmp(b.q) : b.q.cmp(a.q)))
      ctx.trace.push({ kind: 'reguła', text: `porównanie liczb (${up ? 'rosnąco' : 'malejąco'}): ${out.map((x) => x.s).join(up ? ' < ' : ' > ')}` })
      return { answer: out.map((x) => x.s).join(', '), method: 'szkoła: działania' }
    }
  }
  // zaokrąglanie: „Zaokrąglij 3,456 do części setnych”, „Zapisz tę liczbę z dokładnością do tysięcy”
  m = /(?:zaokrągl\p{L}*|z dokładnością)[^.?]*?do (części )?(dziesiątych|setnych|tysięcznych|jedności|dziesiątek|setek|tysięcy|milionów)/iu.exec(t)
  if (m) {
    const K: Record<string, number> = { dziesiątych: 1, setnych: 2, tysięcznych: 3, jedności: 0, dziesiątek: -1, setek: -2, tysięcy: -3, milionów: -6 }
    const k = K[m[2].toLowerCase()]
    const all = numsQ(t)
    if (all.length === 1) {
      const r = all[0].round(k)
      ctx.trace.push({ kind: 'reguła', text: `zaokrąglenie do ${m[1] ?? ''}${m[2]}: patrzę na następną cyfrę (≥ 5 → w górę) → ${show(r)}` })
      return { answer: show(r), method: 'szkoła: działania' }
    }
  }
  return null
}

/** Kolejność: działanie symbolami → procenty → „o N / N razy” → NWD/NWW, reszta, porządek, zaokrąglenia. */
export function school(text: string, ctx: NumCtx): NumResult | null {
  for (const f of [story, units, expression, percent, relative, numberTheory]) {
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
