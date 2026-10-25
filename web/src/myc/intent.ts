// Klasyfikator intencji wiadomości (pytanie / emocja / niezgoda / ironia / powitanie / stwierdzenie) i etykiety rejestru.
// Działa w przeglądarce na regułach + słowniku rejestru (Wikisłownik, myc/register.ts) + ZATWIERDZONYCH wzorcach z czatu
// (myc_lang_approved – po głosowaniu w Weryfikuj). Nic nie cenzuruje: wulgaryzm dostaje tylko etykietę.
import { reaction, type Register } from './register'
import { SB_KEY, SB_URL } from './store'

export type Intent = 'pytanie' | 'emocja' | 'niezgoda' | 'stwierdzenie' | 'powitanie' | 'ironia'
export type Tag = 'wulgarne' | 'potoczne' | 'obraźliwe' | 'slang' | 'ironiczne' | 'skrót' | 'emotikon'
export interface LangPattern {
  id: number
  kind: 'skrót' | 'emotikon' | 'wydłużenie' | 'intencja' | 'ironia'
  pattern: string
  label: string
}
export interface IntentResult {
  intent: Intent
  conf: number
  tags: Tag[]
  /** skąd decyzja: reguła, słownik, zatwierdzony wzorzec z czatu */
  why: string
}

const low = (s: string) => s.toLowerCase().normalize('NFC').trim()
const EMOJI = /\p{Extended_Pictographic}/u
const EMOTICON = /(^|\s)(:-?[)(DPpO/|]+|;-?[)D]+|xd+|<3+|\^\^|:3|T_T)(?=\s|$|[!.?,])/iu
const IRONY = /(\/s\b|\bno jasne\b|\bjasne,? jasne\b|\bakurat\b|\bpewnie\.{2,}|\bsuper\.{2,}|\bbrawo\.{2,}|\bgratuluję\.{2,}|\bwow\.{2,}|\bjaa?sne\b|\boczywiście\.{2,}|\bno pewnie\b)/iu
const GREET = /^(hej+|cześć|czesc|siema+|elo+|witam|dzień dobry|dobry wieczór|hello|hi|hey|yo)\b/iu
const QWORD = /^(co|czy|kto|jak|gdzie|kiedy|dlaczego|czemu|ile|który|która|które|jaki|jaka|jakie|po co|skąd|dokąd|what|why|how|who|where|when|is|are|do|does|can)\b/iu
const ABBR = /^(?:[bcćdfghjklłmnńprsśtwzźż]{2,5}|[A-ZĄĆĘŁŃÓŚŹŻ]{2,5})$/u

let approved: Promise<LangPattern[]> | undefined
/** Zatwierdzone wzorce (publiczny widok, tylko status 'approved'). */
export function loadApprovedPatterns(room: 'main' | 'e2e' = 'main'): Promise<LangPattern[]> {
  return (approved ??= fetch(`${SB_URL}/rest/v1/myc_lang_approved?select=id,kind,pattern,label&room=eq.${room}&limit=2000`, { headers: { apikey: SB_KEY } })
    .then((r) => (r.ok ? (r.json() as Promise<LangPattern[]>) : []))
    .catch(() => {
      approved = undefined
      return []
    }))
}

export function classifyIntent(text: string, reg?: Register, pats: LangPattern[] = []): IntentResult {
  const t = low(text)
  const tags = new Set<Tag>()
  const words = text.match(/[\p{L}']+/gu) ?? []
  for (const w of words) {
    const e = reg?.byForm.get(low(w))
    if (e) for (const r of e.reg) tags.add(r)
    if (ABBR.test(w) && !/^(w|z|i|a|o|u)$/iu.test(w)) tags.add('skrót')
  }
  if (EMOJI.test(text) || EMOTICON.test(text)) tags.add('emotikon')
  // 1) zatwierdzona próbka intencji/ironii z czatu (dokładne dopasowanie po normalizacji)
  const exact = pats.find((p) => (p.kind === 'intencja' || p.kind === 'ironia') && low(p.pattern) === t)
  if (exact) {
    if (exact.kind === 'ironia') tags.add('ironiczne')
    return { intent: exact.kind === 'ironia' ? 'ironia' : (exact.label as Intent), conf: 0.95, tags: [...tags], why: 'wzorzec z czatu (zatwierdzony)' }
  }
  for (const p of pats) if (p.kind !== 'intencja' && p.kind !== 'ironia' && words.some((w) => low(w) === p.pattern)) tags.add(p.kind === 'skrót' ? 'skrót' : 'emotikon')
  // 2) krótka reakcja (niezgoda / obelga / frustracja) – ta sama logika co w czacie z AI
  const rx = reaction(text, reg)
  if (rx) return { intent: rx.kind === 'disagree' ? 'niezgoda' : 'emocja', conf: 0.85, tags: [...tags], why: rx.entry ? 'słownik rejestru' : 'reguła reakcji' }
  if (IRONY.test(t)) {
    tags.add('ironiczne')
    return { intent: 'ironia', conf: 0.6, tags: [...tags], why: 'znacznik ironii' }
  }
  // pytajnik na końcu zdania (także przed emotikonem: „działa? xD”) albo słowo pytające na początku
  if (/\?+(\s|$)/.test(t) || QWORD.test(t)) return { intent: 'pytanie', conf: /\?+(\s|$)/.test(t) ? 0.9 : 0.6, tags: [...tags], why: 'reguła pytania' }
  if (GREET.test(t) && words.length <= 4) return { intent: 'powitanie', conf: 0.8, tags: [...tags], why: 'reguła powitania' }
  if (/!{2,}/.test(t) || tags.has('emotikon') || /([\p{L}])\1\1/u.test(t) || (words.length <= 4 && (tags.has('wulgarne') || tags.has('obraźliwe'))))
    return { intent: 'emocja', conf: 0.6, tags: [...tags], why: 'znaki emocji' }
  return { intent: 'stwierdzenie', conf: 0.5, tags: [...tags], why: 'domyślnie' }
}

export const INTENT_PL: Record<Intent, [string, string]> = {
  pytanie: ['pytanie', 'question'],
  emocja: ['emocja', 'emotion'],
  niezgoda: ['niezgoda', 'disagreement'],
  stwierdzenie: ['stwierdzenie', 'statement'],
  powitanie: ['powitanie', 'greeting'],
  ironia: ['ironia', 'irony'],
}
