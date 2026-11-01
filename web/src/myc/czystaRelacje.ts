// Relacje dla analogii czystej grzybni: rodzaje, szablony pytań (te same co supabase/myc_rel.sql i
// src/iot_mycelium/mesh/relacje.py – pilnuje scripts/czysta-check.mjs), rozpoznanie zdania-relacji i pytania
// zaproponowane przez mówcę i samouka (myc_rel_questions). Odpowiedzi idą zdaniem przez Weryfikuj – nic tu nie jest
// zatwierdzane automatycznie; rozumujący używa tylko zdań zatwierdzonych (czystaLiczby.ts → analogy).
// Przykłady celowo spoza słownictwa ćwiczeń analogii (selfplay.REL), żeby nie podsuwać odpowiedzi z testu.
import { SB_KEY, SB_URL } from './store'

export type RelKind = 'dom' | 'młode' | 'narzędzie' | 'przeciwieństwo' | 'część' | 'produkt'

export const REL_KINDS: Record<RelKind, { label: string; question: string; pattern: string; examples: [string, string]; re: RegExp; ab: (m: RegExpMatchArray) => [string, string]; starter?: (w: string) => string }> = {
  dom: {
    label: 'dom (gdzie mieszka)',
    question: 'Gdzie mieszka {w}?',
    pattern: '„X mieszka w Y.”',
    examples: ['Niedźwiedź mieszka w gawrze.', 'Bóbr mieszka w żeremiu.'],
    re: /^(\p{L}+) mieszka(?:ją)? (?:w|we|na|pod) (\p{L}+)\.?$/u,
    ab: (m) => [m[1], m[2]],
    starter: (w) => `${cap(w)} mieszka w `,
  },
  młode: {
    label: 'młode',
    question: 'Jak nazywa się młode zwierzęcia „{w}”?',
    pattern: '„Młode X to Y.”',
    examples: ['Młode kozy to koźlę.', 'Młode świni to prosię.'],
    re: /^młode (\p{L}+) (?:to|jest|nazywa się) (\p{L}+)\.?$/u,
    ab: (m) => [m[1], m[2]],
  },
  narzędzie: {
    label: 'narzędzie (czego używa)',
    question: 'Czego używa {w} w pracy?',
    pattern: '„X używa Y.”',
    examples: ['Ogrodnik używa grabi.', 'Kucharz używa noża.'],
    re: /^(\p{L}+) używa(?:ją)? (\p{L}+)(?: w pracy)?\.?$/u,
    ab: (m) => [m[1], m[2]],
    starter: (w) => `${cap(w)} używa `,
  },
  przeciwieństwo: {
    label: 'przeciwieństwo',
    question: 'Co jest przeciwieństwem słowa „{w}”?',
    pattern: '„Przeciwieństwem X jest Y.”',
    examples: ['Przeciwieństwem lata jest zima.', 'Przeciwieństwem radości jest smutek.'],
    re: /^przeciwieństwem (\p{L}+) jest (\p{L}+)\.?$/u,
    ab: (m) => [m[1], m[2]],
  },
  część: {
    label: 'część (czego częścią jest)',
    question: 'Czego częścią jest {w}?',
    pattern: '„X jest częścią Y.”',
    examples: ['Koło jest częścią roweru.', 'Liść jest częścią drzewa.'],
    re: /^(\p{L}+) jest częścią (\p{L}+)\.?$/u,
    ab: (m) => [m[1], m[2]],
    starter: (w) => `${cap(w)} jest częścią `,
  },
  produkt: {
    label: 'produkt (co daje)',
    question: 'Co daje {w}?',
    pattern: '„X daje Y.”',
    examples: ['Koza daje mleko.', 'Jedwabnik daje jedwab.'],
    re: /^(\p{L}+) (?:daje|dają|wytwarza|wytwarzają) (\p{L}+)\.?$/u,
    ab: (m) => [m[1], m[2]],
    starter: (w) => `${cap(w)} daje `,
  },
}
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

export const relQuestion = (k: RelKind, w: string) => REL_KINDS[k].question.replace('{w}', w)

/** Rozpoznanie zdania-relacji po wzorze rodzaju (tylko do podpowiedzi i liczników – rozumujący używa ramy zdania). */
export function recognize(sentence: string, only?: RelKind): { kind: RelKind; a: string; b: string } | null {
  const s = sentence.trim().toLowerCase().replace(/\s+/g, ' ')
  for (const k of Object.keys(REL_KINDS) as RelKind[]) {
    if (only && k !== only) continue
    const m = s.match(REL_KINDS[k].re)
    if (m) {
      const [a, b] = REL_KINDS[k].ab(m)
      return { kind: k, a, b }
    }
  }
  return null
}

export interface RelQuestion {
  id: number
  kind: RelKind
  word: string
  question: string
  proposer: 'mówca' | 'samouk'
  reason: string | null
  voiced_at: string | null
  created_at: string
}

export async function loadRelQuestions(): Promise<RelQuestion[]> {
  const r = await fetch(`${SB_URL}/rest/v1/myc_rel_questions?select=id,kind,word,question,proposer,reason,voiced_at,created_at&room=eq.main&retired_at=is.null&order=created_at.desc&limit=60`, { headers: { apikey: SB_KEY }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`myc_rel_questions: ${r.status}`)
  return (await r.json()) as RelQuestion[]
}
