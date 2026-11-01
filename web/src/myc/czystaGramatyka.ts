// Czysta grzybnia – gramatyka szkolna (klasy 1–8): część mowy, rodzaj rzeczownika (męski osobowy / zwierzęcy /
// rzeczowy, żeński, nijaki), rodzaj w liczbie mnogiej (męskoosobowy / niemęskoosobowy), liczba, forma przypadka
// („sroka – C. lp.”) i liczby mnogiej. Źródła: słownik Morfeusz 2 / SGJP (tagi NKJP) i model rozbioru grzybni
// (UPOS i cechy UD) – bez modelu językowego. Słowa spoza słownika: odmiana przez analogię do słów o tym samym
// zakończeniu ze słownika (tylko gdy ≥ 3 wzory i ≥ 80% zgodnych); niejednoznaczne → „nie wiem”.
import type { NumCtx, NumResult } from './czystaLiczby'
import { lexAnalyses, type MorfLex } from './morf'
import { applyRule } from './rozbior'

const low = (s: string) => s.toLowerCase()
type Pos = 'rzeczownik' | 'czasownik' | 'przymiotnik' | 'liczebnik' | 'przysłówek' | 'przyimek' | 'spójnik' | 'partykuła' | 'wykrzyknik' | 'zaimek'
const ALL_POS: Pos[] = ['rzeczownik', 'czasownik', 'przymiotnik', 'liczebnik', 'przysłówek', 'przyimek', 'spójnik', 'partykuła', 'wykrzyknik', 'zaimek']
/** liczebniki porządkowe – w SGJP przymiotniki, w szkole liczebniki */
const ORDINAL = /^(pierwszy|drugi|trzeci|czwarty|piąty|szósty|siódmy|ósmy|dziewiąty|\p{L}*nasty|\p{L}*dziesty|\p{L}*setny|tysięczny|milionowy)$/u
function posOfTag(tag: string, lemma: string): Pos | null {
  const c = tag.split(':')[0]
  if (c === 'subst' || c === 'depr' || c === 'ger') return 'rzeczownik'
  if (['fin', 'praet', 'impt', 'inf', 'bedzie', 'imps', 'winien', 'pred'].includes(c)) return 'czasownik'
  if (['adj', 'adja', 'adjp', 'adjc'].includes(c)) return ORDINAL.test(low(lemma)) ? 'liczebnik' : 'przymiotnik'
  if (c === 'num' || c === 'numcol') return 'liczebnik'
  if (c === 'adv') return 'przysłówek'
  if (c === 'prep') return 'przyimek'
  if (c === 'conj' || c === 'comp') return 'spójnik'
  if (c === 'qub') return 'partykuła'
  if (c === 'interj') return 'wykrzyknik'
  if (c === 'ppron12' || c === 'ppron3' || c === 'siebie') return 'zaimek'
  return null
}
const UPOS_POS: Record<string, Pos> = { NOUN: 'rzeczownik', PROPN: 'rzeczownik', VERB: 'czasownik', ADJ: 'przymiotnik', NUM: 'liczebnik', ADV: 'przysłówek', ADP: 'przyimek', CCONJ: 'spójnik', SCONJ: 'spójnik', PART: 'partykuła', INTJ: 'wykrzyknik', PRON: 'zaimek', DET: 'zaimek' }

/** ostatni element zadania: „… liczebnik. stół” → „stół” */
function item(t: string): string | null {
  const m = /[.:]\s*([\p{L}-]+)\s*\.?$/u.exec(t.trim())
  return m ? m[1] : null
}

