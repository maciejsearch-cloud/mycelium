// Wizualizacja grzybni ze stanu rzeczywistego: każdy węzeł to prawdziwe urządzenie (UUID z bazy),
// strzępka do rdzenia = jego wkład we wspólną wiedzę, strzępki między węzłami = wspólnie ocenione pytania.
// Nowe węzły pojawiają się na zewnątrz spirali (kolejność pierwszej aktywności) i „wyrastają” na żywo.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { agentName } from '../myc/brain'
import type { Consensus } from '../myc/consensus'
import type { Shared } from '../myc/store'
import { ago } from './TimeChart'

export interface VNode {
  id: string
  kind: string
  first: number
  last: number
  answers: number
  events: number
  trust: number | null
}
export interface VEdge {
  a: string
  b: string
  shared: number
  agree: number
}

export function myceliumGraph(d: Shared, cons: Consensus, maxNodes = 300): { nodes: VNode[]; edges: VEdge[] } {
  const m = new Map<string, VNode>()
  const touch = (id: string, kind: string | undefined, t: string | undefined, f: 'answers' | 'events') => {
    const ts = t ? Date.parse(t) : NaN
    let n = m.get(id)
    if (!n) m.set(id, (n = { id, kind: kind ?? 'browser', first: Infinity, last: 0, answers: 0, events: 0, trust: null }))
    if (kind && kind !== 'browser') n.kind = kind
    if (!Number.isNaN(ts)) {
      n.first = Math.min(n.first, ts)
      n.last = Math.max(n.last, ts)
    }
    n[f]++
  }
  for (const a of d.answers) touch(a.node_id, a.kind, a.created_at, 'answers')
  for (const g of d.growth) touch(g.node_id, g.kind, g.created_at, 'events')
  for (const s of d.stats) touch(s.node_id, s.kind, s.created_at, 'events')
  for (const f of d.fed ?? []) touch(f.node_id, 'browser', f.created_at, 'events')
  for (const n of m.values()) {
    n.trust = cons.trust[n.id] ?? null
    if (!Number.isFinite(n.first)) n.first = n.last || 0
  }
  const nodes = [...m.values()].sort((x, y) => x.first - y.first || x.id.localeCompare(y.id)).slice(-maxNodes)
  const keep = new Set(nodes.map((n) => n.id))
  const byQ = new Map<string, [string, string][]>()
  for (const a of d.answers) if (keep.has(a.node_id)) byQ.set(a.question_id, [...(byQ.get(a.question_id) ?? []), [a.node_id, a.answer]])
  const pairs = new Map<string, VEdge>()
  for (const votes of byQ.values()) {
    if (votes.length < 2 || votes.length > 40) continue
    for (let i = 0; i < votes.length; i++)
      for (let j = i + 1; j < votes.length; j++) {
        const [x, y] = votes[i][0] < votes[j][0] ? [votes[i], votes[j]] : [votes[j], votes[i]]
        if (x[0] === y[0]) continue
        const k = `${x[0]}|${y[0]}`
        const e = pairs.get(k) ?? { a: x[0], b: y[0], shared: 0, agree: 0 }
        e.shared++
        if (x[1] === y[1]) e.agree++
        pairs.set(k, e)
      }
  }
  const edges = [...pairs.values()].sort((x, y) => y.shared - x.shared).slice(0, 600)
  return { nodes, edges }
}

const hash = (s: string) => parseInt(s.replace(/-/g, '').slice(0, 8), 16) || 1
const GOLD = Math.PI * (3 - Math.sqrt(5))
const KIND_COLOR: Record<string, string> = { browser: '#5eead4', python: '#c4b5fd', esp: '#fbbf24' }
const trustColor = (t: number | null) => (t == null ? '#64748b' : t >= 0.8 ? '#5eead4' : t >= 0.6 ? '#a7f3d0' : t >= 0.4 ? '#fbbf24' : '#fb7185')

