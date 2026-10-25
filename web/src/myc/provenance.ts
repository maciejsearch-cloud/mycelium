// Pochodzenie i wiarygodność wyświetlanych liczb (docs/data-provenance.md).
// Zasada: pokazujemy tylko wartości z zapisanych pomiarów; nieprawdopodobne (NaN, <0, >100%) odrzucamy, zamiast je pokazywać.
import type { Point } from '../components/TimeChart'

/** Ułamek 0..1 albo `undefined`, gdy wartość jest nieprawdopodobna (NaN, Infinity, poza zakresem, nie liczba). */
export const frac = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined)
/** Liczba nieujemna i skończona albo `undefined`. */
export const nonneg = (v: unknown): number | undefined => {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
}

/** Etykiety wierszy myc_node_stats liczonych tą samą funkcją `evaluate()` w przeglądarce (ten sam zbiór qa.json). */
export const BROWSER_EVAL = new Set(['przegladarka', 'wzrost'])

type StatLike = { created_at: string; kind?: string; label: string | null; acc: Record<string, number> }

/** Trafność w testach w przeglądarce w czasie (w %), wyłącznie z zapisanych wierszy; wartości spoza 0–100% pomijane. */
export function accPoints(stats: StatLike[]): Point[] {
  const out: Point[] = []
  for (const s of stats) {
    if ((s.kind ?? 'browser') !== 'browser' || !BROWSER_EVAL.has(s.label ?? '')) continue
    const t = Date.parse(s.created_at)
    const i = frac(s.acc?.intent)
    const se = frac(s.acc?.sensor)
    const k = frac(s.acc?.knowledge)
    if (!Number.isFinite(t) || (i == null && se == null && k == null)) continue
    out.push({ t, intent: i == null ? null : i * 100, sensor: se == null ? null : se * 100, knowledge: k == null ? null : k * 100 })
  }
  return out
}

/** Najnowszy zapisany wiersz oceny w przeglądarce. */
export function lastBrowserEval<T extends StatLike>(stats: T[]): T | undefined {
  let best: T | undefined
  for (const s of stats) if ((s.kind ?? 'browser') === 'browser' && BROWSER_EVAL.has(s.label ?? '') && (!best || s.created_at > best.created_at)) best = s
  return best
}

const TZ = 'Europe/Amsterdam'
/** Data i godzina pomiaru w strefie Amsterdamu z etykietą strefy (CEST/CET). */
export const at = (t: string | number | undefined, en: boolean) =>
  t == null || !Number.isFinite(new Date(t).getTime())
    ? en
      ? 'unknown time'
      : 'czas nieznany'
    : new Date(t).toLocaleString(en ? 'en-GB' : 'pl-PL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
