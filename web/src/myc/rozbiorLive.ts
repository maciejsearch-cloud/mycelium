// Rozbiór zdań na żywo w przeglądarce: opublikowany (niezależnie zweryfikowany) model MYCRB2 z grzybni,
// analiza (części mowy, części zdania, role, zdania składowe) i Walenty (oczekiwane uzupełnienia czasownika).
import { useSyncExternalStore } from 'react'
import { SB_KEY, SB_URL, ids } from './store'
import { analyse, loadModel, predict, routeOf, tokenize, type Analysis, type RbModel, type Route } from './rozbior'
import { select as selectMorf, type MorfLex } from './morf'

export interface RbRow {
  id: number
  version: number
  status: string
  path: string
  f1: number
  upos: number | null
  feats: number | null
  las: number | null
  metrics: Record<string, unknown> | null
  eval_n: number | null
  n_tok: number | null
  verifier: string | null
  verify_f1: number | null
  reason: string | null
  created_at: string
  decided_at: string | null
}
export interface Walenty {
  meta: Record<string, string>
  verbs: Record<string, { a: string; s: string[][] }>
}
export interface Understood {
  text: string
  a: Analysis
  route: Route
  conf: number
  ms: number
  valence?: string[][]
  /** lematy i cechy z Morfeusza 2 / SGJP (leksykon przeglądarki) */
  morf?: boolean
}
/** Warianty modelu wg licencji danych treningowych (bez mieszania licencji w jednym pliku wag). */
export type RbVariant = 'pdb' | 'lfg'
export const RB_LICENCE: Record<RbVariant, { data: string; licence: string }> = {
  pdb: { data: 'UD Polish-PDB', licence: 'CC BY-NC-SA 4.0' },
  lfg: { data: 'UD Polish-LFG', licence: 'GPL-3.0' },
}
/** Wariant LFG (GPL-3.0) – plik statyczny w serwisie; liczby z wyniki.json (ocena na teście UD). */
const LFG_FILE = 'data/rozbior/models/rb-lfg-70793f8d.bin'
const VKEY = 'myc-rb-variant'
export const rbVariant = (): RbVariant => {
  try {
    return localStorage.getItem(VKEY) === 'lfg' ? 'lfg' : 'pdb'
  } catch {
    return 'pdb'
  }
}
type State = { status: 'idle' | 'loading' | 'ready' | 'none' | 'error'; variant: RbVariant; row?: RbRow; model?: RbModel; walenty?: Walenty; morf?: MorfLex; error?: string }
let st: State = { status: 'idle', variant: rbVariant() }
let ver = 0
const subs = new Set<() => void>()
const set = (s: Partial<State>) => {
  st = { ...st, ...s }
  ver++
  subs.forEach((f) => f())
}
export const rbState = () => st
export function useRozbior(): State {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ver,
  )
  return st
}

// Limit czasu: gdy baza nie odpowiada, pokazujemy uczciwy błąd zamiast wiecznego „wczytuję”.
const TIMEOUT_MS = 20000
const timed = (fn: string, p: Promise<Response>) =>
  p.catch((e: unknown) => {
    throw new Error((e as Error)?.name === 'TimeoutError' ? `${fn}: baza nie odpowiada (${TIMEOUT_MS / 1000} s), spróbuj później` : String((e as Error)?.message ?? e))
  })
const rpc = async <T,>(fn: string, body: unknown): Promise<T> => {
  const r = await timed(fn, fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) }))
  if (!r.ok) throw new Error(`${fn}: ${r.status}`)
  return r.json() as Promise<T>
}

/** Wersje modelu rozbioru (opublikowane i kandydaci) – do karty Start i do czatu. */
export const rbList = (limit = 30) => rpc<RbRow[]>('myc_rb_list', { p_limit: limit })

async function gunzipJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok || !r.body) throw new Error(`${url}: ${r.status}`)
  const s = r.body.pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(s).text()) as T
}

