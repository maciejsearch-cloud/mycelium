// Klient RPC rozmówcy czatu (supabase/myc_rozmowa.sql): źródła odpowiedzi, oceny, rozbiór wiadomości, moja relacja,
// decyzje moderacji (Developer), ukrywanie pozycji Weryfikuj. Implementuje też SelfRelationsApi dla SelfModelu.
import { account } from './account'
import { SB_KEY, SB_URL } from './store'
import type { RelationState, SelfDecision, SelfRelationsApi, Understanding } from './rozmowa/types'

const anon = async <T,>(fn: string, body: unknown): Promise<T> => {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`${fn}: ${r.status}`)
  return r.json() as Promise<T>
}
const authed = <T,>(fn: string, body: Record<string, unknown> = {}) => (account.me ? account.rpc<T>(fn, body) : anon<T>(fn, body))

export interface ReplyMeta {
  source: 'reguła' | 'model' | 'fakt' | 'ludzie' | 'pamięć'
  rule: string
  cite: string | null
  to: number | null
  addressed: boolean
  latency_ms: number | null
  up: number
  down: number
  mine: { sense: number | null; fixed: string | null } | null
}
export interface RozmowaMeta {
  replies: Record<string, ReplyMeta>
  parsed: number[]
}
export const rozmowaMeta = async (ids: number[]): Promise<RozmowaMeta> => {
  const r = await authed<Partial<RozmowaMeta> | null>('myc_rozmowa_meta', { p_ids: ids.slice(-200) })
  return { replies: r && !Array.isArray(r) && r.replies ? r.replies : {}, parsed: Array.isArray(r?.parsed) ? r.parsed : [] }
}
export type StoredParse = Omit<Understanding, 'text'> & { v: number; model: string }
export const rozmowaParse = (id: number) => anon<StoredParse | null>('myc_rozmowa_parse', { p_msg: id })
export const rozmowaRate = (id: number, sense: 1 | -1 | null, fixed?: string) => account.rpc<{ ok: boolean; train_ok: boolean }>('myc_rozmowa_rate', { p_msg: id, p_sense: sense, p_fixed: fixed ?? null })
export interface RozmowaState {
  enabled: boolean
  heartbeat_at: string | null
  online: boolean
  worker_version: string | null
  interject_every_n: number
  interject_min_s: number
  invite_quiet_min: number
  replies: number
  median_latency_ms: number | null
  mem: number
  pairs: number
  pending_decisions: number
}
/** Stan rozmówcy; null, gdy baza nie ma jeszcze tabel rozmówcy (uczciwy brak panelu). */
export const rozmowaState = async () => {
  const r = await anon<RozmowaState | null>('myc_rozmowa_state', {})
  return r && typeof r === 'object' && 'enabled' in r ? r : null
}
export const rozmowaAdmin = (action: string, value?: number) => account.rpc<RozmowaState>('myc_rozmowa_admin', { p_action: action, p_value: value ?? null })
export interface DecisionRow {
  id: number
  at: string
  kind: 'mute_auto' | 'propose' | 'warn'
  handle: string | null
  target: string | null
  minutes: number | null
  reason: string
  evidence: number[]
  status: string
  decided_at: string | null
  decided_by: string | null
  note: string | null
  texts: { id: number; body: string | null; at: string }[] | null
}
export const decisionsList = (status?: string) => account.rpc<DecisionRow[]>('myc_rozmowa_decisions_list', { p_status: status ?? null, p_limit: 50 })
export const decide = (id: number, action: 'accept' | 'reject' | 'revert', note?: string) => account.rpc<{ ok: boolean }>('myc_rozmowa_decide', { p_id: id, p_action: action, p_note: note ?? null })
export interface MyRelation {
  train_ok: boolean
  state: RelationState | null
  events: { at: string; kind: string; msg_id: number | null; excerpt: string | null }[]
}
export const myRelation = () => account.rpc<MyRelation | null>('myc_self_relation_me', { p_handle: null })
export const forgetMe = () => account.rpc<{ ok: boolean; events: number; mem: number }>('myc_self_relation_forget')

// Weryfikuj: ukrywanie pozycji kolejki (Developer albo klucz właściciela)
export const hiddenKeys = (room = 'main') => anon<string[]>('myc_review_hidden_keys', { p_room: room })
export const reviewHide = (key: string | null, type: string, ref: string, reason: string, room = 'main') =>
  authed<{ ok: boolean }>('myc_review_hide', { p_key: key, p_type: type, p_ref: ref, p_reason: reason, p_room: room })
export const reviewRestore = (key: string | null, type: string, ref: string, room = 'main') => authed<{ ok: boolean }>('myc_review_restore', { p_key: key, p_type: type, p_ref: ref, p_room: room })
export interface HiddenRow {
  room: string
  item_type: string
  item_ref: string
  reason: string
  hidden_by: string
  hidden_at: string
  restored_at: string | null
  restored_by: string | null
}
export const hiddenList = (key: string | null, room = 'main') => authed<HiddenRow[]>('myc_review_hidden_list', { p_key: key, p_room: room })

/** Interfejs dla SelfModelu: stan źródła relacji, moja relacja, historia decyzji (bez danych osobowych). */
export const selfRelations: SelfRelationsApi = {
  status: () => anon('myc_self_relations_status', {}),
  mine: async () => (await myRelation())?.state ?? null,
  decisions: (limit = 50) => anon<SelfDecision[]>('myc_self_rel_decisions', { p_limit: limit }),
}

export const SOURCE_PL: Record<string, string> = { reguła: 'reguła', model: 'model językowy', fakt: 'fakt z bazy', ludzie: 'odpowiedź od ludzi', pamięć: 'pamięć czatu' }
