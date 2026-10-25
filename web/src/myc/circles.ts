// Kręgi (supabase/myc_circles.sql): tworzenie/dołączanie kodem, członkowie z zaufaniem liczonym na serwerze
// ze zweryfikowanego wkładu, poręczenia, zarządzanie i zamrażanie (Developer). Wszystko przez funkcje bazy.
import { account } from './account'

export type Spec = 'jezyk' | 'obrazy' | 'logika' | 'zrodla'
export interface CircleLite {
  id: number
  name: string
  about: string | null
  role: 'owner' | 'admin' | 'member'
  frozen: boolean
  frozen_reason: string | null
  spec: Spec | null
  max_size: number
  members: number
  created_at: string
}
export interface CircleMember {
  handle: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
  trust: number
  new: boolean
  me: boolean
  vouched_by: string | null
}
export interface Circle {
  id: number
  name: string
  about: string | null
  frozen: boolean
  frozen_reason: string | null
  spec: Spec | null
  max_size: number
  invite_at: string | null
  my_role: CircleLite['role'] | null
  members: CircleMember[]
  vouches: { voucher: string; newcomer: string; stake: number; status: 'active' | 'released' | 'slashed'; at: string; decided_at: string | null; reason: string | null }[]
  log: { at: string; actor: string | null; action: string; target: string | null; detail: Record<string, unknown> }[]
}
export interface Trust {
  trust: number
  base: number
  approved: number
  rejected: number
  gold_n: number
  gold_ok: number
  active_days_30: number
  witness_30: number
  wrong_votes: number
  right_votes: number
  decay: number
  penalty: number
  new_account: boolean
  stake_out: number
  vouch_bonus: number
  last_active: string | null
}

export const circles = {
  mine: () => account.rpc<CircleLite[]>('myc_circle_mine'),
  get: (id: number) => account.rpc<Circle>('myc_circle_get', { p_circle: id }),
  create: (name: string, about: string, max: number) => account.rpc<{ id: number; invite: string }>('myc_circle_create', { p_name: name, p_about: about || null, p_max: max }),
  join: (code: string) => account.rpc<{ id: number; name?: string; already?: boolean }>('myc_circle_join', { p_code: code.trim().toUpperCase() }),
  leave: (id: number) => account.rpc<{ ok: boolean; deleted?: boolean }>('myc_circle_leave', { p_circle: id }),
  admin: (id: number, action: string, handle?: string | null, value?: string | null) =>
    account.rpc<{ ok: boolean; invite?: string }>('myc_circle_admin', { p_circle: id, p_action: action, p_handle: handle ?? null, p_value: value ?? null }),
  vouch: (id: number, handle: string, stake: number) => account.rpc<{ ok: boolean; stake: number }>('myc_circle_vouch', { p_circle: id, p_handle: handle, p_stake: stake }),
  trustMe: () => account.rpc<Trust>('myc_trust_me'),
  all: () => account.rpc<{ id: number; name: string; frozen: boolean; members: number; messages: number; created_at: string }[]>('myc_circle_all'),
}

export const SPEC_PL: Record<Spec, [string, string]> = {
  jezyk: ['język i slang', 'language & slang'],
  obrazy: ['obrazy', 'images'],
  logika: ['matematyka i logika', 'math & logic'],
  zrodla: ['źródła i fakty', 'sources & fact-checking'],
}
