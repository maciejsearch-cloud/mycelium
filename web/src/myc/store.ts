// Wspólny stan grzybni: darmowy Supabase (REST + RLS + limiter) z lokalnym zapasem.
// Bez sieci wszystko działa lokalnie; zaległe wpisy czekają w skrzynce nadawczej.
export const SB_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? 'https://agortpieeygmcttjwjfx.supabase.co'
// Klucz publikowalny – publiczny z założenia; dostęp ogranicza RLS w bazie.
export const SB_KEY = (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P'
const REST = `${SB_URL}/rest/v1`

export interface AnswerRow {
  id?: number
  question_id: string
  node_id: string
  contributor_id?: string
  answer: string
  kind?: string
  owner?: boolean
  created_at?: string
}
export interface UserQ {
  id: string
  kind: 'fact' | 'qa' | 'example' | 'word'
  text: string
  answer: string | null
  node_id: string
  owner?: boolean
  created_at?: string
}
export interface GrowthRow {
  node_id: string
  kind?: string
  agent?: string | null
  event: string
  detail: Record<string, unknown>
  iq: number | null
  created_at: string
}
export interface StatRow {
  node_id: string
  kind?: string
  label: string | null
  acc: Record<string, number>
  n_answers: number
  created_at: string
}
export interface FedLite {
  node_id: string
  contributor_id?: string
  model: string
  round: number
  n: number
  metrics: { acc_global?: number; acc_local?: number; used?: number }
  ms?: number
  created_at: string
}
export interface Shared {
  answers: AnswerRow[]
  userQs: UserQ[]
  gold: Record<string, [number, number]>
  goldDaily: { day: string; n: number; correct: number }[]
  goldByType?: { kind: string; day: string; n: number; correct: number }[]
  fed?: FedLite[]
  contrib?: { contributor_id: string; rounds: number; samples: number; ms: number; days: number; last: string }[]
  growth: GrowthRow[]
  stats: StatRow[]
  /** Decyzje z zakładki Weryfikuj (właścicielka / zaufany współtwórca) – złote etykiety. */
  labels?: ReviewLabel[]
}
export interface ReviewLabel {
  id: number
  item_type: string
  item_ref: string
  verdict: 'approve' | 'reject' | 'correct'
  truth: string | null
  reviewer: 'owner' | 'contrib'
  weight: number
  created_at: string
}

const LS = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`myc.${k}`)
      return v ? (JSON.parse(v) as T) : d
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`myc.${k}`, JSON.stringify(v))
    } catch {
      /* pełny localStorage – trudno */
    }
  },
}

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16))
}

export const ids = {
  node: LS.get<string>('node', '') || (() => {
    const v = uuid()
    LS.set('node', v)
    return v
  })(),
  contributor: LS.get<string>('contrib', '') || (() => {
    const v = uuid()
    LS.set('contrib', v)
    return v
  })(),
}
export const ownerKey = {
  get: () => LS.get<string>('owner', ''),
  set: (k: string) => LS.set('owner', k.trim()),
}

type Outbox = { table: string; row: Record<string, unknown> }[]

async function req<T>(path: string, init: RequestInit = {}, timeout = 6000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(REST + path, {
      ...init,
      signal: ctrl.signal,
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status })
    const txt = await r.text()
    return (txt ? JSON.parse(txt) : null) as T
  } finally {
    clearTimeout(t)
  }
}

/** PostgREST zwraca maks. 1000 wierszy na zapytanie – dobieramy kolejne strony (do `cap`). */
async function all<T>(path: string, cap: number, page = 1000): Promise<T[]> {
  const out: T[] = []
  while (out.length < cap) {
    const rows = await req<T[]>(`${path}&limit=${Math.min(page, cap - out.length)}&offset=${out.length}`, {}, 10000)
    out.push(...rows)
    if (rows.length < page) break
  }
  return out
}

export class Store {
  online = false
  data: Shared = LS.get<Shared>('cache', { answers: [], userQs: [], gold: {}, goldDaily: [], growth: [], stats: [] })
  outbox: Outbox = LS.get<Outbox>('outbox', [])
  /** Wpisy w drodze do bazy – nie mogą „zniknąć” przy odświeżeniu (inaczej pytanie wraca i powstaje duplikat). */
  private inflight: Outbox = []

  private persist() {
    const d = this.data
    LS.set('cache', { ...d, answers: d.answers.slice(-8000), growth: d.growth.slice(0, 500), stats: d.stats.slice(-1500), fed: (d.fed ?? []).slice(0, 1000) })
    LS.set('outbox', this.outbox.slice(-500))
  }

