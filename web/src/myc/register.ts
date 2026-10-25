// Rejestr słów (wulgarne / potoczne / obraźliwe) z polskiego Wikisłownika (CC BY-SA 4.0) – data/register.json
// (scripts/export_register.py) – i rozpoznawanie krótkich reakcji: niezgoda, obelga, frustracja.
// Cel: na „pierdolisz” czat ma zrozumieć, że to reakcja na jego odpowiedź, a nie pytanie o definicję.

export type Reg = 'wulgarne' | 'potoczne' | 'obraźliwe' | 'ironiczne'
export interface RegEntry {
  w: string
  reg: Reg[]
  defs: { d: string; reg: Reg[]; pos: string }[]
  forms: string[]
}
export interface Register {
  byForm: Map<string, RegEntry>
  n: number
  source: string
  license: string
}
export type ReactionKind = 'disagree' | 'insult' | 'frustration'
export interface Reaction {
  kind: ReactionKind
  word: string
  entry?: RegEntry
  /** znaczenie najlepiej pasujące do reakcji (ze słownika) */
  def?: string
  reg: Reg[]
}

const low = (s: string) => s.toLowerCase().normalize('NFC')

let loading: Promise<Register> | undefined
export function loadRegister(base = import.meta.env.BASE_URL): Promise<Register> {
  return (loading ??= fetch(`${base}data/register.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { entries: RegEntry[]; source: string; license: string }) => buildRegister(d.entries, d.source, d.license))
    .catch((e) => {
      loading = undefined
      throw e
    }))
}

export function buildRegister(entries: RegEntry[], source = '', license = ''): Register {
  const byForm = new Map<string, RegEntry>()
  for (const e of entries) {
    for (const f of [e.w, ...e.forms]) if (!byForm.has(low(f))) byForm.set(low(f), e)
  }
  return { byForm, n: entries.length, source, license }
}

// wzorce reakcji niezależne od słownika (zwroty wielowyrazowe i formy osobowe)
const DISAGREE =
  /^(?:(?:ale |no |co ty )?(?:pierdol\p{L}*|pieprz\p{L}*|chrzan\p{L}*|bredz\p{L}*|bredn\p{L}*|bzdur\p{L}*|ściem\p{L}*|klam\p{L}*|kłam\p{L}*|plecie\p{L}*|pleciesz|gadasz(?: głupoty| bzdury)?|zmyśl\p{L}*|nieprawda|nie prawda|to nieprawda|mylisz się|nie masz racji|źle|to źle|błąd|bez sensu|nonsens|głupoty|co ty gadasz|co ty piszesz|nie tak)|wrong|nonsense|bullshit|you'?re wrong|that'?s wrong|liar|you lie)[\s!.?]*$/iu
const INSULT =
  /^(?:(?:ty |jesteś |ale )?(?:debil\p{L}*|idiot\p{L}*|kretyn\p{L}*|głup\p{L}*|głąb|matoł|baran|dureń|cep|frajer\p{L}*|chuj\p{L}*|kurw\p{L}*|spierdal\p{L}*|wypierdal\p{L}*|spadaj|odwal się|zamknij się|stupid|idiot|moron|dumb|shut up)(?: jesteś| bocie| ai)?)[\s!.?]*$/iu
const FRUST = /^(?:kurde|kurczę|cholera|kurwa(?: mać)?|ja pierdolę|ja pierdole|o matko|masakra|żenada|eh+|ehh+|no nie|nosz|ugh|damn|wtf|ffs|serio\?*|naprawdę\?*)[\s!.?]*$/iu

/** Rozpoznaje krótką reakcję (≤ 5 słów). Zwraca undefined dla pytań i zwykłych wiadomości. */
export function reaction(text: string, reg?: Register): Reaction | undefined {
  const t = low(text.trim())
  const words = t.match(/[\p{L}']+/gu) ?? []
  if (!words.length || words.length > 5) return undefined
  if (/^(co|czy|kto|jak|gdzie|kiedy|dlaczego|ile)\b.*\?$/u.test(t) && !/co ty (gadasz|piszesz)/u.test(t)) return undefined
  const kind: ReactionKind | undefined = INSULT.test(t) ? 'insult' : DISAGREE.test(t) ? 'disagree' : FRUST.test(t) ? 'frustration' : undefined
  // słownik: wulgarne/obraźliwe słowo w krótkiej wiadomości bez pytania to też reakcja
  let hit: RegEntry | undefined
  let word: string = words[0] ?? ''
  for (const w of words) {
    const e = reg?.byForm.get(w)
    if (e && e.reg.some((r) => r === 'wulgarne' || r === 'obraźliwe')) {
      hit = e
      word = w
      break
    }
  }
  if (!kind && !hit) return undefined
  const k: ReactionKind =
    kind ??
    (hit!.defs.some((d) => /wykrzyknik|ekspresyjn|niezadowolen|złość|zdenerwowan/u.test(`${d.pos} ${d.d}`))
      ? 'frustration'
      : hit!.defs.some((d) => /zmyśla|kłam|nieprawd|głupi|bzdur/u.test(d.d))
        ? 'disagree'
        : 'insult')
  if (!hit) {
    for (const w of words) {
      const e = reg?.byForm.get(w)
      if (e) {
        hit = e
        word = w
        break
      }
    }
  }
  const def = hit
    ? (
        hit.defs.find((d) =>
          (k === 'disagree' ? /zmyśla|kłam|nieprawd|głupi|bzdur|niedorzecz/u : k === 'insult' ? /obraź|zwrot|osoba|człowiek/u : /wykrzyknik|ekspres|niezadowol|złość/u).test(`${d.pos} ${d.d}`),
        ) ?? hit.defs[0]
      ).d
    : undefined
  return { kind: k, word, entry: hit, def, reg: hit?.reg ?? [] }
}

/** Rejestr podany w wyjaśnieniu („to wulgarnie znaczy…”, „potocznie…”). */
export function registerOf(text: string): 'neutralne' | 'potoczne' | 'wulgarne' | 'obraźliwe' | 'slang' | 'ironiczne' {
  const t = low(text)
  if (/wulgar|przekleństw|bluzg/u.test(t)) return 'wulgarne'
  if (/obraź|obelg|wyzwisk/u.test(t)) return 'obraźliwe'
  if (/slang|młodzieżow/u.test(t)) return 'slang'
  if (/ironi/u.test(t)) return 'ironiczne'
  if (/potoczn|kolokwial/u.test(t)) return 'potoczne'
  return 'neutralne'
}