function partOfSpeech(t: string, ctx: NumCtx): NumResult | null {
  if (!/części mowy|część mowy/iu.test(t)) return null
  const w = item(t)
  if (!w) return null
  const head = t.slice(0, t.lastIndexOf(w))
  const listed = ALL_POS.filter((p) => new RegExp(p.slice(0, 6), 'iu').test(head))
  const allowed = listed.length >= 2 ? listed : ALL_POS
  const an = ctx.lex ? lexAnalyses(ctx.lex, low(w)) : []
  const fromLex = [...new Set(an.map(([l, tag]) => posOfTag(tag, l.split(':')[0])).filter((p): p is Pos => !!p))]
  ctx.trace.push({ kind: 'fakt', text: `„${w}” w słowniku Morfeusza: ${an.length ? [...new Set(an.map(([l, tag]) => `${l.split(':')[0]} ${tag.split(':')[0]}`))].join(', ') : 'brak'}${listed.length >= 2 ? `; do wyboru: ${listed.join(', ')}` : ''}` })
  let cand = fromLex.filter((p) => allowed.includes(p))
  let upos: string | undefined
  if (cand.length !== 1) {
    // model rozbioru (samo słowo) rozstrzyga między kandydatami ze słownika albo zastępuje słownik dla słów spoza niego
    try {
      const tok = ctx.parse(w).tokens[0]
      upos = tok?.upos
      const p = upos ? UPOS_POS[upos] : undefined
      const pp = p === 'przymiotnik' && ORDINAL.test(low(tok?.lemma ?? w)) ? 'liczebnik' : p
      if (pp && allowed.includes(pp) && (cand.length === 0 || cand.includes(pp))) {
        ctx.trace.push({ kind: 'rozbiór', text: `model rozbioru: „${w}” → ${upos}${tok?.lemma ? ` (lemat ${tok.lemma})` : ''} → ${pp}` })
        cand = [pp]
      }
    } catch {
      /* brak modelu */
    }
  }
  if (cand.length !== 1) {
    ctx.trace.push({ kind: 'brak', text: cand.length ? `kilka części mowy możliwych (${cand.join(', ')}) – nie zgaduję` : 'ani słownik, ani model rozbioru nie dają części mowy z listy' })
    return null
  }
  ctx.trace.push({ kind: 'wniosek', text: `„${w}” – ${cand[0]}` })
  return { answer: cand[0], method: 'szkoła: gramatyka' }
}

