// Czat globalny grzybni (supabase/myc_gchat.sql): odczyt REST + na żywo przez Supabase Realtime (postgres_changes, RLS),
// zapis tylko przez funkcje bazy jako zalogowane konto (autor i rola liczone na serwerze).
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js'
import { account } from './account'
import { ownerKey, SB_KEY, SB_URL } from './store'

export interface GMsg {
  id: number
  room: string
  circle_id: number | null
  kind: 'user' | 'node'
  handle: string
  role: 'developer' | 'moderator' | null
  body: string | null
  reply_to: number | null
  intent: string | null
  tags: string[]
  pinned: boolean
  deleted: boolean
  created_at: string
}
export interface GMe {
  account: string
  handle: string
  room: string
  role: 'developer' | 'moderator' | null
  owner_device: boolean
  muted_until: string | null
  banned: boolean
  train_ok: boolean
}
export interface GStats {
  messages: number
  today: number
  people: number
  nodes: number
  opted_out: number
}
const FIELDS = 'id,room,circle_id,kind,handle,role,body,reply_to,intent,tags,pinned,deleted,created_at'
export const gchatRoom = (): 'main' | 'e2e' => (new URLSearchParams(location.search).get('room') === 'e2e' || localStorage.getItem('myc.accountRoom') === 'e2e' ? 'e2e' : 'main')

class GChat {
  msgs: GMsg[] = []
  me: GMe | null = null
  stats: GStats | null = null
  roles: { handle: string; role: string }[] = []
  channel: number | null = null
  status: 'idle' | 'loading' | 'live' | 'offline' = 'idle'
  error = ''
  private seq = 0
  private tok = ''
  private liveP?: Promise<void>
  private chRoom = ''
  private rt?: RealtimeClient
  private ch?: RealtimeChannel
  private subs = new Set<() => void>()
  private v = 0
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.v
  emit() {
    this.v++
    for (const f of this.subs) f()
  }

  private async headers(): Promise<Record<string, string>> {
    const tok = await account.token().catch(() => null)
    return tok ? { apikey: SB_KEY, Authorization: `Bearer ${tok}` } : { apikey: SB_KEY }
  }

  async open(channel: number | null = this.channel) {
    this.channel = channel
    this.status = 'loading'
    this.emit()
    const room = gchatRoom()
    const ch = channel == null ? 'circle_id=is.null' : `circle_id=eq.${channel}`
    try {
      const r = await fetch(`${SB_URL}/rest/v1/myc_gchat?select=${FIELDS}&room=eq.${room}&${ch}&order=id.desc&limit=80`, { headers: await this.headers() })
      if (!r.ok) throw new Error(String(r.status))
      this.msgs = ((await r.json()) as GMsg[]).reverse()
      this.error = ''
    } catch (e) {
      this.error = `odczyt: ${(e as Error).message}`
    }
    void this.loadMeta()
    await (this.liveP ??= this.live().finally(() => (this.liveP = undefined)))
    this.emit()
  }

  /** Jeden kanał Realtime na pokój (bez usuwania – usuwanie ostatniego kanału rozłącza gniazdo i gubi zdarzenia).
   *  Przełączanie kanału (globalny / krąg) filtruje zdarzenia po circle_id; RLS w bazie i tak decyduje, co przychodzi. */
  private async live() {
    const tok = await account.token().catch(() => null)
    if (!this.rt) this.rt = new RealtimeClient(SB_URL.replace(/^http/, 'ws') + '/realtime/v1', { params: { apikey: SB_KEY } })
    if (tok && tok !== this.tok) {
      this.tok = tok
      void this.rt.setAuth(tok)
    }
    const room = gchatRoom()
    if (this.ch && this.chRoom === room) {
      if (this.ch.state === 'joined') this.status = 'live'
      return
    }
    this.chRoom = room
    this.ch = this.rt
      .channel(`gchat-${room}-${++this.seq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'myc_gchat', filter: `room=eq.${room}` }, (p) => {
        const m = p.new as GMsg
        if (!m || typeof m.id !== 'number' || (m.circle_id ?? null) !== this.channel) return
        const i = this.msgs.findIndex((x) => x.id === m.id)
        if (i >= 0) this.msgs[i] = m
        else this.msgs = [...this.msgs, m].slice(-200)
        if (p.eventType === 'INSERT' && m.kind === 'user' && this.channel == null && this.stats) this.stats = { ...this.stats, messages: this.stats.messages + 1, today: this.stats.today + 1 }
        this.emit()
      })
      .subscribe((s) => {
        this.status = s === 'SUBSCRIBED' ? 'live' : s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED' ? 'offline' : this.status
        this.emit()
      })
  }

  async loadMeta() {
    const room = gchatRoom()
    const pub = (fn: string, body: unknown) =>
      fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => (r.ok ? r.json() : null))
    const [st, roles] = await Promise.all([pub('myc_gchat_stats', { p_room: room }).catch(() => null), pub('myc_gchat_roles', { p_room: room }).catch(() => null)])
    this.stats = st && typeof (st as GStats).messages === 'number' ? (st as GStats) : null
    this.roles = Array.isArray(roles) ? (roles as { handle: string; role: string }[]) : []
    await this.refreshMe()
    this.emit()
  }

  /** Konto tego urządzenia + automatyczne przypięcie roli Developer, jeśli urządzenie ma zapisany klucz właściciela (Weryfikuj). */
  async refreshMe() {
    if (!account.session) {
      this.me = null
      return
    }
    try {
      this.me = await account.rpc<GMe | null>('myc_gchat_me')
      const k = ownerKey.get()
      if (this.me && k && this.me.role !== 'developer') this.me = await account.rpc<GMe>('myc_gchat_claim_owner', { p_key: k }).catch(() => this.me)
    } catch (e) {
      this.me = null
      this.error = (e as Error).message
    }
    this.emit()
  }

  async claimOwner(key: string) {
    this.me = await account.rpc<GMe>('myc_gchat_claim_owner', { p_key: key.trim() })
    ownerKey.set(key)
    this.emit()
  }

  async post(body: string, intent: string | null, tags: string[], replyTo: number | null) {
    await account.rpc('myc_gchat_post', { p_body: body, p_reply_to: replyTo, p_intent: intent, p_tags: tags, p_circle: this.channel })
  }
  async mod(action: string, msg: number | null, extra: { minutes?: number; role?: string; reason?: string; handle?: string } = {}) {
    await account.rpc('myc_gchat_mod', { p_action: action, p_msg: msg, p_minutes: extra.minutes ?? null, p_role: extra.role ?? null, p_reason: extra.reason ?? null, p_handle: extra.handle ?? null })
    void this.loadMeta()
  }
  modlog() {
    return account.rpc<{ at: string; actor: string; actor_role: string; action: string; msg_id: number | null; target: string | null; detail: Record<string, unknown> }[]>('myc_gchat_modlog', { p_limit: 50 })
  }
  async setTrain(ok: boolean) {
    this.me = await account.rpc<GMe>('myc_gchat_set_train', { p_ok: ok })
    this.emit()
  }
  /** Wyjście ze strony: połączenie zostaje (szybki powrót), widok wraca do kanału globalnego przy następnym wejściu. */
  close() {}
}

export const gchat = new GChat()
