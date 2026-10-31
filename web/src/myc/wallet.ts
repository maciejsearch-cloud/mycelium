// Mycelium Wallet – testowy token MYC-test (BEZ WARTOŚCI: nie da się go kupić, sprzedać ani wypłacić). docs/wallet.md
//
// Klucz Ed25519 powstaje w tej przeglądarce (tweetnacl, losowość z crypto.getRandomValues) i NIGDY jej nie opuszcza:
// ziarno (32 B) jest szyfrowane hasłem (PBKDF2-SHA256 600 000 rund → AES-GCM 256) i zapisane w IndexedDB.
// Serwer zna tylko klucz publiczny. Kopia zapasowa = kod MYCW1-… (ziarno + suma kontrolna) pokazany na żądanie.
// Przelew podpisuje przeglądarka: MYC-TEST/v1|transfer|from|to|amount|nonce|ts_ms|memo (ta sama treść w bazie i w węźle).
import nacl from 'tweetnacl'
import { account } from './account'
import { SB_KEY, SB_URL } from './store'

export const UNIT = 100 // 1 MYC-test = 100 jednostek
export const HEX64 = /^[0-9a-f]{64}$/
export const MEMO_RX = /^[\p{L}\p{N} .,:!?#_+-]{0,64}$/u

export const fmtMyc = (u: number | null | undefined, en = false) =>
  ((u ?? 0) / UNIT).toLocaleString(en ? 'en-GB' : 'pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** „1,5” / „1.50” → 150 jednostek; null, gdy kwota zła. */
export function parseAmount(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null
  const [i, f = ''] = t.split('.')
  const u = Number(i) * UNIT + Number((f + '00').slice(0, 2))
  return u >= 1 ? u : null
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))
const enc = new TextEncoder()

export function txBody(kind: 'transfer' | 'mint', from: string, to: string, amount: number, nonce: number, ts: number, memo: string) {
  return ['MYC-TEST/v1', kind, from, to, String(amount), String(nonce), String(ts), memo].join('|')
}

// ------------------------------------------------------------------ kod kopii zapasowej (base32 Crockford, suma SHA-256)
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function b32(bytes: Uint8Array): string {
  let bits = 0
  let v = 0
  let out = ''
  for (const b of bytes) {
    v = ((v << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31]
  return out
}
function unb32(s: string): Uint8Array {
  const out: number[] = []
  let bits = 0
  let v = 0
  for (const c of s) {
    const i = B32.indexOf(c)
    if (i < 0) throw new Error('bad-backup')
    v = ((v << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))
}
export async function backupCode(seed: Uint8Array): Promise<string> {
  const sum = (await sha256(seed)).slice(0, 2)
  const all = new Uint8Array([...seed, ...sum])
  return 'MYCW1-' + (b32(all).match(/.{1,5}/g) ?? []).join('-')
}
export async function seedFromBackup(code: string): Promise<Uint8Array> {
  const s = code.trim().toUpperCase().replace(/^MYCW1-?/, '').replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  const all = unb32(s)
  if (all.length < 34) throw new Error('bad-backup')
  const seed = all.slice(0, 32)
  const sum = (await sha256(seed)).slice(0, 2)
  if (sum[0] !== all[32] || sum[1] !== all[33]) throw new Error('bad-backup')
  return seed
}

// ------------------------------------------------------------------ zaszyfrowany klucz w IndexedDB
type Stored = { acc: string; pub: string; salt: string; iv: string; ct: string; iter: number; created: number }
const ITER = 600_000

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('myc-wallet', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('keys', { keyPath: 'acc' })
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbDo<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb()
  return new Promise((res, rej) => {
    const tx = db.transaction('keys', mode)
    const r = f(tx.objectStore('keys'))
    tx.oncomplete = () => (db.close(), res(r.result))
    tx.onerror = () => (db.close(), rej(tx.error))
  })
}
async function aesKey(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}
export async function storedKey(acc: string): Promise<Stored | undefined> {
  return idbDo('readonly', (s) => s.get(acc) as IDBRequest<Stored | undefined>)
}
async function saveSeed(acc: string, seed: Uint8Array, pass: string): Promise<Stored> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const k = await aesKey(pass, salt, ITER)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, seed as BufferSource))
  const pub = toHex(nacl.sign.keyPair.fromSeed(seed).publicKey)
  const row: Stored = { acc, pub, salt: toHex(salt), iv: toHex(iv), ct: toHex(ct), iter: ITER, created: Date.now() }
  await idbDo('readwrite', (s) => s.put(row))
  return row
}
export async function forgetKey(acc: string) {
  await idbDo('readwrite', (s) => s.delete(acc))
  lock()
}

// odblokowany klucz tylko w pamięci karty, automatyczna blokada po 5 min
let unlocked: { acc: string; seed: Uint8Array; until: number } | null = null
let lockTimer: ReturnType<typeof setTimeout> | undefined
const subs = new Set<() => void>()
let ver = 0
const emit = () => {
  ver++
  for (const f of subs) f()
}
export const walletEvents = {
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  version: () => ver,
}
export function lock() {
  if (unlocked) unlocked.seed.fill(0)
  unlocked = null
  clearTimeout(lockTimer)
  emit()
}
export const isUnlocked = (acc: string) => !!unlocked && unlocked.acc === acc && unlocked.until > Date.now()
function keep(acc: string, seed: Uint8Array) {
  unlocked = { acc, seed, until: Date.now() + 5 * 60_000 }
  clearTimeout(lockTimer)
  lockTimer = setTimeout(lock, 5 * 60_000)
  emit()
}
export async function unlock(acc: string, pass: string): Promise<void> {
  const st = await storedKey(acc)
  if (!st) throw new Error('no-key')
  const k = await aesKey(pass, fromHex(st.salt), st.iter)
  let seed: Uint8Array
  try {
    seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(st.iv) as BufferSource }, k, fromHex(st.ct) as BufferSource))
  } catch {
    throw new Error('bad-pass')
  }
  keep(acc, seed)
}
function seedFor(acc: string): Uint8Array {
  if (!unlocked || unlocked.acc !== acc || unlocked.until < Date.now()) throw new Error('locked')
  return unlocked.seed
}
export async function revealBackup(acc: string): Promise<string> {
  return backupCode(seedFor(acc))
}

