// Anonimowe konto Mycelium AI: Supabase Auth „anonymous sign-in” (bez e-maila, imienia, hasła).
// Sesja (token dostępu + odświeżania) zostaje w localStorage tego urządzenia; na inne urządzenie
// konto przenosi kod odzyskiwania (pokazywany raz, w bazie tylko jego SHA-256).
// Wszystkie zmiany idą przez funkcje bazy (myc_acct_*) – klient nie zapisuje tabel kont bezpośrednio.
import { ids, SB_KEY, SB_URL } from './store'

export type Account = {
  id: string
  room: string
  handle: string
  ref_code: string
  contributor_id: string | null
  created_at: string
  wallet_sol: string | null
  has_recovery: boolean
  recovery_at: string | null
  referred_by: string | null
  referred_at: string | null
  devices: number
  nodes: string[]
  points: Partial<Record<'pending' | 'approved' | 'rejected', number>>
  points_by_source: Record<string, number>
  referrals: number
  referrals_qualified: number
  can_refer: boolean
}

type Session = { access_token: string; refresh_token: string; expires_at: number; user_id: string }
const SK = 'myc.auth'
const REFK = 'myc.pendingRef'
const HEX8 = /^[0-9a-f]{8}$/

export class AccountError extends Error {}

function load(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SK) ?? 'null') as Session | null
    return s && typeof s.access_token === 'string' && typeof s.refresh_token === 'string' ? s : null
  } catch {
    return null
  }
}

/** Kod polecający z linku (?ref=xxxxxxxx) zapamiętany do chwili założenia konta. */
export function captureRef(search = location.search) {
  const r = new URLSearchParams(search).get('ref')?.toLowerCase()
  if (r && HEX8.test(r)) localStorage.setItem(REFK, r)
}
export const pendingRef = () => {
  const r = localStorage.getItem(REFK)
  return r && HEX8.test(r) ? r : ''
}

async function authCall(path: string, body: unknown): Promise<Session> {
  const r = await fetch(`${SB_URL}/auth/v1/${path}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; user?: { id: string }; msg?: string; error_description?: string }
  if (!r.ok || !j.access_token || !j.refresh_token || !j.user) throw new AccountError(j.msg ?? j.error_description ?? `auth ${r.status}`)
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, user_id: j.user.id }
}

class AccountStore {
  session: Session | null = load()
  me: Account | null | undefined = undefined // undefined = jeszcze nie sprawdzono
  error = ''
  private v = 0
  private subs = new Set<() => void>()
  private refreshing: Promise<Session | null> | null = null

  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.v
  private emit() {
    this.v++
    for (const f of this.subs) f()
  }
  private save(s: Session | null) {
    this.session = s
    if (s) localStorage.setItem(SK, JSON.stringify(s))
    else localStorage.removeItem(SK)
  }

  /** Ważny token dostępu (odświeżany ~1 min przed wygaśnięciem) albo null, gdy brak sesji. */
  async token(): Promise<string | null> {
    const s = this.session
    if (!s) return null
    if (s.expires_at - Date.now() > 60_000) return s.access_token
    this.refreshing ??= authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .then((n) => (this.save(n), n))
      .catch((e: unknown) => {
        // unieważniony token odświeżania → sesja tego urządzenia wygasła (konto odzyskasz kodem)
        if (e instanceof AccountError) this.save(null)
        return null
      })
      .finally(() => (this.refreshing = null))
    return (await this.refreshing)?.access_token ?? null
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const tok = await this.token()
    if (!tok) throw new AccountError('no-session')
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const txt = await r.text()
    const j = txt ? (JSON.parse(txt) as unknown) : null
    if (!r.ok) throw new AccountError(String((j as { message?: string } | null)?.message ?? r.status).replace(/^myc: /, ''))
    return j as T
  }

  private async run<T>(f: () => Promise<T>): Promise<T | undefined> {
    this.error = ''
    try {
      return await f()
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      return undefined
    } finally {
      this.emit()
    }
  }

  async refresh() {
    if (!this.session) {
      this.me = null
      this.emit()
      return
    }
    await this.run(async () => {
      this.me = await this.rpc<Account | null>('myc_acct_me')
      if (this.me) await this.linkLocal()
    })
  }

  /** Węzeł tej przeglądarki dołącza do konta automatycznie (pierwsze przypisanie wygrywa). */
  private async linkLocal() {
    if (this.me && !this.me.nodes.includes(ids.node)) {
      const n = await this.rpc<number>('myc_acct_link_nodes', { p_nodes: [ids.node] }).catch(() => 0)
      if (n) this.me = await this.rpc<Account | null>('myc_acct_me')
    }
  }

  private async ensureSession() {
    if (!(await this.token())) this.save(await authCall('signup', {}))
  }

  create(handle: string, room = 'main') {
    return this.run(async () => {
      await this.ensureSession()
      this.me = await this.rpc<Account>('myc_acct_create', { p_handle: handle.trim(), p_contrib: ids.contributor, p_nodes: [ids.node], p_ref: pendingRef() || null, p_room: room })
      localStorage.removeItem(REFK)
    })
  }
  recover(code: string) {
    return this.run(async () => {
      await this.ensureSession()
      this.me = await this.rpc<Account>('myc_acct_recover', { p_code: code.trim() })
      await this.linkLocal()
    })
  }
  setHandle(h: string) {
    return this.run(async () => void (this.me = await this.rpc<Account>('myc_acct_set_handle', { p_handle: h.trim() })))
  }
  refer(code: string) {
    return this.run(async () => void (this.me = await this.rpc<Account>('myc_acct_refer', { p_code: code.trim().toLowerCase() })))
  }
  setWallet(addr: string) {
    return this.run(async () => void (this.me = await this.rpc<Account>('myc_acct_set_wallet', { p_addr: addr.trim() || null })))
  }
  linkNode(id: string) {
    return this.run(async () => {
      const n = await this.rpc<number>('myc_acct_link_nodes', { p_nodes: [id.trim()] })
      if (!n) throw new AccountError('node-taken')
      this.me = await this.rpc<Account>('myc_acct_me')
    })
  }
  /** Kod odzyskiwania – zwracany tylko raz, nie zapisujemy go nigdzie w przeglądarce. */
  newRecovery() {
    return this.run(async () => {
      const c = await this.rpc<string>('myc_acct_recovery_new')
      this.me = await this.rpc<Account>('myc_acct_me')
      return c
    })
  }
  logout(force = false) {
    return this.run(async () => {
      await this.rpc('myc_acct_forget_device', { p_force: force })
      const tok = await this.token()
      if (tok) await fetch(`${SB_URL}/auth/v1/logout`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${tok}` } }).catch(() => undefined)
      this.save(null)
      this.me = null
    })
  }
}

export const account = new AccountStore()

/** Prosta kontrola formatu publicznego adresu Solana (base58, 32 bajty). Klucz prywatny/seed odrzucamy. */
export function solanaAddrOk(s: string): boolean {
  const t = s.trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t)) return false
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const c of t) n = n * 58n + BigInt(A.indexOf(c))
  let bytes = 0
  while (n > 0n) {
    n >>= 8n
    bytes++
  }
  const lead = t.match(/^1*/)?.[0].length ?? 0
  return bytes + lead === 32
}
