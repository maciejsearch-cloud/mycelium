/** Plakietki w nawigacji: liczba rzeczy czekających w Ucz / Weryfikuj.
 *  Tylko prawdziwe liczby policzone przez stronę (kolejka „AI pyta”, kolejka Weryfikuj) z czasem pomiaru;
 *  starsze niż 30 min albo nieznane = brak plakietki (nigdy zgadywanie). */
export type BadgeKey = 'teach' | 'weryfikuj'
type Row = { n: number; at: number; more?: boolean } // more = kolejka ucięta na n (jest co najmniej n)
const KEY = 'myc.badges'
const TTL = 30 * 60_000
const subs = new Set<() => void>()
let ver = 0

function read(): Partial<Record<BadgeKey, Row>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<BadgeKey, Row>>
  } catch {
    return {}
  }
}

export const badges = {
  set(k: BadgeKey, n: number, more = false) {
    if (!Number.isFinite(n) || n < 0) return
    const all = read()
    if (all[k]?.n === n && !!all[k]?.more === more && Date.now() - all[k]!.at < TTL / 2) return
    all[k] = { n: Math.round(n), at: Date.now(), more }
    try {
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      /* brak miejsca – plakietka po prostu się nie pokaże */
    }
    ver++
    subs.forEach((f) => f())
  },
  get(k: BadgeKey, now = Date.now()): Row | null {
    const r = read()[k]
    return r && now - r.at < TTL ? r : null
  },
  subscribe(f: () => void) {
    subs.add(f)
    return () => void subs.delete(f)
  },
  version: () => ver,
}
