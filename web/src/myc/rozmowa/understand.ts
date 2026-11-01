// Rozbiór wiadomości czatu: warstwa czatowa nad modelem rozbioru grzybni (rozbior.ts + Morfeusz 2, morf.ts).
// Kroki: (1) zwroty – wołacz „grzybnio”, @pseudonim, imię na początku – są zdejmowane przed rozbiorem i zapisywane,
// (2) końcówki czasu przeszłego („srałaś” → „srała” + „ś”), których model nie rozdzielił, są rozdzielane jak w UD,
// (3) model rozbioru daje lematy, części mowy, cechy i zależności, (4) z drzewa czytamy orzeczenie, osobę, tryb, czas,
// podmiot, dopełnienie, typ pytania, (5) leksykon Słowosieci (CC BY 4.0) + jawne listy (lexicon.ts) dają emocje i akty mowy.
import type { UTok } from '../rozbior'
import type { Act, Emotion, Lexicons, MiniTok, Mood, ParseFn, QType, Tense, TokenizeFn, Understanding } from './types'
import {
  ABILITY_VERBS, APOLOGY, BODY_NOUNS, BODY_VERBS, GREETINGS, HOSTILE_VERBS, INSULT_PHRASES, INSULTS, JOKE_STEMS, JOKE_WORDS, ME_ANY, ME_VOC, NAMES, PRAISE,
  PRESENCE_VERBS, RELATION_VERBS, SAY_VERBS, SELF_VERBS, STATE_EXTRA, VULGAR,
} from './lexicon'