// ------------------------------------------------------------------ serwer
export type WalletMe = { pub: string | null; room?: string; balance?: number; nonce?: number; pending_in?: number; faucet_next?: string | null; old: string[]; tx?: number }
export type Tx = {
  id: number
  kind: 'mint' | 'transfer'
  from_pub: string | null
  to_pub: string
  amount: number
  nonce: number
  ts_ms: number
  memo: string
  sig: string
  prev_hash: string
  hash: string
  block: number | null
  created_at: string
}
export type Block = {
  height: number
  prev_hash: string
  merkle_root: string
  first_id: number
  last_id: number
  n_tx: number
  last_tx_hash: string
  created_ms: number
  hash: string
  pow_bits: number
  final_at: string | null
  disputed: boolean
  created_at: string
}
export type Attest = { height: number; node_id: string; ok: boolean; matches: boolean; reason: string; n_tx: number; n_sig: number; ms: number; backend: string; eligible: boolean; created_at: string }
export type Dir = { pub: string; handle: string; room: string; active: boolean }

export class WalletError extends Error {}

async function pub<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  const txt = await r.text()
  const j = txt ? (JSON.parse(txt) as unknown) : null
  if (!r.ok) throw new WalletError(String((j as { message?: string } | null)?.message ?? r.status).replace(/^myc: /, ''))
  return j as T
}
export const rest = <T>(path: string) => pub<T>(path)
const rpcPublic = <T>(fn: string, args: Record<string, unknown>) => pub<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })

export const walletMe = () => account.rpc<WalletMe | null>('myc_wallet_me')
export const faucet = () => account.rpc<WalletMe>('myc_wallet_faucet_claim')

/** Nowy portfel: klucz z tej przeglądarki, zaszyfrowany hasłem; rejestracja klucza publicznego z podpisem. */
export async function createWallet(acc: string, pass: string, seed?: Uint8Array): Promise<WalletMe> {
  const s = seed ?? nacl.randomBytes(32)
  const kp = nacl.sign.keyPair.fromSeed(s)
  const pubHex = toHex(kp.publicKey)
  const sig = toHex(nacl.sign.detached(enc.encode(['MYC-TEST/v1', 'register', acc, pubHex].join('|')), kp.secretKey))
  kp.secretKey.fill(0)
  await saveSeed(acc, s, pass)
  const me = await account.rpc<WalletMe>('myc_wallet_register', { p_pub: pubHex, p_sig: sig })
  keep(acc, s)
  return me
}

export async function resolveTarget(t: string): Promise<Dir | { pub: string; handle: null }> {
  const x = t.trim().replace(/^myc-test:/i, '')
  if (HEX64.test(x.toLowerCase())) {
    const d = await rpcPublic<Dir[]>('myc_wallet_dir', { p_pubs: [x.toLowerCase()] })
    return d[0] ?? { pub: x.toLowerCase(), handle: null }
  }
  const d = await rpcPublic<Dir[]>('myc_wallet_dir', { p_handle: x.replace(/^@/, '') })
  if (!d.length) throw new WalletError('no-target')
  return d[0]
}

