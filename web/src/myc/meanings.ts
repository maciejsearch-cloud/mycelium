// Znaczenia słów wyjaśnione w czacie (supabase/myc_meanings.sql): zapis → głosowanie (wagi zaufania, właściciel = złoto)
// → dopiero zatwierdzone są używane przez czat i trafiają do strzępków i treningu LM.
import { ids, ownerKey, SB_KEY, SB_URL } from './store'

export type MeaningStatus = 'pending' | 'approved' | 'rejected'
export interface Meaning {
  id: number
  word: string
  meaning: string
  register: string
  example: string | null
  status: MeaningStatus
  posterior: number
  n_votes: number
  n_true: number
  decided_by: string | null
  created_at: string
}
const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
/** Pokój: ?room=e2e (testy na żywo) albo prawdziwa grzybnia. */
export const meaningRoom = (): 'main' | 'e2e' => (new URLSearchParams(location.search).get('room') === 'e2e' ? 'e2e' : 'main')

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 120)}`)
  return (await r.json()) as T
}
const FIELDS = 'id,word,meaning,register,example,status,posterior,n_votes,n_true,decided_by,created_at'

export const addMeaning = (word: string, meaning: string, register: string, example: string, conv?: string, lang: 'pl' | 'en' = 'pl') =>
  rpc<{ id: number; status: MeaningStatus; dup?: boolean }>('myc_meaning_add', {
    p_node: ids.node,
    p_contrib: ids.contributor,
    p_word: word,
    p_meaning: meaning,
    p_register: register,
    p_example: example,
    p_conv: conv ?? null,
    p_lang: lang,
    p_room: meaningRoom(),
  })

export const voteMeaning = (id: number, vote: boolean) =>
  rpc<{
    ok: boolean
    reason?: string
    voter?: string
    posterior?: number
    status?: MeaningStatus
    votes?: number
  }>('myc_meaning_vote', {
    p_key: ownerKey.get() || null,
    p_node: ids.node,
    p_contrib: ids.contributor,
    p_id: id,
    p_vote: vote,
    p_agent: false,
  })

export async function meaningsOf(word: string): Promise<Meaning[]> {
  const w = encodeURIComponent(word.trim().toLowerCase())
  const r = await fetch(`${SB_URL}/rest/v1/myc_meanings?select=${FIELDS}&room=eq.${meaningRoom()}&word=eq.${w}&status=neq.rejected&order=status,posterior.desc&limit=5`, { headers: H })
  return r.ok ? ((await r.json()) as Meaning[]) : []
}

export async function pendingMeanings(limit = 40): Promise<Meaning[]> {
  const r = await fetch(`${SB_URL}/rest/v1/myc_meanings?select=${FIELDS}&room=eq.${meaningRoom()}&status=eq.pending&order=created_at.desc&limit=${limit}`, { headers: H })
  return r.ok ? ((await r.json()) as Meaning[]) : []
}

/** Najlepsze znaczenie słowa: zatwierdzone ma pierwszeństwo, oczekujące tylko jako informacja „czeka na głosowanie”. */
export const bestMeaning = (ms: Meaning[]) => ms.find((m) => m.status === 'approved') ?? ms.find((m) => m.status === 'pending')