  async refresh(): Promise<Shared> {
    try {
      const [answers, userQs, goldRows, goldDaily, growth, stats] = await Promise.all([
        all<AnswerRow>('/myc_answers?select=id,question_id,node_id,contributor_id,answer,kind,owner,created_at&order=id', 20000),
        all<UserQ>('/myc_user_questions?select=id,kind,text,answer,node_id,owner,created_at&order=created_at,id', 2000),
        req<{ node_id: string; n: number; correct: number }[]>('/rpc/myc_gold_stats', { method: 'POST', body: '{}' }),
        req<Shared['goldDaily']>('/rpc/myc_gold_daily', { method: 'POST', body: '{}' }),
        req<GrowthRow[]>('/myc_growth?select=node_id,kind,agent,event,detail,iq,created_at&order=id.desc&limit=400'),
        all<StatRow>('/myc_node_stats?select=node_id,kind,label,acc,n_answers,created_at&order=id.desc', 3000).then((r) => r.reverse()),
      ])
      const [fed, contrib] = await Promise.all([
        all<FedLite>('/myc_fed?select=node_id,contributor_id,model,round,n,metrics,ms,created_at&order=id.desc', 3000).catch(() => this.data.fed ?? []),
        req<NonNullable<Shared['contrib']>>('/rpc/myc_contrib_stats', { method: 'POST', body: '{}' }).catch(() => this.data.contrib ?? []),
      ])
      const [goldByType, labels] = await Promise.all([
        req<NonNullable<Shared['goldByType']>>('/rpc/myc_gold_by_type', { method: 'POST', body: '{}' }).catch(() => this.data.goldByType ?? []),
        req<ReviewLabel[]>('/rpc/myc_review_labels', { method: 'POST', body: '{"p_room":"main"}' }).catch(() => this.data.labels ?? []),
      ])
      this.online = true
      this.data = { answers, userQs, gold: Object.fromEntries(goldRows.map((r) => [r.node_id, [r.n, r.correct]])), goldDaily, goldByType, fed, contrib, growth, stats, labels }
      await this.flush()
    } catch {
      this.online = false
    }
    // wpisy jeszcze niewysłane też się liczą lokalnie
    const pend = (t: string) => [...this.outbox, ...this.inflight].filter((o) => o.table === t).map((o) => o.row)
    const have = new Set(this.data.answers.map((a) => `${a.question_id}|${a.node_id}`))
    for (const r of pend('myc_answers') as unknown as AnswerRow[])
      if (!have.has(`${r.question_id}|${r.node_id}`)) this.data.answers.push({ ...r, owner: !!ownerKey.get() })
    const haveQ = new Set(this.data.userQs.map((q) => q.id))
    for (const r of pend('myc_user_questions') as unknown as UserQ[]) if (!haveQ.has(r.id)) this.data.userQs.push(r)
    // zdarzenia wzrostu w drodze (np. właśnie przyjęta konfiguracja) nie mogą zniknąć przy odświeżeniu
    const now = new Date().toISOString()
    for (const r of pend('myc_growth') as unknown as GrowthRow[])
      if (!this.data.growth.some((g) => g.node_id === r.node_id && g.event === r.event && JSON.stringify(g.detail) === JSON.stringify(r.detail))) this.data.growth.unshift({ ...r, created_at: now })
    this.persist()
    return this.data
  }

  async flush() {
    const out = this.outbox
    this.outbox = []
    for (const o of out) await this.send(o.table, o.row)
    this.persist()
  }

  private async send(table: string, row: Record<string, unknown>): Promise<boolean> {
    const body = { ...row }
    delete body.created_at
    const fl = { table, row }
    this.inflight.push(fl)
    const key = ownerKey.get()
    if (key && (table === 'myc_answers' || table === 'myc_user_questions')) body.owner_key = key
    try {
      const conflict = table === 'myc_answers' ? '?on_conflict=question_id,node_id' : ''
      await req(`/${table}${conflict}`, { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } })
      this.online = true
      return true
    } catch (e) {
      const st = (e as { status?: number }).status
      // 4xx (np. walidacja) – nie ponawiamy; 429/sieć – do skrzynki
      // wagi FedAvg się nie kolejkują (są duże i szybko się starzeją)
      if (table !== 'myc_fed' && (st === undefined || st === 429 || st >= 500)) this.outbox.push({ table, row })
      if (st === undefined) this.online = false
      return false
    } finally {
      this.inflight = this.inflight.filter((x) => x !== fl)
    }
  }

  /** Zapis optymistyczny: od razu w lokalnym stanie, potem do bazy (lub skrzynki). */
  add(table: 'myc_answers' | 'myc_user_questions' | 'myc_growth' | 'myc_node_stats' | 'myc_fed', row: Record<string, unknown>) {
    const now = new Date().toISOString()
    const r = { ...row, created_at: now }
    if (table === 'myc_answers') this.data.answers.push({ ...(r as unknown as AnswerRow), owner: !!ownerKey.get() })
    if (table === 'myc_user_questions') this.data.userQs.push({ ...(r as unknown as UserQ), owner: !!ownerKey.get() })
    if (table === 'myc_growth') this.data.growth.unshift(r as unknown as GrowthRow)
    if (table === 'myc_node_stats') this.data.stats.push(r as unknown as StatRow)
    if (table === 'myc_fed') {
      const { w: _w, scale: _s, ...lite } = r as Record<string, unknown>
      this.data.fed = [lite as unknown as FedLite, ...(this.data.fed ?? [])]
    }
    this.persist()
    void this.send(table, row).then(() => this.persist())
  }
}