const GENDER: Record<string, string> = { m1: 'męski osobowy', m2: 'męski zwierzęcy', m3: 'męski rzeczowy', f: 'żeński', n: 'nijaki' }
function nounGender(w: string, ctx: NumCtx): string | null {
  const an = ctx.lex ? lexAnalyses(ctx.lex, low(w)).filter(([, tag]) => /^(subst|depr):sg:nom:/.test(tag)) : []
  const gs = [...new Set(an.map(([, tag]) => tag.split(':')[3]))]
  if (an.length) ctx.trace.push({ kind: 'fakt', text: `„${w}” w słowniku: ${[...new Set(an.map(([, tag]) => tag))].join(', ')}` })
  let tok
  try {
    tok = ctx.parse(w).tokens[0]
  } catch {
    tok = undefined
  }
  const f = tok?.feats ?? {}
  const ud = f.Gender === 'Fem' ? 'f' : f.Gender === 'Neut' ? 'n' : f.Gender === 'Masc' ? (f.Animacy === 'Hum' ? 'm1' : f.Animacy === 'Anim' ? 'm2' : f.Animacy === 'Inan' ? 'm3' : null) : null
  if (tok) ctx.trace.push({ kind: 'rozbiór', text: `model rozbioru: „${w}” ${tok.upos} ${f.Gender ?? '?'}${f.Animacy ? ' ' + f.Animacy : ''}` })
  let g: string | null = null
  if (gs.length === 1) g = gs[0]
  else if (!gs.length && ud && tok?.upos === 'NOUN') g = ud
  if (!g) {
    ctx.trace.push({ kind: 'brak', text: gs.length > 1 ? `słownik podaje kilka rodzajów (${gs.join(', ')}), model rozbioru nie rozstrzyga` : 'nie znam rodzaju tego słowa' })
    return null
  }
  return GENDER[g] ?? null
}
function gender(t: string, ctx: NumCtx): NumResult | null {
  if (!/rodzaj/iu.test(t)) return null
  // przymiotniki w liczbie mnogiej w zdaniu: „Ustnie określ ich rodzaj. Herosi bywali niezwykle uparci.”
  if (/liczbie mnogiej/iu.test(t) && /przymiotnik/iu.test(t)) {
    const sents = t.split(/(?<=[.!?])\s+/u)
    const s = sents[sents.length - 1]
    if (!ctx.lex) return null
    let a
    try {
      a = ctx.parse(s)
    } catch {
      return null
    }
    const out: [string, string][] = []
    for (const tok of a.tokens) {
      const an = lexAnalyses(ctx.lex, low(tok.form)).filter(([, tag]) => /^adj:pl:/.test(tag))
      // model rozbioru bywa niepewny co do części mowy („uparci” jako NOUN), ale lemat „uparty / olimpijski” jest przymiotnikowy
      const lem = low(tok.lemma ?? '')
      const adjLemma = lem !== low(tok.form) && /\p{L}{3}(y|i)$/u.test(lem) && !lexAnalyses(ctx.lex, lem).some(([, tag]) => /^subst/.test(tag))
      const adjUD = (tok.upos === 'ADJ' || adjLemma) && tok.feats?.Number === 'Plur'
      if (!an.length && !adjUD) continue
      if (an.length && tok.upos !== 'ADJ' && !adjUD) continue
      if (adjLemma && !an.length) ctx.trace.push({ kind: 'rozbiór', text: `„${tok.form}” – lemat „${tok.lemma}” ma zakończenie przymiotnika` })
      const m1 = an.some(([, tag]) => tag.split(':')[3].split('.').includes('m1'))
      const other = an.some(([, tag]) => tag.split(':')[3].split('.').some((g) => g !== 'm1'))
      const ud = tok.feats?.Gender === 'Masc' && tok.feats?.Animacy === 'Hum'
      // spoza słownika: cechy modelu (Masc + Hum) albo końcówka mianownika l. mn. (-e → niemęskoosobowy)
      const g = m1 && !other ? 'męskoosobowy' : other && !m1 ? 'niemęskoosobowy' : an.length ? null : ud && !/e$/.test(low(tok.form)) ? 'męskoosobowy' : /e$/.test(low(tok.form)) && !ud ? 'niemęskoosobowy' : null
      ctx.trace.push({ kind: 'fakt', text: `„${tok.form}”: ${an.length ? [...new Set(an.map(([, tag]) => tag))].join(', ') : `${tok.upos} ${tok.feats?.Gender ?? ''} ${tok.feats?.Animacy ?? ''}`}` })
      if (!g) {
        ctx.trace.push({ kind: 'brak', text: `„${tok.form}” – forma wspólna dla obu rodzajów, nie rozstrzygam` })
        return null
      }
      out.push([tok.form, g])
    }
    if (!out.length) return null
    const gs = [...new Set(out.map((x) => x[1]))]
    if (gs.length !== 1) return null
    ctx.trace.push({ kind: 'wniosek', text: out.map(([f, g]) => `„${f}” – rodzaj ${g}`).join('; ') })
    return { answer: `${out.map((x) => x[0]).join(', ')} – rodzaj ${gs[0]}`, method: 'szkoła: gramatyka' }
  }
  const w = item(t)
  if (!w) return null
  const g = nounGender(w, ctx)
  if (!g) return null
  ctx.trace.push({ kind: 'wniosek', text: `„${w}” – rodzaj ${g}` })
  return { answer: `rodzaj ${g}`, method: 'szkoła: gramatyka' }
}