const WH: Record<string, QType> = {
  kto: 'kto', kogo: 'kto', komu: 'kto', kim: 'kto',
  co: 'co', czego: 'co', czym: 'co',
  gdzie: 'gdzie', kiedy: 'kiedy', jak: 'jak', ile: 'ile', ilu: 'ile',
  dlaczego: 'dlaczego', czemu: 'dlaczego', czemuż: 'dlaczego',
  jaki: 'jaki', jaka: 'jaki', jakie: 'jaki', jakiego: 'jaki', jakiej: 'jaki', jakim: 'jaki', jakich: 'jaki',
  który: 'który', która: 'który', które: 'który', którego: 'który', której: 'który',
  czyj: 'czyj', czyja: 'czyj', czyje: 'czyj', skąd: 'skąd', dokąd: 'dokąd',
}
const EMO_ORDER: Emotion[] = ['radość', 'zaufanie', 'oczekiwanie', 'zaskoczenie', 'smutek', 'złość', 'strach', 'wstręt']
const PUNCT = /^[.,!?;:…"„”'()\-–—]+$/
const SECOND = new Set(['ty', 'cię', 'ciebie', 'tobie', 'tobą', 'ci', 'dzięki', 'sorry', 'wy', 'was', 'wam'])
const FIRST_OBJ = new Set(['mnie', 'mną', 'mi', 'mi'])
const STOP = new Set(['być', 'mieć', 'ten', 'to', 'się', 'nie', 'tak', 'ja', 'ty', 'on', 'ona', 'my', 'wy', 'oni', 'co', 'kto', 'jak', 'czy', 'ale', 'i', 'a', 'w', 'na', 'z', 'do', 'o', 'że', 'bo', 'grzybnia', 'grzybnio', 'dziś', 'dzisiaj', 'teraz', 'tu', 'tam', 'już', 'jeszcze', 'znowu', 'bardzo', 'strasznie'])

/** Opcje rozbioru: pseudonimy z ostatnich wiadomości (zwrot do osoby), czy to odpowiedź na wpis grzybni. */
export interface UnderstandOpts {
  handles?: string[]
  replyToAi?: boolean
}

/** Rozdziela formę czasu przeszłego z końcówką osobową (konwencja UD: „zdał” + „em”). Zwraca [rdzeń, końcówka, osoba]. */
export function splitClitic(form: string): [string, string, 1 | 2] | undefined {
  const lw = form.toLowerCase()
  let m = /^(.{2,}ł)(em|eś)$/.exec(lw)
  if (m) return [form.slice(0, m[1].length), form.slice(m[1].length), m[2] === 'em' ? 1 : 2]
  m = /^(.{2,}ł[ao])(m|ś)$/.exec(lw)
  if (m) return [form.slice(0, m[1].length), form.slice(m[1].length), m[2] === 'm' ? 1 : 2]
  m = /^(.{2,}(?:li|ły))(śmy|ście)$/.exec(lw)
  if (m) return [form.slice(0, m[1].length), form.slice(m[1].length), m[2] === 'śmy' ? 1 : 2]
  return undefined
}

const IRREG_PAST: Record<string, string> = {
  jadł: 'jeść', jadła: 'jeść', zjadł: 'zjeść', zjadła: 'zjeść', szedł: 'iść', szła: 'iść', poszedł: 'pójść', poszła: 'pójść',
  wyszedł: 'wyjść', wyszła: 'wyjść', przyszedł: 'przyjść', przyszła: 'przyjść', mógł: 'móc', mogła: 'móc', biegł: 'biec', biegła: 'biec',
  piekł: 'piec', piekła: 'piec', wziął: 'wziąć', wzięła: 'wziąć', zaczął: 'zacząć', zaczęła: 'zacząć', umarł: 'umrzeć', umarła: 'umrzeć',
  usnął: 'usnąć', usnęła: 'usnąć', zasnął: 'zasnąć', zasnęła: 'zasnąć', rósł: 'rosnąć', rosła: 'rosnąć',
}
const IA_AC = new Set(['bał', 'bała', 'grał', 'grała', 'stał', 'stała', 'spał', 'spała', 'wyspał', 'wyspała', 'czekał', 'czekała', 'kiwał', 'kiwała'])
/** Lemat formy czasu przeszłego (rdzeń bez końcówki osobowej) – słownik form, a gdy go brak: reguły polskiej odmiany. */
export function pastLemma(stem: string, lex?: Lexicons): string | undefined {
  const s = stem.toLowerCase()
  const a = lex?.forms?.analyses(s).find(([, t]) => t.startsWith('praet'))
  if (a) return a[0]
  if (IRREG_PAST[s]) return IRREG_PAST[s]
  const m = /^(.+?)(ł|ła|ło|li|ły)$/.exec(s)
  if (!m) return undefined
  let b = m[1]
  if (/ią$/.test(b) || /ę$/.test(b)) return b.replace(/[ią]+$|ę$/, '') + 'ąć'
  if (/ia$/.test(b) && !IA_AC.has(m[1] + 'ł') && !IA_AC.has(s)) return b.slice(0, -1) + 'eć' // chciał → chcieć, widział → widzieć
  if (/ią$/.test(b)) b = b.slice(0, -1) + 'ą'
  return b + 'ć'
}

function short(t: UTok): string | undefined {
  const f = t.feats ?? {}
  const x = [f.Person ? 'P' + f.Person : '', f.Tense ?? '', f.Mood && f.Mood !== 'Ind' ? f.Mood : '', f.Case ?? '', f.Number === 'Plur' ? 'Pl' : ''].filter(Boolean).join(',')
  return x || undefined
}

/** Główna funkcja: rozumienie jednej wiadomości. */
export function understand(text: string, tokenize: TokenizeFn, parse: ParseFn, lex: Lexicons = {}, opts: UnderstandOpts = {}): Understanding {
  const raw = tokenize(text.trim().slice(0, 600)).slice(0, 80)
  const why: string[] = []
  let addressed = !!opts.replyToAi
  let toOther: string | undefined
  let greet = false
  const handles = new Set((opts.handles ?? []).map((h) => h.toLowerCase()))
  // (1) zwroty
  const keep: string[] = []
  const isGreet = (w: string) => GREETINGS.has(w.toLowerCase())
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]
    const lw = w.toLowerCase()
    if (w === '@' && raw[i + 1]) {
      toOther ??= raw[i + 1]
      i++
      if (raw[i + 1] === ',') i++
      continue
    }
    if (/^@\S+/.test(w)) {
      toOther ??= w.slice(1)
      continue
    }
    const vocLike = ME_VOC.test(lw) || (ME_ANY.test(lw) && (raw[i + 1] === ',' || raw[i + 1] === '?' || raw[i + 1] === '!' || i === raw.length - 1 || (i === 0 && raw.length === 1) || (keep.length > 0 && keep.every(isGreet))))
    if (vocLike) {
      addressed = true
      why.push('zwrot: ' + w)
      while (keep.length && isGreet(keep[keep.length - 1])) (greet = true), keep.pop()
      if (raw[i + 1] === ',') i++
      if (raw[i + 1] === '?' && keep.length === 0 && i + 2 >= raw.length) keep.push('?')
      continue
    }
    if (ME_ANY.test(lw)) addressed = true
    keep.push(w)
  }
  while (keep.length && keep[0] && PUNCT.test(keep[0]) && keep[0] !== '?') keep.shift()
  // imię / pseudonim na początku = zwrot do innej osoby (gdy w zdaniu jest 2. osoba, przecinek albo „dzięki”)
  if (!toOther && !addressed && keep.length > 1) {
    const w0 = keep[0]
    const l0 = w0.toLowerCase()
    const cap = /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(w0)
    const known = handles.has(l0) || NAMES.has(l0)
    const second = keep[1] === ',' || keep.some((w) => SECOND.has(w.toLowerCase())) || keep.slice(1).some((w) => (lex.forms?.analyses(w.toLowerCase()) ?? []).some(([, t]) => /:sec(:|$)/.test(t)) || /(sz|esz|isz|ysz|asz|esz)$/.test(w.toLowerCase()) && (lex.forms?.analyses(w.toLowerCase()) ?? []).length === 0)
    if (cap && known && second) {
      toOther = w0
      keep.shift()
      if (keep[0] === ',') keep.shift()
    }
  }
  for (const w of keep) if (isGreet(w)) greet = true
  // (2) końcówki osobowe czasu przeszłego
  const forms: string[] = []
  const cliticPerson: Record<number, 1 | 2> = {}
  for (const w of keep) {
    const sp = splitClitic(w)
    const known = (lex.forms?.analyses(w.toLowerCase()) ?? []).length > 0
    if (sp && !known) {
      forms.push(sp[0])
      cliticPerson[forms.length - 1] = sp[2]
      forms.push(sp[1])
      continue
    }
    forms.push(w)
  }
  const content = forms.filter((w) => !PUNCT.test(w))
  const toks: UTok[] = content.length ? parse(forms) : []
  // (3) poprawki lematów: formy spoza słownika (np. „srała”) – reguły czasu przeszłego
  toks.forEach((t, i) => {
    const lw = t.form.toLowerCase()
    if (cliticPerson[i] !== undefined) {
      const l = pastLemma(lw, lex)
      if (l) t.lemma = l
      t.upos = 'VERB'
      t.feats = { ...(t.feats ?? {}), Tense: 'Past', Person: String(cliticPerson[i]), Mood: 'Ind', VerbForm: 'Fin' }
    } else if (cliticPerson[i - 1] !== undefined) {
      t.upos = 'AUX'
      t.deprel = 'aux:clitic'
      t.lemma = 'być'
    }
    if (APOLOGY.has(lw) || lw === 'dzięki' || lw === 'sorry' || lw === 'sory') t.lemma = lw === 'dzięki' ? 'dzięki' : APOLOGY.has(lw) && lw.startsWith('przeprasz') ? 'przepraszać' : lw
  })
  const L = (t?: UTok) => (t?.lemma ?? t?.form ?? '').toLowerCase()
  const F = (t?: UTok) => (t?.form ?? '').toLowerCase()
  const kids = (i: number) => toks.map((t, j) => [t, j] as const).filter(([t]) => t.head === i + 1)
  const isFinite = (t: UTok) => {
    const f = t.feats ?? {}
    if (!(t.upos === 'VERB' || t.upos === 'AUX')) return false
    if (!(f.VerbForm === 'Fin' || f.Mood === 'Imp' || f.Tense === 'Past')) return false
    if (!lex.forms) return true
    const an = lex.forms.analyses(F(t))
    return an.length === 0 ? cliticPerson[toks.indexOf(t)] !== undefined || /(ę|esz|isz|ysz|asz|esz|em|isz|my|cie|ą|ał|ała|ił|iła|ył|yła)$/.test(F(t)) : an.some(([, tag]) => /^(fin|impt|praet|bedzie|winien|aglt)/.test(tag))
  }
  // (4) orzeczenie: korzeń, jeśli jest czasownikiem osobowym; inaczej łącznik „być” przy korzeniu; inaczej pierwszy czasownik osobowy
  const root = toks.findIndex((t) => t.head === 0)
  let pi = -1
  if (root >= 0 && isFinite(toks[root]) && L(toks[root]) !== 'być') pi = root
  if (pi < 0 && root >= 0) {
    const cop = kids(root).find(([t]) => (t.deprel.startsWith('cop') || t.deprel.startsWith('aux')) && L(t) === 'być' && t.deprel !== 'aux:clitic')
    if (cop) pi = cop[1]
    else if (L(toks[root]) === 'być' && isFinite(toks[root])) pi = root
  }
  if (pi < 0) pi = toks.findIndex((t) => isFinite(t) && t.deprel !== 'aux:clitic' && !(t.deprel.startsWith('aux') && L(t) === 'być' && toks.some((u) => isFinite(u) && L(u) !== 'być')))
  const P = pi >= 0 ? toks[pi] : undefined
  const head = P ? (P.deprel.startsWith('cop') || P.deprel.startsWith('aux') ? P.head - 1 : pi) : root
  const pf = P?.feats ?? {}
  let person: 1 | 2 | 3 | undefined = pf.Person ? (Number(pf.Person) as 1 | 2 | 3) : undefined
  const clit = toks.findIndex((t) => t.deprel === 'aux:clitic' && (t.head - 1 === pi || t.head - 1 === head))
  if (clit >= 0) person = (Number(toks[clit].feats?.Person) as 1 | 2) || person
  if (cliticPerson[pi] !== undefined) person = cliticPerson[pi]
  if (P && !person && pf.Tense === 'Past') person = 3
  const mood: Mood | undefined = P ? (pf.Mood === 'Imp' ? 'imp' : pf.Mood === 'Cnd' || toks.some((t) => F(t) === 'by' || F(t) === 'byś' || F(t) === 'bym') ? 'cond' : 'ind') : undefined
  let tense: Tense | undefined = P && mood !== 'imp' ? (pf.Tense === 'Past' ? 'past' : pf.Tense === 'Fut' ? 'fut' : 'pres') : undefined
  if (P && L(P) === 'być' && /^(będ)/.test(F(P))) tense = 'fut'
  const neg = toks.some((t, j) => F(t) === 'nie' && (t.head - 1 === pi || t.head - 1 === head || j + 1 === pi))
  const deps = head >= 0 ? kids(head) : []
  const pdeps = pi >= 0 && pi !== head ? kids(pi) : []
  const sTok = [...deps, ...pdeps].find(([t]) => t.deprel.startsWith('nsubj'))?.[0]
  const subj = sTok ? (sTok.upos === 'PRON' ? F(sTok) : sTok.upos === 'PROPN' || sTok.upos === 'X' ? sTok.form : L(sTok)) : undefined
  const oTok = [...deps, ...pdeps].find(([t]) => t.deprel === 'obj')?.[0]
  const obj = oTok ? L(oTok) : undefined
  // fraza przyimkowa – oryginalne formy poddrzewa (do pytań zwrotnych: „A jak było w kinie?”)
  let phrase: string | undefined
  const rootCase = P && P.deprel.startsWith('cop') && head >= 0 && toks.some((u) => u.head === head + 1 && u.deprel === 'case') ? ([toks[head], head] as const) : undefined
  const ob = rootCase ?? [...deps, ...pdeps].find(([t, j]) => t.deprel.startsWith('obl') && toks.some((u) => u.head === j + 1 && u.deprel === 'case'))
  if (ob) {
    const sub = new Set<number>([ob[1]])
    let grew = true
    while (grew) {
      grew = false
      toks.forEach((t, j) => {
        if (!sub.has(j) && sub.has(t.head - 1) && !PUNCT.test(t.form) && !(rootCase && (t.deprel.startsWith('cop') || t.deprel.startsWith('nsubj') || t.deprel === 'advmod' || t.deprel === 'aux:clitic'))) (sub.add(j), (grew = true))
      })
    }
    const idx = [...sub].sort((a, b) => a - b)
    phrase = toks.slice(idx[0], idx[idx.length - 1] + 1).map((t) => t.form).join(' ')
  }
  // typ pytania
  const qm = /\?\s*$/.test(text.trim()) || keep.includes('?')
  let qtype: QType | undefined
  const firstWords = toks.filter((t) => !PUNCT.test(t.form)).slice(0, 3)
  for (const t of firstWords) {
    const q = WH[F(t)]
    if (q && (qm || t === firstWords[0])) {
      qtype = q
      break
    }
  }
  if (!qtype && (qm || F(firstWords[0]) === 'czy')) qtype = 'tak/nie'
  const question = !!qtype
  // (5) treść, emocje
  const lemmas = toks.map(L)
  const formsL = toks.map(F)
  const has = (set: Set<string>) => toks.some((t) => set.has(L(t)) || set.has(F(t)))
  const contentL = [...new Set(toks.filter((t) => ['NOUN', 'PROPN', 'ADJ', 'VERB'].includes(t.upos) && !STOP.has(L(t)) && L(t).length > 2).map(L))].slice(0, 12)
  let polarity = 0
  let mask = 0
  toks.forEach((t, j) => {
    const l = L(t)
    const e = lex.emo?.lem[l] ?? lex.emo?.lem[F(t)]
    const x = STATE_EXTRA[l] ?? STATE_EXTRA[F(t)]
    let p = e ? e[0] : x ? x[0] : 0
    if (e) mask |= e[1]
    if (x) mask |= 1 << EMO_ORDER.indexOf(x[1] as Emotion)
    if (p && (F(toks[j - 1]) === 'nie' || (j === pi && neg))) p = -p
    polarity += p
  })
  const emotions = EMO_ORDER.filter((_, i) => mask & (1 << i))
  // akty mowy
  const acts = new Set<Act>()
  const vulgar = has(VULGAR)
  if (vulgar) acts.add('wulgaryzm')
  // obelga: lemat/forma z listy albo forma odmieniona od rzeczownika z listy (wołacz „idiotko”, „debilu”) – rdzeń ≥ 4 litery
  const insultOf = (t: UTok) => {
    if (INSULTS.has(L(t)) || INSULTS.has(F(t))) return true
    if (!['NOUN', 'ADJ', 'PROPN', 'X', 'ADV', 'VERB'].includes(t.upos)) return false
    const f = F(t)
    for (const w of INSULTS) if (w.length >= 5 && f.length >= w.length - 1 && f.startsWith(w.slice(0, w.length - 1))) return true
    return false
  }
  const insultW = toks.find((t) => insultOf(t) && !(F(toks[toks.indexOf(t) - 1]) === 'nie')) ?? (INSULT_PHRASES.test(text.toLowerCase()) ? toks[0] : undefined)
  const hostile = P && HOSTILE_VERBS.has(L(P)) && !neg && (formsL.some((w) => SECOND.has(w)) || toks.some((t) => ME_ANY.test(F(t))))
  const twoP = person === 2 || formsL.includes('ty') || formsL.includes('cię') || formsL.includes('ciebie')
  const aboutMe = toks.some((t) => ME_ANY.test(F(t)) || L(t) === 'grzybnia')
  if (insultW) why.push('obelga: ' + insultW.form)
  if (addressed && !toOther && ((insultW && !neg && (twoP || aboutMe || person === undefined || person === 3)) || hostile)) acts.add('obraza')
  if (toOther && (insultW || hostile) && !neg) acts.add('obraza_innego')
  if (has(APOLOGY)) acts.add('przeprosiny')
  const firstObj = formsL.some((w) => FIRST_OBJ.has(w))
  const praiseW = toks.some((t) => PRAISE.has(L(t)) || PRAISE.has(F(t)))
  const pLemma = L(P)
  if (addressed && !toOther && !acts.has('obraza') && !acts.has('przeprosiny')) {
    if (has(JOKE_WORDS) || JOKE_STEMS.test(text.toLowerCase())) acts.add('żart')
    const xcomp = pi >= 0 ? kids(pi).find(([t]) => t.deprel === 'xcomp')?.[0] : undefined
    const youOrMe = person === 2 || (person === 3 && aboutMe && subj && ME_ANY.test(subj.toLowerCase()))
    const bodyV = (P && BODY_VERBS.has(pLemma)) || (P && ABILITY_VERBS.has(pLemma) && xcomp && BODY_VERBS.has(L(xcomp)))
    const bodyN = toks.some((t) => BODY_NOUNS.has(L(t)) && t.upos === 'NOUN') && P && ['być', 'iść', 'pójść', 'mieć', 'lubić', 'chodzić', 'jechać'].includes(pLemma)
    if ((youOrMe || person === undefined) && (bodyV || bodyN) && !(pLemma === 'lubić' && firstObj)) {
      acts.add('ciało')
      why.push('czynność ciała: ' + (bodyV ? (xcomp && ABILITY_VERBS.has(pLemma) ? L(xcomp) : pLemma) : toks.find((t) => BODY_NOUNS.has(L(t)))!.lemma))
    }
    if (question && P && RELATION_VERBS.has(pLemma) && firstObj && person === 2) acts.add('relacja')
    if (question && P && pLemma === 'być' && person === 1 && pf.Number === 'Plur') acts.add('relacja')
    if (question && P && SAY_VERBS.has(pLemma) && (qtype === 'co' || qtype === 'kto' || qtype === 'kiedy')) acts.add('przypomnienie')
    if (!acts.has('ciało') && !acts.has('relacja') && !acts.has('przypomnienie') && !acts.has('żart') && question && (person === 2 || (aboutMe && person === 3 && pLemma !== 'być'))) {
      if (P && (SELF_VERBS.has(pLemma) || qtype !== 'tak/nie') && !(pLemma === 'być' && !qtype?.match(/kto|co|jaki/) && toks.every((t) => t === P || PUNCT.test(t.form) || ['tu', 'tam', 'czy', 'teraz', 'jeszcze', 'gdzieś', 'tutaj'].includes(F(t)))) && !['żyć', 'słyszeć', 'odezwać'].includes(pLemma)) acts.add('o_mnie')
    }
    if (!question && praiseW && polarity >= 0 && !acts.has('ciało')) {
      if (twoP || person === 1 || !P || formsL.includes('dzięki')) acts.add('komplement')
    }
    if (!acts.size || (acts.size === 1 && acts.has('wulgaryzm') && !question && !praiseW)) {
      const bare = !P || PRESENCE_VERBS.has(pLemma)
      if (bare && toks.filter((t) => !PUNCT.test(t.form) && !['tu', 'tam', 'tutaj', 'czy', 'jeszcze', 'gdzieś', 'mnie', 'się'].includes(F(t)) && t !== P && !ME_ANY.test(F(t))).length === 0) acts.add('wołanie')
    }
  }
  if (!addressed && !toOther && P && pLemma === 'być' && question && (subj === 'ktoś' || formsL.includes('ktoś'))) acts.add('wołanie')
  // stan / emocja osoby (1. os. albo „mi” + przysłówek stanu, „nie chce mi się”, „mam urodziny”)
  const stateLemma = toks.find((t) => (STATE_EXTRA[L(t)] || (lex.emo?.lem[L(t)]?.[0] ?? 0) !== 0 || (lex.emo?.lem[L(t)]?.[1] ?? 0) & 0b11110000) && ['VERB', 'ADJ', 'ADV', 'NOUN'].includes(t.upos) && !INSULTS.has(L(t)) && !VULGAR.has(L(t)))
  const dativeMe = formsL.includes('mi') || formsL.includes('mnie')
  if (!acts.has('obraza') && !acts.has('o_mnie') && !acts.has('ciało') && !acts.has('relacja') && !toOther && !question) {
    const reflexive = pi >= 0 && kids(pi).some(([t]) => F(t) === 'się')
    const stateVerb = P && stateLemma === P && (STATE_EXTRA[pLemma] || reflexive || (lex.emo?.lem[pLemma]?.[0] ?? 0) <= -2)
    const statePred = P && pLemma === 'być' && stateLemma && stateLemma !== P && (stateLemma.head - 1 === head || toks.indexOf(stateLemma) === head) && ['ADJ', 'ADV'].includes(stateLemma.upos)
    const stateHave = P && pLemma === 'mieć' && stateLemma && STATE_EXTRA[L(stateLemma)]
    if ((person === 1 && (stateVerb || statePred || stateHave)) || (dativeMe && stateLemma && (!P || L(P) === 'być' || L(P) === 'chcieć' || L(P) === stateLemma.lemma)) || (P && L(P) === 'chcieć' && neg && dativeMe)) {
      acts.add('stan')
      why.push('stan: ' + (stateLemma?.lemma ?? 'nie chce mi się'))
    }
  }
  if (!question && !acts.has('stan') && !addressed && !toOther && P && (person === 1 || formsL.some((w) => /^(mój|moja|moje|mojego|moim|moja)$/.test(w))) && (tense === 'past' || tense === 'fut' || ['jechać', 'iść', 'uczyć', 'czytać', 'oglądać', 'grać', 'pracować', 'robić'].includes(pLemma))) acts.add('opowieść')
  if (question && !addressed && !toOther && !acts.has('wołanie')) acts.add('pytanie_ogólne')
  if (greet && !acts.size) acts.add('powitanie')
  const conf = toks.length ? toks.reduce((s, t) => s + (t.p ?? 0), 0) / toks.length : 0
  const mini: MiniTok[] = toks.map((t) => ({ f: t.form, l: t.lemma ?? t.form, u: t.upos, d: t.deprel, h: t.head, ...(short(t) ? { x: short(t) } : {}) }))
  return {
    text, addressed, ...(toOther ? { toOther } : {}),
    ...(P ? { pred: pLemma } : {}), ...(person ? { person } : {}), ...(mood ? { mood } : {}), ...(tense ? { tense } : {}), neg,
    ...(subj ? { subj } : {}), ...(obj ? { obj } : {}), ...(phrase ? { phrase } : {}), ...(qtype ? { qtype } : {}), question,
    content: contentL, polarity, emotions, acts: [...acts], why, conf: Math.round(conf * 1000) / 1000, toks: mini,
  }
}