export function MyceliumViz({ data, cons, me, h = 420 }: { data: Shared; cons: Consensus; me?: string; h?: number }) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const g = useMemo(() => myceliumGraph(data, cons), [data, cons])
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [cut, setCut] = useState<number | null>(null) // odtwarzanie historii (prawdziwe znaczniki czasu)
  const [hover, setHover] = useState<VNode | null>(null)
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // węzły, które pojawiły się po otwarciu strony → animacja „wyrastania”
  useEffect(() => {
    const ids = new Set(g.nodes.map((n) => n.id))
    if (seen.current) {
      const nw = [...ids].filter((i) => !seen.current!.has(i))
      if (nw.length) setFresh((f) => new Set([...f, ...nw]))
    }
    seen.current = ids
  }, [g])

  const W = 1000
  const H = 520
  const cx = W / 2
  const cy = H / 2
  const RX = W / 2 - 40
  const RY = H / 2 - 30
  const n = g.nodes.length
  const pos = new Map<string, [number, number]>()
  g.nodes.forEach((v, i) => {
    const r = Math.sqrt((i + 1) / Math.max(n, 12))
    const a = i * GOLD + (hash(v.id) % 100) / 400
    pos.set(v.id, [cx + RX * r * Math.cos(a), cy + RY * r * Math.sin(a)])
  })
  const visible = (v: VNode) => cut == null || v.first <= cut
  const vis = new Set(g.nodes.filter(visible).map((v) => v.id))
  const now = Date.now()

  const replay = () => {
    if (!g.nodes.length) return
    const t0 = g.nodes[0].first
    const t1 = Math.max(g.nodes[g.nodes.length - 1].first, t0 + 1)
    const start = performance.now()
    const dur = 6000
    const step = (ts: number) => {
      const k = Math.min(1, (ts - start) / dur)
      setCut(t0 + (t1 - t0) * k)
      if (k < 1) requestAnimationFrame(step)
      else setCut(null)
    }
    requestAnimationFrame(step)
  }

  const curve = (x1: number, y1: number, x2: number, y2: number, s: number) => {
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const dx = x2 - x1
    const dy = y2 - y1
    const k = (((s % 7) - 3) / 10) * 0.9
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${(mx - dy * k).toFixed(1)},${(my + dx * k).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }

  if (!n)
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500" data-testid="empty">
        {en ? 'no data yet' : 'brak danych jeszcze'}
      </div>
    )
  return (
    <div className="relative" data-testid="mycelium-viz" data-nodes={vis.size} data-edges={g.edges.length}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: h }} role="img" aria-label={en ? `mycelium: ${n} real nodes, ${g.edges.length} shared-question links` : `grzybnia: ${n} prawdziwych węzłów, ${g.edges.length} połączeń przez wspólne pytania`}>
        <defs>
          <radialGradient id="core" r="1">
            <stop offset="0" stopColor="#a7f3d0" stopOpacity="0.9" />
            <stop offset="1" stopColor="#5eead4" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* strzępki do rdzenia (wspólna wiedza) */}
        {g.nodes.filter(visible).map((v) => {
          const [x, y] = pos.get(v.id)!
          const w = Math.min(3, 0.4 + Math.log1p(v.answers + v.events) / 2.5)
          return <path key={`h-${v.id}`} d={curve(cx, cy, x, y, hash(v.id))} fill="none" stroke={KIND_COLOR[v.kind] ?? '#5eead4'} strokeOpacity={0.28} strokeWidth={w} className={fresh.has(v.id) && !reduce ? 'myc-grow' : undefined} pathLength={1} strokeDasharray={fresh.has(v.id) ? 1 : undefined} />
        })}
        {/* strzępki między węzłami: wspólnie ocenione pytania; kolor = zgodność */}
        {g.edges
          .filter((e) => vis.has(e.a) && vis.has(e.b))
          .map((e) => {
            const [x1, y1] = pos.get(e.a)!
            const [x2, y2] = pos.get(e.b)!
            const ag = e.agree / e.shared
            return <path key={`e-${e.a}-${e.b}`} d={curve(x1, y1, x2, y2, hash(e.a) + hash(e.b))} fill="none" stroke={ag >= 0.7 ? '#5eead4' : ag >= 0.4 ? '#fbbf24' : '#fb7185'} strokeOpacity={0.18 + Math.min(0.5, e.shared / 40)} strokeWidth={Math.min(2.5, 0.5 + Math.log1p(e.shared) / 2)} />
          })}
        <circle cx={cx} cy={cy} r={34} fill="url(#core)" className={reduce ? undefined : 'myc-breathe'} />
        <circle cx={cx} cy={cy} r={7} fill="#a7f3d0" />
        {g.nodes.filter(visible).map((v) => {
          const [x, y] = pos.get(v.id)!
          const r = 4 + Math.min(12, Math.sqrt(v.answers + v.events))
          const live = now - v.last < 120_000
          return (
            <g key={v.id} onMouseEnter={() => setHover(v)} onMouseLeave={() => setHover(null)} className={fresh.has(v.id) && !reduce ? 'myc-pop' : undefined} style={{ transformOrigin: `${x}px ${y}px` }} data-node={v.id}>
              {live && !reduce && <circle cx={x} cy={y} r={r + 6} fill="none" stroke={trustColor(v.trust)} strokeOpacity={0.6} className="myc-pulse" style={{ transformOrigin: `${x}px ${y}px` }} />}
              <circle cx={x} cy={y} r={r} fill={trustColor(v.trust)} fillOpacity={0.85} stroke={v.id === me ? '#fff' : KIND_COLOR[v.kind]} strokeWidth={v.id === me ? 2.5 : 1} />
            </g>
          )
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-xl border border-white/10 bg-ink/90 px-3 py-2 text-xs text-slate-300" data-testid="viz-tip">
          <b className="text-slate-100">{agentName(hover.id, hover.kind)}</b> {hover.id === me && (en ? '(you)' : '(Ty)')}
          <div>
            {en ? 'answers' : 'odpowiedzi'}: {hover.answers} · {en ? 'events' : 'zdarzenia'}: {hover.events}
          </div>
          <div>
            {en ? 'trust' : 'zaufanie'}: {hover.trust == null ? '—' : `${Math.round(hover.trust * 100)}%`} · {en ? 'joined' : 'dołączył'} {ago(hover.first, lang)} · {en ? 'last' : 'ostatnio'} {ago(hover.last, lang)}
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>
          {n} {en ? 'nodes' : 'węzłów'} · {g.edges.length} {en ? 'links' : 'połączeń'} · {en ? 'newest outside' : 'najnowsze na zewnątrz'}
        </span>
        <span>
          <i className="inline-block h-2 w-2 rounded-full bg-spore" /> {en ? 'high trust' : 'wysokie zaufanie'} <i className="ml-1 inline-block h-2 w-2 rounded-full bg-amber" /> {en ? 'medium' : 'średnie'} <i className="ml-1 inline-block h-2 w-2 rounded-full bg-rose" /> {en ? 'low' : 'niskie'}
        </span>
        <button onClick={replay} className="text-spore hover:underline" data-testid="viz-replay">
          {en ? '▶ replay growth (real timestamps)' : '▶ odtwórz wzrost (prawdziwe czasy)'}
        </button>
      </div>
    </div>
  )
}