function number(t: string, ctx: NumCtx): NumResult | null {
  if (!/liczb\p{L}* pojedyncz/iu.test(t) || !/liczb\p{L}* mnog/iu.test(t) || /dopisz|utwórz|brakując/iu.test(t)) return null
  const w = item(t)
  if (!w || !ctx.lex) return null
  const an = lexAnalyses(ctx.lex, low(w)).filter(([, tag]) => /^(subst|depr):(sg|pl):nom:/.test(tag))
  const ns = [...new Set(an.map(([, tag]) => tag.split(':')[1]))]
  ctx.trace.push({ kind: 'fakt', text: `„${w}” w słowniku (mianownik): ${an.length ? [...new Set(an.map(([, tag]) => tag))].join(', ') : 'brak'}` })
  let n = ns.length === 1 ? ns[0] : null
  if (!n) {
    try {
      const tok = ctx.parse(w).tokens[0]
      const ud = tok?.feats?.Number === 'Sing' ? 'sg' : tok?.feats?.Number === 'Plur' ? 'pl' : null
      if (ud && (!ns.length || ns.includes(ud))) {
        n = ud
        ctx.trace.push({ kind: 'rozbiór', text: `model rozbioru: Number=${tok.feats.Number}` })
      }
    } catch {
      /* brak */
    }
  }
  if (!n) return null
  const r = n === 'sg' ? 'liczba pojedyncza' : 'liczba mnoga'
  ctx.trace.push({ kind: 'wniosek', text: `„${w}” – ${r}` })
  return { answer: r, method: 'szkoła: gramatyka' }
}

