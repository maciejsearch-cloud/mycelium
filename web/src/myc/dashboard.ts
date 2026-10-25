// Dane panelu „Przegląd”: wyłącznie prawdziwe wiersze z Supabase (widoki wkładu, modele LM, statystyki strzępków).
// Brak odpowiedzi bazy = `null` (uczciwy pusty stan), nigdy wartości zastępcze.
import { useEffect, useState } from 'react'
import { fragStats, type FragStat } from './frags'
import { frac, nonneg } from './provenance'
import { SB_KEY, SB_URL } from './store'

export type NodeRow = { node_id: string; backends: string | null; results: number; hours: number; flops: number; last_at: string }
export type BackendRow = { backend: string; results: number; accepted: number; rejected: number; hours: number; flops: number }
export type DayRow = { day: string; accepted: number; rejected: number; hours: number }
export type LmRow = {
  version: number
  acc: number
  meta?: { ppl?: number; correct?: number; eval_n?: number; eval_version?: number; rebased?: { at: string; by?: string; backend?: string; eval_n?: number }[] }
  verifiers?: { node: string; backend?: string; trusted?: boolean }[] | null
  created_at: string
}
export type LmCand = { version: number; status: string; created_at: string }

export interface Dash {
  nodes: NodeRow[] | null
  backends: BackendRow[] | null
  days: DayRow[] | null
  lm: LmRow[] | null
  cands: LmCand[] | null
  frags: FragStat[] | null
  at: number
}

const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const get = <T,>(q: string) =>
  fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
const orNull = <T,>(p: Promise<T>) => p.then((v) => (Array.isArray(v) ? v : null) as T | null).catch(() => null)

export async function loadDash(): Promise<Dash> {
  const [nodes, backends, days, lm, cands, frags] = await Promise.all([
    orNull(get<NodeRow[]>('myc_node_contrib?select=node_id,backends,results,hours,flops,last_at&order=last_at.desc&limit=500')),
    orNull(get<BackendRow[]>('myc_backend_contrib?select=*')),
    orNull(get<DayRow[]>('myc_daily_contrib?select=day,accepted,rejected,hours&order=day.desc&limit=14')),
    orNull(get<LmRow[]>('myc_models?model=eq.lm&select=version,acc,meta,verifiers,created_at&order=version')),
    orNull(get<LmCand[]>('myc_candidates?model=eq.lm&select=version,status,created_at&order=id.desc&limit=5')),
    orNull(fragStats()),
  ])
  // wiarygodność: wiersze z nieprawdopodobnymi wartościami (NaN, ujemne godziny, trafność > 100%) nie są pokazywane
  const ok = <T,>(rows: T[] | null, f: (r: T) => boolean) => (rows ? rows.filter(f) : null)
  return {
    nodes: ok(nodes, (r) => nonneg(r.hours) != null && nonneg(r.flops) != null && Number.isFinite(Date.parse(r.last_at))),
    backends: ok(backends, (r) => nonneg(r.hours) != null && nonneg(r.flops) != null && r.accepted <= r.results),
    days: ok(days, (r) => nonneg(r.hours) != null),
    lm: ok(lm, (r) => frac(r.acc) != null && (r.meta?.ppl == null || (Number.isFinite(r.meta.ppl) && r.meta.ppl >= 1))),
    cands,
    frags,
    at: Date.now(),
  }
}

export function useDash(everyMs = 60_000) {
  const [d, setD] = useState<Dash | undefined>()
  useEffect(() => {
    let alive = true
    const run = () => void loadDash().then((x) => alive && setD(x))
    run()
    const t = setInterval(() => document.visibilityState === 'visible' && run(), everyMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [everyMs])
  return d
}

/** Rodzaj mocy z backendu obliczeń (zapisywanego przez węzeł). */
export const backendKind = (b: string): 'cpu' | 'wasm' | 'gpu' => (b === 'webgpu' || b === 'webgl' || b === 'cuda' || b === 'directml' ? 'gpu' : b === 'cpu' ? 'cpu' : 'wasm')
