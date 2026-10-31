// Mówca „Grzybnia AI” w czacie globalnym (supabase/myc_speaker.sql, docs/speaker.md): stan poziomów, podsumowania
// ocen wpisów i zapis sygnałów od ludzi (ocena sensu, kategoria, typ zadania, etykiety, szyk słów, poprawka, odpowiedź).
import { account } from './account'
import { SB_KEY, SB_URL } from './store'

export interface SpkLevel {
  level: number
  posts: number
  rated: number
  sensible: number
  acc: number | null
}
export interface SpkState {
  enabled: boolean
  interval_s: number
  level: number
  last_post_at: string | null
  levels: SpkLevel[]
  sft: number
  forms_people: number
  votes: number
  opted_out_votes: number
}
export interface SpkVote {
  sense: 1 | -1 | null
  category: string | null
  task_type: string | null
  labels: string[]
  word_order: number[] | null
  fixed: string | null
  answer: string | null
  train_ok: boolean
}
export interface SpkSummary {
  msg_id: number
  level: number
  how: 'losowe' | 'wyuczone' | 'mutacja'
  tokens: string[]
  sense: number
  nonsense: number
  n: number
  category: string | null
  task_type: string | null
  labels: string[] | null
  fixes: { t: string; n: number }[] | null
  answers: { t: string; n: number }[] | null
  mine: SpkVote | null
}
export const LEVEL_NAME: [string, string][] = [
  ['L0 · dwa słowa', 'L0 · two words'],
  ['L1 · krótkie pytania', 'L1 · short questions'],
  ['L2 · pytanie + odpowiedź', 'L2 · question + answer'],
  ['L3 · przypadki (kto/co/komu/gdzie)', 'L3 · cases (who/what/to whom/where)'],
]
export const SPK_TASKS = ['językowe', 'logiczne', 'matematyczne', 'analityczne', 'wzrokowe', 'inne'] as const
export const SPK_CATS = ['pytanie', 'odpowiedź', 'stwierdzenie'] as const

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (account.me) return account.rpc<T>(fn, args)
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}
export const speakerState = () => call<SpkState | null>('myc_speaker_state', {}).then((x) => (x && Array.isArray(x.levels) ? x : null))
export const speakerSummary = (ids: number[]) => (ids.length ? call<SpkSummary[]>('myc_speaker_summary', { p_ids: ids.slice(-200) }).then((x) => (Array.isArray(x) ? x.filter((s) => Array.isArray(s?.tokens)) : [])) : Promise.resolve([]))
export const speakerRate = (msg: number, v: Partial<{ sense: 1 | -1; category: string; task: string; labels: string[]; order: number[]; fixed: string; answer: string }>) =>
  account.rpc('myc_speaker_rate', {
    p_msg: msg,
    p_sense: v.sense ?? null,
    p_category: v.category ?? null,
    p_task: v.task ?? null,
    p_labels: v.labels ?? null,
    p_order: v.order ?? null,
    p_fixed: v.fixed ?? null,
    p_answer: v.answer ?? null,
  })
export const speakerAdmin = (action: 'pause' | 'resume' | 'interval' | 'level' | 'purge' | 'remove', value?: number) =>
  account.rpc<SpkState>('myc_speaker_admin', { p_action: action, p_value: value ?? null })
/** słowa bez końcowej interpunkcji (do układania szyku) */
export const bare = (t: string) => t.replace(/[?.!]+$/, '')
