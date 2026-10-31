// Odpowiedzi czatu w Weryfikuj (supabase/myc_answers.sql): zapis na żywo każdej odpowiedzi (bez danych osobowych),
// etykiety do filtrowania, głosy potwierdź / nie zgadzam się / popraw z wagą zaufania; rozstrzygnięte poprawki →
// pamięć wiedzy czatu, odpowiedzi błędne → zestaw „nigdy więcej”. Rezygnacja z nauki: przełącznik w czacie (to urządzenie)
// i ustawienie konta (myc_account_prefs.train_ok, sprawdzane w bazie).
import { account } from './account'
import { meaningRoom } from './meanings'
import { ids, ownerKey, SB_KEY, SB_URL } from './store'

export type AIntent = 'pytanie' | 'emocja' | 'niezgoda' | 'nauka' | 'rozmowa' | 'polecenie'
export type ARegister = 'neutralne' | 'potoczne' | 'wulgarne' | 'obraźliwe' | 'slang' | 'ironiczne'
export type AStatus = 'pending' | 'confirmed' | 'wrong' | 'corrected'
export interface ASource {
  kind: string
  title: string
  url?: string
  votes?: number
}
export interface ChatAnswer {
  id: number
  question: string
  answer: string
  sources: ASource[]
  conf: number | null
  topic: string | null
  category: string | null
  intent: AIntent
  has_source: boolean
  register: ARegister
  act: string | null
  mode: 'lite' | 'mesh' | 'local'
  status: AStatus
  posterior: number
  n_votes: number
  n_confirm: number
  n_corrections: number
  decided_by: string | null
  correction: string | null
  correction_source: string | null
  created_at: string
}

/** Zgoda na użycie moich pytań do nauki (to urządzenie). Domyślnie tak; wyłączenie = nic nie jest zapisywane. */
const TKEY = 'myc.train'
export const trainConsent = {
  get: () => localStorage.getItem(TKEY) !== '0',
  set: (on: boolean) => localStorage.setItem(TKEY, on ? '1' : '0'),
}

/** Usuwa dane osobowe: e-maile, linki, telefony, @pseudonimy, przedstawienie się („mam na imię X”) i znane imię rozmówcy. */
export function scrub(text: string, name?: string): string {
  let t = text
    .replace(/[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}/gu, '[e-mail]')
    .replace(/(https?:\/\/|www\.)\S+/gi, '[link]')
    .replace(/\+?\d[\d ().-]{7,}\d/g, '[telefon]')
    .replace(/(^|\s)@[\p{L}\d_.]{2,}/gu, '$1[pseudonim]')
    .replace(/((?:mam na imi[eę]|nazywam si[eę]|my name is|call me|m[oó]w mi)\s+)[\p{L}-]{2,}/giu, '$1[imię]')
  if (name && name.length >= 2) t = t.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'giu'), '[imię]')
  return t.replace(/\s+/g, ' ').trim()
}

const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
async function rpc<T>(fn: string, body: Record<string, unknown>, auth?: string | null): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: auth ? { ...H, Authorization: `Bearer ${auth}` } : H, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 120)}`)
  return (await r.json()) as T
}

// ograniczenie po stronie przeglądarki (baza ma własny limiter): maks. 10 zapisów na minutę
let stamps: number[] = []
export interface LogIn {
  question: string
  answer: string
  sources: ASource[]
  conf?: number
  topic?: string
  category?: string
  intent: AIntent
  register: ARegister
  act: string
  mode: 'lite' | 'mesh' | 'local'
  name?: string
}
export async function logAnswer(a: LogIn): Promise<{ logged: boolean; id?: number; reason?: string }> {
  if (!trainConsent.get()) return { logged: false, reason: 'optout' }
  const now = Date.now()
  stamps = stamps.filter((t) => now - t < 60_000)
  if (stamps.length >= 10) return { logged: false, reason: 'rate' }
  stamps.push(now)
  const tok = account.session ? await account.token().catch(() => null) : null
  return rpc(
    'myc_answer_log',
    {
      p_node: ids.node,
      p_contrib: ids.contributor,
      p_question: scrub(a.question, a.name).slice(0, 400),
      p_answer: a.answer.slice(0, 2000),
      p_sources: a.sources.filter((s) => s.title).slice(0, 8),
      p_conf: a.conf === undefined ? null : Math.max(0, Math.min(1, a.conf)),
      p_topic: a.topic ?? null,
      p_category: a.category ?? null,
      p_intent: a.intent,
      p_register: a.register,
      p_act: a.act,
      p_mode: a.mode,
      p_room: meaningRoom(),
    },
    tok,
  )
}

export interface AFilter {
  status?: AStatus | 'all'
  intent?: AIntent | ''
  has_source?: '' | 'tak' | 'nie'
  topic?: string
  register?: ARegister | ''
}
const FIELDS = 'id,question,answer,sources,conf,topic,category,intent,has_source,register,act,mode,status,posterior,n_votes,n_confirm,n_corrections,decided_by,correction,correction_source,created_at'
export async function listAnswers(f: AFilter, limit = 30): Promise<ChatAnswer[]> {
  const p = new URLSearchParams({ select: FIELDS, room: `eq.${meaningRoom()}`, order: 'created_at.desc', limit: String(limit) })
  if (f.status && f.status !== 'all') p.set('status', `eq.${f.status}`)
  if (f.intent) p.set('intent', `eq.${f.intent}`)
  if (f.has_source) p.set('has_source', `is.${f.has_source === 'tak'}`)
  if (f.topic) p.set('topic', `eq.${f.topic}`)
  if (f.register) p.set('register', `eq.${f.register}`)
  const r = await fetch(`${SB_URL}/rest/v1/myc_chat_answers?${p}`, { headers: { apikey: SB_KEY } })
  return r.ok ? ((await r.json()) as ChatAnswer[]) : []
}

/** Liczniki do filtrów (z ostatnich 500 odpowiedzi): tematy, intencje, rejestr, źródło, status. */
export async function answerFacets(): Promise<{ n: number; topics: [string, number][]; status: Record<string, number>; errors: number }> {
  const room = meaningRoom()
  const [r, e] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/myc_chat_answers?select=topic,status&room=eq.${room}&order=created_at.desc&limit=500`, { headers: { apikey: SB_KEY } }),
    fetch(`${SB_URL}/rest/v1/myc_error_set?select=id&room=eq.${room}`, { headers: { apikey: SB_KEY, Prefer: 'count=exact', Range: '0-0' } }),
  ])
  const rows = r.ok ? ((await r.json()) as { topic: string | null; status: string }[]) : []
  const t = new Map<string, number>()
  const st: Record<string, number> = {}
  for (const x of rows) {
    if (x.topic) t.set(x.topic, (t.get(x.topic) ?? 0) + 1)
    st[x.status] = (st[x.status] ?? 0) + 1
  }
  const errors = Number(e.headers.get('content-range')?.split('/')[1] ?? 0) || 0
  return { n: rows.length, topics: [...t.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12), status: st, errors }
}

export const voteAnswer = (id: number, vote: 'confirm' | 'disagree' | 'correct', correction?: string, source?: string) =>
  rpc<{ ok: boolean; reason?: string; voter?: string; posterior?: number; status?: AStatus; votes?: number; frag?: number }>('myc_answer_vote', {
    p_key: ownerKey.get() || null,
    p_node: ids.node,
    p_contrib: ids.contributor,
    p_id: id,
    p_vote: vote,
    p_correction: correction ?? null,
    p_source: source ?? null,
    p_agent: false,
  })
