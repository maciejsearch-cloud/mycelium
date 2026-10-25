import { useEffect, useState } from 'react'
import type { Progress, Snapshot } from './types'

const base = import.meta.env.BASE_URL
const API = import.meta.env.VITE_API_URL as string | undefined

export type Source = 'live' | 'recorded'

async function getJSON<T>(url: string, timeoutMs = 4000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`${r.status} ${url}`)
    return (await r.json()) as T
  } finally {
    clearTimeout(t)
  }
}

/** Najpierw próbuje żywego backendu (VITE_API_URL), w razie braku – nagrany snapshot. */
export function useData() {
  const [state, setState] = useState<{ snap?: Snapshot; progress?: Progress; source: Source; error?: string }>({ source: 'recorded' })
  useEffect(() => {
    let alive = true
    ;(async () => {
      let snap: Snapshot | undefined
      let source: Source = 'recorded'
      if (API) {
        try {
          snap = await getJSON<Snapshot>(`${API.replace(/\/$/, '')}/api/snapshot`, 2500)
          source = 'live'
        } catch {
          /* tryb nagrany */
        }
      }
      try {
        snap ??= await getJSON<Snapshot>(`${base}data/snapshot.json`)
        const progress = await getJSON<Progress>(`${base}data/progress.json`).catch(() => undefined)
        if (alive) setState({ snap, progress, source })
      } catch (e) {
        if (alive) setState({ source, error: String(e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return state
}

export const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' })
