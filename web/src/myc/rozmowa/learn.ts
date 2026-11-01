// Nauka z czatu (tylko wiadomości osób z włączoną nauką – zgodę sprawdza też baza w myc_rozmowa_learn):
//  • krótkie pytania osób → program nauczania mówcy (myc_speaker_chatq, poziom L0/L1, oceny ludzi decydują o sensie),
//  • zdania „X jest Y” / „X to Y” → strzępek wiedzy do Weryfikuj (źródło „chat”, niskie zaufanie, decydują ludzie).
// Czyste funkcje na wyniku understand(); bez sieci.
import type { Act, MiniTok, Understanding } from './types'

/** Akty, przy których nic nie trafia do nauki (obraza, wulgaryzm, żart, pytania o ciało grzybni, relacja). */
const SKIP: Act[] = ['obraza', 'obraza_innego', 'wulgaryzm', 'żart', 'ciało', 'relacja', 'przypomnienie', 'o_mnie']
const PRON = new Set(['ja', 'ty', 'on', 'ona', 'ono', 'my', 'wy', 'oni', 'one', 'to', 'ten', 'ta', 'tamten', 'coś', 'ktoś', 'wszystko', 'nic', 'co', 'kto', 'się'])

export interface CurriculumQ {
  level: 0 | 1
  text: string
}
export interface FactProposal {
  subj: string
  rel: 'jest'
  obj: string
}

const skip = (u: Understanding) => u.acts.some((a) => SKIP.includes(a)) || !!u.toOther || u.why.some((w) => w.startsWith('obelga'))

/** Krótkie pytanie osoby (2–6 słów, bez imion i zwrotów do grzybni) jako forma dla mówcy: L0 = 2 słowa, L1 = 3–6. */
export function curriculumQuestion(u: Understanding): CurriculumQ | null {
  if (!u.question || skip(u) || u.conf < 0.5) return null
  const words = u.toks.filter((t) => t.u !== 'PUNCT')
  if (words.length < 2 || words.length > 6) return null
  if (words.some((t) => t.u === 'PROPN' || t.u === 'NUM' || t.u === 'X' || /[\d@#/]/.test(t.f) || /^grzybni/i.test(t.f))) return null
  const text = words.map((t) => t.f.toLowerCase()).join(' ') + '?'
  if (text.length > 80) return null
  return { level: words.length === 2 ? 0 : 1, text }
}

const kids = (toks: MiniTok[], h: number) => toks.map((t, i) => ({ t, i })).filter((x) => x.t.h === h + 1)

/** „Kot jest zwierzęciem”, „Warszawa jest stolicą Polski”, „Wieloryb to ssak” → {subj, 'jest', obj} (lematy, mianownik).
 * Tylko przynależność do klasy (orzecznik rzeczownikowy) o rzeczach ogólnych: bez zdań o osobach (imiona, pseudonimy
 * z czatu, „mój brat…”) i bez ocen przymiotnikiem – żeby z czatu nie robić „wiedzy” o ludziach. */
export function factProposal(u: Understanding, handles: string[] = []): FactProposal | null {
  if (u.question || u.neg || skip(u) || u.mood !== undefined && u.mood !== 'ind' || u.person === 1 || u.person === 2 || u.conf < 0.5) return null
  if (u.tense && u.tense !== 'pres') return null
  const T = u.toks
  const rootI = T.findIndex((t) => t.h === 0)
  if (rootI < 0) return null
  const ch = kids(T, rootI)
  const cop = ch.find((x) => (x.t.d === 'cop' || x.t.d === 'aux:pass') && (x.t.l === 'być' || x.t.l === 'to'))
  if (!cop) return null
  let subjI: number | undefined
  let predI: number
  if (cop.t.l === 'to') {
    // „X to Y”: parser bywa odwrócony – podmiot to rzeczownik przed „to”, orzecznik po nim
    const before = T.slice(0, cop.i).findIndex((t) => t.u === 'NOUN' || t.u === 'PROPN')
    const after = T.findIndex((t, i) => i > cop.i && (t.u === 'NOUN' || t.u === 'ADJ'))
    if (before < 0 || after < 0) return null
    subjI = before
    predI = after
  } else {
    subjI = ch.find((x) => x.t.d.startsWith('nsubj') && (x.t.u === 'NOUN' || x.t.u === 'PROPN'))?.i
    predI = rootI
    // orzecznik przed łącznikiem („Ola jest głupia” rozbite odwrotnie) – zbyt niepewne
    if (predI < cop.i || (subjI !== undefined && subjI > cop.i)) return null
  }
  if (subjI === undefined || T[predI].u !== 'NOUN') return null
  const s = T[subjI]
  if (s.u !== 'NOUN' || PRON.has(s.l.toLowerCase())) return null
  if (T.some((t) => t.d === 'det:poss' || /^(mój|twój|nasz|wasz|jego|jej|ich|swój)$/i.test(t.l))) return null
  const hs = new Set(handles.map((h) => h.toLowerCase()))
  if (T.some((t, i) => hs.has(t.f.toLowerCase()) || hs.has(t.l.toLowerCase()) || (i > 0 && /^\p{Lu}/u.test(t.f) && t.u !== 'PROPN'))) return null
  // dopełnienia nazwy: przymiotniki i dopełniacze przy podmiocie/orzeczniku, w kolejności zdania
  const phrase = (i: number) => {
    const dep = kids(T, i).filter((x) => ['amod', 'nmod', 'nmod:poss', 'flat', 'compound'].includes(x.t.d) && x.t.u !== 'PUNCT')
    return [{ t: T[i], i, head: true }, ...dep.map((x) => ({ ...x, head: false }))].sort((a, b) => a.i - b.i).map((x) => (x.head ? (x.t.u === 'PROPN' ? cap(x.t.l) : x.t.l) : x.t.f)).join(' ')
  }
  const subj = phrase(subjI)
  const obj = phrase(predI)
  if (!subj || !obj || subj.toLowerCase() === obj.toLowerCase() || subj.length > 80 || obj.length > 120) return null
  return { subj, rel: 'jest', obj }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
