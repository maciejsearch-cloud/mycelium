// Zapis rozmów do nauki – tylko za zgodą (przełącznik), anonimowo (losowy identyfikator węzła i rozmowy).
import { ids, SB_KEY, SB_URL } from './store'

const KEY = 'myc.chatlog'
export const chatConsent = {
  get: () => localStorage.getItem(KEY) === '1',
  set: (on: boolean) => localStorage.setItem(KEY, on ? '1' : '0'),
}
export const convId = crypto.randomUUID()

export async function logExchange(turn: number, user_text: string, reply: string, act: string, mode: 'lite' | 'mesh', lang: 'pl' | 'en'): Promise<boolean> {
  if (!chatConsent.get()) return false
  try {
    const r = await fetch(`${SB_URL}/rest/v1/myc_chats`, {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ node_id: ids.node, conv: convId, turn, user_text: user_text.slice(0, 4000), reply: reply.slice(0, 6000), act, mode, lang }),
    })
    return r.ok
  } catch {
    return false
  }
}

export interface ChatDay {
  day: string
  exchanges: number
  convs: number
  unknown: number
  lite: number
  mesh: number
}
export async function chatStats(): Promise<ChatDay[]> {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/myc_chat_stats`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: '{}' })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as ChatDay[]
}
