import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { fragDaily, fragStats, fragText, graphSample, type Frag, type FragDay, type FragLink, type FragStat } from '../myc/frags'
import { TimeChart, type Point } from './TimeChart'
import { Card } from './ui'

const COL = ['#5eead4', '#a78bfa', '#fbbf24', '#f472b6']
const R = [172, 118, 58]

/** „Po nitce do kłębka”: strzępki (zewnętrzny pierścień) → pojęcia → tematy (środek). Prawdziwe wiersze z bazy. */
export default function FragGraph() {
  const en = useI18n().lang === 'en'
  const [g, setG] = useState<{ nodes: Frag[]; links: FragLink[] } | undefined>()
  const [stats, setStats] = useState<FragStat[] | undefined>()
  const [daily, setDaily] = useState<FragDay[]>([])
  const [sel, setSel] = useState<Frag | undefined>()
  useEffect(() => {
    const arr = <T,>(x: T[] | unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])
    void graphSample()
      .then((x) => setG({ nodes: arr<Frag>(x.nodes), links: arr<FragLink>(x.links) }))
      .catch(() => setG({ nodes: [], links: [] }))
    void fragStats()
      .then((x) => setStats(arr<FragStat>(x)))
      .catch(() => setStats([]))
    void fragDaily()
      .then((x) => setDaily(arr<FragDay>(x)))
      .catch(() => undefined)
  }, [])

  // układ sektorowy: każdy temat ma swój wycinek koła, jego pojęcia i strzępki leżą w tym wycinku (mniej krzyżujących się nici)
  const pos = useMemo(() => {
    const p = new Map<number, { x: number; y: number; a: number }>()
    if (!g) return p
    const at = (r: number, a: number) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r, a })
    const layer = new Map(g.nodes.map((n) => [n.id, n.layer]))
    const parentOf = new Map<number, number>()
    for (const l of g.links) if (!parentOf.has(l.src) && (layer.get(l.dst) ?? -1) === (layer.get(l.src) ?? 0) + 1) parentOf.set(l.src, l.dst)
    const kids = new Map<number, number[]>()
    for (const [c, par] of parentOf) kids.set(par, [...(kids.get(par) ?? []), c])
    const topics = g.nodes.filter((n) => n.layer === 2)
    const span = (Math.PI * 2) / Math.max(1, topics.length)
    topics.forEach((t, i) => {
      const a0 = i * span
      p.set(t.id, at(R[2], a0 + span / 2))
      const cs = (kids.get(t.id) ?? []).sort((x, y) => x - y)
      cs.forEach((c, j) => {
        const cs0 = a0 + (j / cs.length) * span
        const cw = span / cs.length
        p.set(c, at(R[1], cs0 + cw / 2))
        const ls = (kids.get(c) ?? []).sort((x, y) => x - y)
        ls.forEach((f, k) => p.set(f, at(R[0], cs0 + ((k + 0.5) / ls.length) * cw)))
      })
    })
    // pojęcia/strzępki bez rodzica w próbce – równo na swoim pierścieniu
    for (const lv of [1, 0]) {
      const rest = g.nodes.filter((n) => n.layer === lv && !p.has(n.id))
      rest.forEach((n, i) => p.set(n.id, at(R[lv === 1 ? 1 : 0], (i / Math.max(1, rest.length)) * Math.PI * 2)))
    }
    return p
  }, [g])

  // narastająco na warstwę, dzień po dniu
  const pts: Point[] = useMemo(() => {
    const days = [...new Set(daily.map((d) => d.day))].sort()
    const cum = [0, 0, 0]
    let links = 0
    return days.map((d) => {
      for (const r of daily.filter((x) => x.day === d)) cum[r.layer] = (cum[r.layer] ?? 0) + r.n
      links += daily.find((x) => x.day === d)?.links ?? 0
      return { t: Date.parse(`${d}T12:00:00`), l0: cum[0], l1: cum[1], l2: cum[2], links }
    })
  }, [daily])

  const layerOf = useMemo(() => new Map((g?.nodes ?? []).map((n) => [n.id, n.layer])), [g])
  const by = (l: number) => stats?.find((s) => s.layer === l)
  const total = (stats ?? []).reduce((n, s) => n + s.n, 0)
  return (
    <Card title={en ? 'Fragments – thread to ball' : 'Strzępki – po nitce do kłębka'} right={<span className="chip text-xs text-slate-400">{en ? 'live from database' : 'na żywo z bazy'}</span>}>
      <div className="grid grid-cols-3 gap-2 text-center" data-testid="frag-layers">
        {[
          [0, en ? 'fragments' : 'strzępki'],
          [1, en ? 'concepts' : 'pojęcia'],
          [2, en ? 'topics' : 'tematy'],
        ].map(([l, name]) => (
          <div key={l} className="rounded-xl bg-black/20 p-2">
            <div className="text-xl font-semibold tabular-nums" style={{ color: COL[l as number] }} data-testid={`frag-layer-${l}`}>
              {stats ? (by(l as number)?.n ?? 0).toLocaleString('pl-PL') : '…'}
            </div>
            <div className="text-[11px] text-slate-500">
              {en ? 'layer' : 'warstwa'} {l}: {name}
            </div>
          </div>
        ))}
      </div>
      {stats && (
        <p className="mt-2 text-xs text-slate-500">
          {(stats[0]?.links ?? 0).toLocaleString('pl-PL')} {en ? 'links' : 'łączy'} · {stats.reduce((n, s) => n + s.conflict, 0)} {en ? 'conflicts (in Verify)' : 'sprzeczności (w Weryfikuj)'} · {stats.reduce((n, s) => n + s.verified, 0)} {en ? 'verified by you' : 'zweryfikowanych przez Ciebie'}
        </p>
      )}
      {!g && <div className="mt-3 h-72 animate-pulse rounded-xl bg-white/5" />}
      {g && total === 0 && <p className="mt-3 text-sm text-slate-500">{en ? 'No fragments yet.' : 'Jeszcze brak strzępków.'}</p>}
      {g && g.nodes.length > 0 && (
        <svg viewBox="-190 -190 380 380" className="mx-auto mt-3 aspect-square w-full max-w-md" data-testid="frag-graph" data-nodes={g.nodes.length} data-links={g.links.length}>
          {[R[0], R[1], R[2]].map((r) => (
            <circle key={r} r={r} fill="none" stroke="rgba(255,255,255,0.04)" />
          ))}
          {g.links.map((l, i) => {
            const a = pos.get(l.src)
            const b = pos.get(l.dst)
            if (!a || !b) return null
            const on = sel && (sel.id === l.src || sel.id === l.dst)
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? '#e2e8f0' : (layerOf.get(l.dst) ?? 0) === 2 ? 'rgba(167,139,250,0.45)' : 'rgba(94,234,212,0.22)'} strokeWidth={on ? 1.2 : 0.6} />
          })}
          {g.nodes.map((n) => {
            const p = pos.get(n.id)
            if (!p) return null
            return (
              <circle key={n.id} cx={p.x} cy={p.y} r={n.layer === 2 ? 7 : n.layer === 1 ? 3.6 : 2.2} fill={n.status === 'conflict' ? '#fb7185' : n.status === 'verified' ? '#fde68a' : COL[n.layer]} opacity={sel && sel.id !== n.id ? 0.55 : 1} onClick={() => setSel(n)} className="cursor-pointer">
                <title>{fragText(n, en)}</title>
              </circle>
            )
          })}
          {g.nodes
            .filter((n) => n.layer === 2)
            .map((n) => {
              const p = pos.get(n.id)!
              return (
                <text key={`t${n.id}`} x={Math.cos(p.a) * (R[2] + 30)} y={Math.sin(p.a) * (R[2] + 30) + 3} textAnchor="middle" fontSize="7.5" fill="#e2e8f0" stroke="#0b1512" strokeWidth="2.5" paintOrder="stroke">
                  {n.subj}
                </text>
              )
            })}
        </svg>
      )}
      {sel && (
        <p className="mt-2 rounded-xl bg-black/30 p-2 text-sm" data-testid="frag-selected">
          #{sel.id} · {fragText(sel, en)} · {sel.source} · {Math.round(sel.trust * 100)}%
        </p>
      )}
      <h3 className="mt-4 text-xs uppercase tracking-wider text-slate-500">{en ? 'Growth per layer (cumulative)' : 'Wzrost warstw (narastająco)'}</h3>
      <TimeChart
        data={pts}
        series={[
          { key: 'l0', name: en ? 'fragments' : 'strzępki', color: COL[0] },
          { key: 'l1', name: en ? 'concepts' : 'pojęcia', color: COL[1] },
          { key: 'l2', name: en ? 'topics' : 'tematy', color: COL[2] },
          { key: 'links', name: en ? 'links' : 'łącza', color: '#64748b' },
        ]}
      />
    </Card>
  )
}