export async function send(acc: string, from: string, to: string, amount: number, memo: string): Promise<{ id: number; hash: string }> {
  const m = memo.normalize('NFC').trim()
  if (!MEMO_RX.test(m)) throw new WalletError('bad-memo')
  const seed = seedFor(acc)
  const kp = nacl.sign.keyPair.fromSeed(seed)
  if (toHex(kp.publicKey) !== from) throw new WalletError('key-mismatch')
  const bal = await pub<{ nonce: number }[]>(`myc_wallet_bal?select=nonce&pub=eq.${from}`)
  const nonce = (bal[0]?.nonce ?? 0) + 1
  const ts = Date.now()
  const sig = toHex(nacl.sign.detached(enc.encode(txBody('transfer', from, to, amount, nonce, ts, m)), kp.secretKey))
  kp.secretKey.fill(0)
  const r = await rpcPublic<{ id: number; hash: string }>('myc_wallet_send', { p_from: from, p_to: to, p_amount: amount, p_nonce: nonce, p_ts: ts, p_memo: m, p_sig: sig })
  keep(acc, seed) // aktywność przedłuża odblokowanie
  return r
}

export const history = (p: string, limit = 50) =>
  pub<Tx[]>(`myc_wallet_tx?select=*&or=(from_pub.eq.${p},to_pub.eq.${p})&order=id.desc&limit=${limit}`)
export const dir = (pubs: string[]) => (pubs.length ? rpcPublic<Dir[]>('myc_wallet_dir', { p_pubs: [...new Set(pubs)].slice(0, 200) }) : Promise.resolve([] as Dir[]))
export const balanceOf = (p: string) => pub<{ balance: number; nonce: number }[]>(`myc_wallet_bal?select=balance,nonce&pub=eq.${p}`).then((r) => r[0] ?? null)

export type Stats = {
  wallets: number
  tx: number
  height: number
  final_height: number | null
  supply: number
  pending_tx: number
  validators: number
  verify_tx_per_s: number | null
  finality_s_median: number | null
  by_node: { node_id: string; blocks: number; sigs: number; ms: number; eligible: boolean; last: string; backends: string[] }[]
}
export const stats = () => rpcPublic<Stats>('myc_wallet_stats', {})
export const blocks = (limit = 20, before?: number) =>
  pub<Block[]>(`myc_wallet_blocks?select=*&order=height.desc&limit=${limit}${before ? `&height=lt.${before}` : ''}`)
export const attests = (lo: number, hi: number) =>
  pub<Attest[]>(`myc_wallet_attest?select=height,node_id,ok,matches,reason,n_tx,n_sig,ms,backend,eligible,created_at&height=gte.${lo}&height=lte.${hi}&order=created_at.asc`)
export const blockTxs = (h: number) => pub<Tx[]>(`myc_wallet_tx?select=*&block=eq.${h}&order=id.asc&limit=200`)
export const recentTxs = (limit = 20) => pub<Tx[]>(`myc_wallet_tx?select=*&order=id.desc&limit=${limit}`)
export const pendingTxs = () => pub<Tx[]>(`myc_wallet_tx?select=*&block=is.null&order=id.desc&limit=50`)

/** Lokalna kontrola podpisu przelewu (eksplorator: „sprawdź w przeglądarce”). */
export function verifyTx(t: Tx): boolean {
  if (t.kind !== 'transfer' || !t.from_pub) return false
  return nacl.sign.detached.verify(enc.encode(txBody('transfer', t.from_pub, t.to_pub, t.amount, t.nonce, t.ts_ms, t.memo)), fromHex(t.sig), fromHex(t.from_pub))
}

export const shortPub = (p: string) => `${p.slice(0, 6)}…${p.slice(-4)}`
export function mintLabel(memo: string, en: boolean): string {
  if (memo.startsWith('faucet:')) return en ? 'Faucet (once per 20 h)' : 'Kran (raz na 20 h)'
  if (memo.startsWith('reward:pt:')) return en ? `Reward: approved contribution #${memo.split(':')[2]}` : `Nagroda: zatwierdzony wkład #${memo.split(':')[2]}`
  if (memo.startsWith('reward:wa:')) return en ? `Reward: Verify vote (chat answer #${memo.split(':')[2]})` : `Nagroda: głos w Weryfikuj (odpowiedź #${memo.split(':')[2]})`
  if (memo.startsWith('reward:wp:')) return en ? `Reward: Verify vote (parse #${memo.split(':')[2]})` : `Nagroda: głos w Weryfikuj (rozbiór #${memo.split(':')[2]})`
  if (memo.startsWith('reward:spk:')) return en ? `Reward: rated Mycelium post #${memo.split(':')[2]}` : `Nagroda: ocena wpisu Grzybni #${memo.split(':')[2]}`
  return memo
}
