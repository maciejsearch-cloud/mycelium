// Pamięć relacji grzybni z jedną osobą (konto) – czysta logika. Zapis robi baza (myc_self_relations, tylko przez RPC
// rozmówcy), tu tylko: jak zdarzenie zmienia stan i jaki z tego wynika ton. Osoby z wyłączoną nauką nie mają pamięci.
import type { RelEvent, RelationState, Tone, Understanding } from './types'

export const EMPTY_REL: RelationState = { score: 0, n_msgs: 0, n_insults: 0, n_apologies: 0, n_compliments: 0, n_hostile_others: 0, topics: {} }
/** Zmiana wyniku relacji za zdarzenie (wynik obcięty do −10..10). */
export const REL_DELTA: Record<RelEvent, number> = { obraza: -3, przeprosiny: 2, komplement: 1, rozmowa: 0.1, wrogość_wobec_innych: -1 }

/** Zdarzenia relacji z rozbioru wiadomości. */
export function relEvents(u: Understanding): RelEvent[] {
  const ev: RelEvent[] = []
  if (u.acts.includes('obraza')) ev.push('obraza')
  if (u.acts.includes('przeprosiny') && (u.addressed || !u.toOther)) ev.push('przeprosiny')
  if (u.acts.includes('komplement')) ev.push('komplement')
  if (u.acts.includes('obraza_innego')) ev.push('wrogość_wobec_innych')
  if (u.addressed) ev.push('rozmowa')
  return ev
}

/** Nowy stan po wiadomości (bez mutacji wejścia). Przeprosiny podnoszą wynik najwyżej do 0, gdy były obrazy. */
export function applyRel(prev: RelationState | undefined, u: Understanding, at: string): RelationState {
  const s: RelationState = { ...EMPTY_REL, ...(prev ?? {}), topics: { ...(prev?.topics ?? {}) } }
  s.n_msgs += 1
  s.first_at ??= at
  for (const e of relEvents(u)) {
    let d = REL_DELTA[e]
    if (e === 'przeprosiny' && s.score + d > 0 && s.n_insults > 0) d = Math.max(0, -s.score)
    s.score = Math.max(-10, Math.min(10, Math.round((s.score + d) * 10) / 10))
    if (e === 'obraza') (s.n_insults += 1), (s.last_insult = { at, text: u.text.slice(0, 120) })
    if (e === 'przeprosiny') (s.n_apologies += 1), (s.last_apology_at = at)
    if (e === 'komplement') (s.n_compliments += 1), (s.last_compliment_at = at)
    if (e === 'wrogość_wobec_innych') s.n_hostile_others += 1
  }
  for (const l of u.content.slice(0, 5)) s.topics[l] = (s.topics[l] ?? 0) + 1
  // zwięzłość: najwyżej 12 tematów
  const top = Object.entries(s.topics).sort((a, b) => b[1] - a[1]).slice(0, 12)
  s.topics = Object.fromEntries(top)
  return s
}

export function toneOf(s?: RelationState): Tone {
  if (!s) return 'neutralnie'
  if (s.score <= -2) return 'chłodno'
  if (s.score >= 2) return 'ciepło'
  return 'neutralnie'
}
/** Czy po ostatniej obrazie były przeprosiny. */
export const reconciled = (s?: RelationState) => !!(s?.last_insult && s.last_apology_at && s.last_apology_at >= s.last_insult.at)