let loading: Promise<void> | undefined
/** Ładuje najnowszą opublikowaną wersję (raz; ok. 4 MB, int8). Brak opublikowanej = uczciwie „none”. */
export function ensureRozbior(): Promise<void> {
  if (loading) return loading
  set({ status: 'loading' })
  loading = (async () => {
    try {
      const v = st.variant
      let pub: RbRow | undefined
      if (v === 'pdb') {
        const rows = await rbList(30)
        pub = rows.filter((r) => r.status === 'published').sort((a, b) => b.version - a.version)[0]
        if (!pub) return set({ status: 'none' })
      } else {
        // wariant GPL: liczby z oceny na teście UD (wyniki.json), nie z bazy – oznaczone w karcie
        const w = (await fetch(`${import.meta.env.BASE_URL}data/rozbior/wyniki.json`).then((r) => r.json())) as {
          variants?: Record<string, { test: Record<string, number>; sha256: string }>
        }
        const t = w.variants?.lfg
        if (!t) return set({ status: 'none' })
        pub = { id: 0, version: 0, status: 'static', path: LFG_FILE, f1: t.test.role_f1, upos: t.test.upos, feats: t.test.feats, las: t.test.las, metrics: null, eval_n: 3942, n_tok: null, verifier: null, verify_f1: null, reason: null, created_at: '', decided_at: null }
      }
      const url = v === 'pdb' ? `${SB_URL}/storage/v1/object/public/myc-models/${pub.path}` : `${import.meta.env.BASE_URL}${LFG_FILE}`
      const [buf, walenty, morf] = await Promise.all([
        timed('model', fetch(url, { signal: AbortSignal.timeout(60000) })).then((r) => {
          if (!r.ok) throw new Error(`model: ${r.status}`)
          return r.arrayBuffer()
        }),
        gunzipJson<Walenty>(`${import.meta.env.BASE_URL}data/rozbior/walenty.json.gz`).catch(() => undefined),
        // Morfeusz 2 / SGJP (BSD-2) + mapa tagów z treningu tego samego wariantu; bez pliku – same przewidywania modelu
        gunzipJson<MorfLex>(`${import.meta.env.BASE_URL}data/rozbior/${v === 'pdb' ? 'morf' : 'morf-lfg'}.json.gz`).catch(() => undefined),
      ])
      set({ status: 'ready', row: pub, model: loadModel(buf), walenty, morf })
    } catch (e) {
      loading = undefined
      set({ status: 'error', error: String((e as Error).message ?? e) })
    }
  })()
  return loading
}

const cache = new Map<string, Understood>()
/** Zmiana wariantu (licencji) modelu – zapis w przeglądarce i ponowne wczytanie. */
export function setRbVariant(v: RbVariant): void {
  try {
    localStorage.setItem(VKEY, v)
  } catch {
    /* tryb prywatny – tylko na tę sesję */
  }
  loading = undefined
  cache.clear()
  st = { status: 'idle', variant: v }
  void ensureRozbior()
}
/** Rozbiór jednego zdania (pierwsze zdanie wiadomości, do 60 tokenów) – synchronicznie, gdy model gotowy. */
export function understand(text: string): Understood | undefined {
  const M = st.model
  if (!M) return undefined
  const key = text.trim().slice(0, 400)
  const hit = cache.get(key)
  if (hit) return hit
  const t0 = performance.now()
  const first = key.split(/(?<=[.!?])\s+/)[0] ?? key
  const { forms, sa } = tokenize(first, M.wv)
  if (!forms.length) return undefined
  const raw = predict(M, forms.slice(0, 60), st.variant, !!st.morf)
  const toks = (st.morf ? selectMorf(M.H, raw, st.morf, st.variant) : raw).map(({ lp: _lp, ...t }, i) => ({ ...t, sa: sa[i] ? undefined : 0 }))
  const a = analyse(toks)
  const conf = toks.reduce((s, t) => s + (t.p ?? 0), 0) / toks.length
  const root = a.frames.find((f) => f.clause === 0) ?? a.frames[0]
  const lemma = root ? a.tokens[root.pred - 1]?.lemma : undefined
  const u: Understood = { text: first, a, morf: !!st.morf, route: routeOf(a, first), conf, ms: performance.now() - t0, valence: lemma ? st.walenty?.verbs[lemma]?.s : undefined }
  cache.set(key, u)
  if (cache.size > 200) cache.delete(cache.keys().next().value as string)
  return u
}

/** Zapis rozbioru do Weryfikuj („rozbiór zdania”) – tylko za zgodą na użycie wiadomości do nauki; bez danych osobowych. */
export async function logParse(u: Understood): Promise<number | undefined> {
  const toks = u.a.tokens.map((t) => ({ form: t.form, lemma: t.lemma, upos: t.upos, head: String(t.head), deprel: t.deprel, part: t.part ?? undefined, q: t.q ?? undefined, of: t.of ? String(t.of) : undefined }))
  const r = await rpc<{ logged: boolean; id?: number }>('myc_parse_log', {
    p_node: ids.node,
    p_contrib: ids.contributor,
    p_sentence: u.text,
    p_toks: toks,
    p_version: st.variant === 'pdb' ? (st.row?.version ?? null) : null,
    p_conf: Math.round(u.conf * 1000) / 1000,
  })
  return r.logged ? r.id : undefined
}

/** Liczba zatwierdzonych rozbiorów (potwierdzone / poprawione w Weryfikuj) – na żywo, tylko licznik (HEAD, bez treści). */
export async function approvedParses(): Promise<number> {
  const r = await fetch(`${SB_URL}/rest/v1/myc_parses?select=id&room=eq.main&status=in.(confirmed,corrected)`, {
    method: 'HEAD',
    headers: { apikey: SB_KEY, Prefer: 'count=exact' },
    signal: AbortSignal.timeout(20000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const n = Number((r.headers.get('content-range') ?? '').split('/')[1])
  if (!Number.isFinite(n)) throw new Error('brak licznika')
  return n
}
