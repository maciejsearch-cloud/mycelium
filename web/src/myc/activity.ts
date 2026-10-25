// Kanał aktywności agentów: zdarzenia z myc_growth + odpowiedzi z myc_answers (wspólny stan).
import { agentName } from './brain'
import type { AnswerRow, GrowthRow, Shared } from './store'

export interface Activity {
  t: string
  node: string
  kind: string
  agent: string
  event: string
  detail: Record<string, unknown>
  iq: number | null
}

export function nodeKinds(d: Shared): Record<string, string> {
  const k: Record<string, string> = {}
  for (const a of d.answers) k[a.node_id] = a.kind ?? 'browser'
  for (const s of d.stats) k[s.node_id] = s.kind ?? k[s.node_id] ?? 'browser'
  for (const g of d.growth) k[g.node_id] = g.kind ?? k[g.node_id] ?? 'browser'
  return k
}

export function activities(d: Shared, limit = 80): Activity[] {
  const kinds = nodeKinds(d)
  const fromGrowth = d.growth
    .filter((g: GrowthRow) => g.event !== 'goal' && g.created_at)
    .map((g) => ({ t: g.created_at, node: g.node_id, kind: g.kind ?? 'browser', agent: g.agent || agentName(g.node_id, g.kind), event: g.event, detail: g.detail ?? {}, iq: g.iq }))
  const fromAnswers = d.answers
    .filter((a: AnswerRow) => a.created_at)
    .slice(-300)
    .map((a) => ({ t: a.created_at!, node: a.node_id, kind: a.kind ?? 'browser', agent: agentName(a.node_id, kinds[a.node_id]), event: a.kind === 'python' ? 'verify' : 'answer', detail: { q: a.question_id, a: a.answer }, iq: null }))
  return [...fromGrowth, ...fromAnswers].sort((x, y) => y.t.localeCompare(x.t)).slice(0, limit)
}

/** Ostatnie działanie każdego węzła. */
export function lastByNode(acts: Activity[]): Record<string, Activity> {
  const m: Record<string, Activity> = {}
  for (const a of acts) if (!m[a.node] || a.t > m[a.node].t) m[a.node] = a
  return m
}

const LABEL: Record<string, [string, string]> = {
  answer: ['odpowiedź', 'answered'],
  verify: ['weryfikacja (węzeł Python)', 'verified (Python node)'],
  train: ['trening', 'trained'],
  question: ['zadała pytania', 'asked questions'],
  action: ['wybór celu (ciekawość)', 'chose goal (curiosity)'],
  accept: ['zmiana przyjęta', 'change accepted'],
  reject: ['zmiana odrzucona', 'change rejected'],
  spawn: ['narodziny specjalisty', 'spawned specialist'],
  prune: ['przycięcie agenta', 'pruned agent'],
  join: ['dołączył(a)', 'joined'],
  goal: ['pomiar celów', 'measured goals'],
}
export const eventLabel = (e: string, en: boolean) => (LABEL[e] ? LABEL[e][en ? 1 : 0] : e)

export function describe(a: Activity, en: boolean): string {
  const d = a.detail as Record<string, unknown>
  switch (a.event) {
    case 'answer':
    case 'verify':
      return `${d.q} → ${d.a}`
    case 'train': {
      // tylko trafności z testów (dawny wskaźnik „iq” nie jest pokazywane – docs/data-provenance.md)
      const p = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? `${(v * 100).toFixed(1)}%` : '—')
      const ib = typeof d.intent_before === 'number' ? `${p(d.intent_before)} → ` : ''
      const sb = typeof d.sensor_before === 'number' ? `${p(d.sensor_before)} → ` : ''
      return `${en ? 'intents' : 'intencje'} ${ib}${p(d.intent)} · ${en ? 'sensor' : 'czujnik'} ${sb}${p(d.sensor)}`
    }
    case 'accept':
    case 'spawn':
    case 'prune':
    case 'reject':
      return `${d.change ?? ''}${typeof d.val_gain === 'number' ? ` (${d.val_gain >= 0 ? '+' : ''}${(d.val_gain * 100).toFixed(1)} pp val)` : ''}${d.regress ? (en ? ' – would regress' : ' – regres') : ''}`
    case 'action':
      return `${en ? 'niche' : 'nisza'}: ${d.niche}`
    case 'question':
      return Array.isArray(d.ask) ? (d.ask as string[]).join(', ') : ''
    case 'join':
      return String(d.via ?? '')
    default:
      return ''
  }
}