// ------------------------------------------------------------------ tworzenie form: słownik, a dla słów spoza – analogia
let REV: Map<string, [string, string][]> | null = null
let REV_LEX: MorfLex | null = null
/** lemat → formy z tagami (z tego samego słownika Morfeusza co strona), budowane raz */
function reverse(lex: MorfLex): Map<string, [string, string][]> {
  if (REV && REV_LEX === lex) return REV
  const m = new Map<string, [string, string][]>()
  for (const [f, xs] of Object.entries(lex.forms)) {
    for (const [r, ti] of xs) {
      const lem = applyRule(f, lex.rules[r]).split(':')[0]
      const tag = lex.tags[ti]
      if (!/^(subst|depr)/.test(tag)) continue
      let a = m.get(lem)
      if (!a) m.set(lem, (a = []))
      a.push([f, tag])
    }
  }
  REV = m
  REV_LEX = lex
  return m
}
const tagHas = (tag: string, num: string, cas: string) => {
  const p = tag.split(':')
  return p[1] === num && p[2].split('.').includes(cas)
}
export function inflect(lemma: string, num: string, cas: string, ctx: NumCtx): string | null {
  const lex = ctx.lex
  if (!lex) return null
  const rev = reverse(lex)
  const all = (rev.get(lemma) ?? []).filter(([f]) => f === low(f))
  let own = all.filter(([, tag]) => tagHas(tag, num, cas))
  // rzeczownik zwykły przed formą deprecjatywną; rodzaj taki jak w mianowniku l. poj.
  if (own.some(([, t]) => t.startsWith('subst'))) own = own.filter(([, t]) => t.startsWith('subst'))
  const gs = new Set(all.filter(([f, t]) => f === lemma && tagHas(t, 'sg', 'nom')).map(([, t]) => t.split(':')[3]))
  if (new Set(own.map(([f]) => f)).size > 1 && gs.size === 1) own = own.filter(([, t]) => gs.has(t.split(':')[3]))
  const forms = [...new Set(own.map(([f]) => f))]
  if (forms.length === 1) {
    ctx.trace.push({ kind: 'fakt', text: `słownik Morfeusza: ${lemma} → ${forms[0]} (${own[0][1]})` })
    return forms[0]
  }
  if (forms.length > 1) {
    ctx.trace.push({ kind: 'brak', text: `słownik podaje kilka form (${forms.join(', ')}) – nie zgaduję` })
    return null
  }
  // analogia: lematy o najdłuższym wspólnym zakończeniu (≥ 3 litery), ich przejście lemat → forma
  for (let k = Math.min(lemma.length - 1, 6); k >= 3; k--) {
    const end = lemma.slice(-k)
    const votes = new Map<string, string[]>()
    for (const [lem, fs] of rev) {
      if (lem === lemma || !lem.endsWith(end) || lem.length < k + 1) continue
      // tylko lematy, których mianownik l. poj. to sam lemat (ten sam typ odmiany)
      if (lem !== low(lem) || !fs.some(([f, tag]) => f === lem && tagHas(tag, 'sg', 'nom'))) continue
      const tf = [...new Set(fs.filter(([f, tag]) => f === low(f) && tag.startsWith('subst') && tagHas(tag, num, cas)).map(([f]) => f))]
      if (tf.length !== 1) continue
      let p = 0
      while (p < lem.length && p < tf[0].length && lem[p] === tf[0][p]) p++
      if (lem.length - p > k) continue // zmiana sięga dalej niż wspólne zakończenie
      const rule = `${lem.slice(p)}→${tf[0].slice(p)}`
      const a = votes.get(rule) ?? []
      a.push(`${lem}→${tf[0]}`)
      votes.set(rule, a)
    }
    const total = [...votes.values()].reduce((s, a) => s + a.length, 0)
    if (total < 3) continue
    const [rule, ex] = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (ex.length / total < 0.8) {
      ctx.trace.push({ kind: 'brak', text: `analogia „-${end}”: wzory się różnią (${[...votes.entries()].map(([r, a]) => `${r} ×${a.length}`).join(', ')}) – nie zgaduję` })
      return null
    }
    const [from, to] = rule.split('→')
    const form = lemma.slice(0, lemma.length - from.length) + to
    ctx.trace.push({ kind: 'reguła', text: `„${lemma}” nie ma w słowniku; słowa na „-${end}”: ${ex.length}/${total} odmienia się „-${from} → -${to}” (np. ${ex.slice(0, 3).join(', ')}) → ${form}` })
    return form
  }
  ctx.trace.push({ kind: 'brak', text: `„${lemma}” nie ma w słowniku i brak dość słów o tym samym zakończeniu` })
  return null
}
const CASE: Record<string, [string, string]> = { m: ['nom', 'mianownik'], d: ['gen', 'dopełniacz'], c: ['dat', 'celownik'], b: ['acc', 'biernik'], n: ['inst', 'narzędnik'], ms: ['loc', 'miejscownik'], msc: ['loc', 'miejscownik'], w: ['voc', 'wołacz'] }
function forms(t: string, ctx: NumCtx): NumResult | null {
  // „Utwórz odpowiednie formy podanych rzeczowników. sroka - C. lp.”
  let m = /([\p{L}]+)\s*[-–]\s*(M|D|C|B|N|Ms|Msc|W)\.\s*(lp|lm)\.?$/iu.exec(t.trim())
  if (m) {
    const [cas, casPl] = CASE[low(m[2])]
    const num = low(m[3]) === 'lp' ? 'sg' : 'pl'
    ctx.trace.push({ kind: 'rozbiór', text: `„${m[1]}”: ${casPl}, liczba ${num === 'sg' ? 'pojedyncza' : 'mnoga'}` })
    const f = inflect(low(m[1]), num, cas, ctx)
    return f ? { answer: f, method: 'szkoła: gramatyka' } : null
  }
  // „Dopisz … formy … Liczba pojedyncza / Liczba mnoga: gitara”
  m = /liczba mnoga:\s*([\p{L}]+)\.?$/iu.exec(t.trim()) ?? /(?:liczb\p{L}* mnog\p{L}*|w liczbie mnogiej)[^.]*\.\s*([\p{L}]+)\.?$/iu.exec(t.trim())
  if (m && /(dopisz|utwórz|podaj|zapisz)/iu.test(t)) {
    ctx.trace.push({ kind: 'rozbiór', text: `„${m[1]}” → mianownik liczby mnogiej` })
    const f = inflect(low(m[1]), 'pl', 'nom', ctx)
    return f ? { answer: f, method: 'szkoła: gramatyka' } : null
  }
  return null
}

export function grammar(text: string, ctx: NumCtx): NumResult | null {
  const t = text.replace(/\s+/g, ' ').trim()
  for (const f of [forms, partOfSpeech, gender, number]) {
    const mark = ctx.trace.length
    try {
      const r = f(t, ctx)
      if (r) return r
    } catch {
      ctx.trace.splice(mark)
    }
  }
  return null
}
