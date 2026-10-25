import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { SB_KEY, SB_URL } from '../myc/store'
import { Empty, fmtTime, TimeChart, type Point } from './TimeChart'
import { Card, Kpi } from './ui'

type N = { node_id: string; backends: string | null; results: number; updates: number; accepted: number; rejected: number; pending: number; evals: number; hours: number; hours_rejected: number; flops: number; flops_used: number; models_used: string[] | null; first_at: string; last_at: string }
type B = { backend: string; results: number; accepted: number; rejected: number; hours: number; flops: number }
type D = { day: string; accepted: number; rejected: number; hours: number; hours_rejected: number }

const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const get = <T,>(q: string) => fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
const tf = (f: number) => (f / 1e12).toLocaleString(undefined, { maximumFractionDigits: f < 1e13 ? 2 : 0 })

/** Wkład węzłów: prawdziwe agregaty myc_results (widoki myc_node_contrib / myc_backend_contrib / myc_daily_contrib). */
export function NodeContrib() {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [ns, setNs] = useState<N[] | null | undefined>()
  const [bs, setBs] = useState<B[] | null | undefined>()
  const [ds, setDs] = useState<D[] | null | undefined>()
  useEffect(() => {
    get<N[]>('myc_node_contrib?select=*&order=hours.desc&limit=2000').then(setNs, () => setNs(null))
    get<B[]>('myc_backend_contrib?select=*').then(setBs, () => setBs(null))
    get<D[]>('myc_daily_contrib?select=*&order=day').then(setDs, () => setDs(null))
  }, [])
  const upd = (ns ?? []).reduce((a, n) => a + n.updates, 0)
  const acc = (ns ?? []).reduce((a, n) => a + n.accepted, 0)
  const hrs = (ns ?? []).reduce((a, n) => a + +n.hours, 0)
  const hrsRej = (ns ?? []).reduce((a, n) => a + +n.hours_rejected, 0)
  const gpu = (bs ?? []).find((b) => b.backend === 'webgpu')
  const native = (bs ?? []).filter((b) => b.backend === 'cuda' || b.backend === 'directml')
  const off = (x: unknown) => x === null
  const dash = (x: unknown, v: ReactNode) => (off(x) ? '—' : x === undefined ? '…' : v)
  const pts: Point[] = (ds ?? []).map((d) => ({ t: Date.parse(`${d.day}T12:00:00`), acc: d.accepted, rej: d.rejected }))
  const kind = (n: N) => ((n.backends ?? '').split(',').every((b) => b === 'cpu') ? (en ? 'Python node (CPU)' : 'węzeł Python (CPU)') : en ? 'browser' : 'przeglądarka')
  return (
    <Card title={en ? 'Node contribution (real stored results)' : 'Wkład węzłów (prawdziwe zapisane wyniki)'} className="mt-4">
      <div data-testid="node-contrib">
        <p className="mb-3 text-xs text-slate-400">
          {en
            ? 'An update counts as used only when it went into a published model version (FedAvg + independent check). Rejected = the no-regression gate turned the round down. Device type (PC/phone) is not stored, only the compute backend.'
            : 'Aktualizacja jest „wykorzystana” tylko, gdy weszła do opublikowanej wersji modelu (FedAvg + niezależna ocena). Odrzucona = bramka bez regresji nie przyjęła rundy. Typ urządzenia (PC/telefon) nie jest zapisywany – tylko backend obliczeń.'}
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={en ? 'Updates used' : 'Aktualizacje wykorzystane'} value={dash(ns, `${acc.toLocaleString(lang)} / ${upd.toLocaleString(lang)}`)} hint={ns && upd ? `${((acc / upd) * 100).toFixed(1)}%` : ''} tone="spore" src={en ? 'myc_node_contrib: used = in a version published after independent re-evaluation' : 'myc_node_contrib: wykorzystane = w wersji opublikowanej po niezależnej ponownej ocenie'} verif="verified" />
          <Kpi label={en ? 'Compute time' : 'Czas obliczeń'} value={dash(ns, `${hrs.toFixed(1)} h`)} hint={ns ? `${en ? 'rejected' : 'odrzucone'}: ${hrsRej.toFixed(1)} h` : ''} tone="amber" src={en ? 'sum of time reported by nodes with each result' : 'suma czasu zgłaszanego przez węzły z każdym wynikiem'} verif="self" />
          <Kpi label="GPU (WebGPU)" value={dash(bs, gpu ? `${gpu.results.toLocaleString(lang)}` : '0')} hint={gpu ? `${en ? 'used' : 'wykorzystane'} ${gpu.accepted} · ${gpu.hours} h` : en ? 'no GPU results' : 'brak wyników GPU'} tone="violet" src="myc_backend_contrib" verif="db" />
          <Kpi
            label={en ? 'Nodes with results' : 'Węzły z wynikami'}
            value={dash(ns, ns?.length ?? 0)}
            hint={bs ? (native.length ? `CUDA/DirectML: ${native.reduce((a, b) => a + b.results, 0).toLocaleString(lang)} ${en ? 'results' : 'wyników'}` : en ? 'CUDA/DirectML: no results yet' : 'CUDA/DirectML: brak wyników') : ''}
            src="myc_node_contrib, myc_backend_contrib"
            verif="db"
          />
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs text-slate-400">{en ? 'Updates per day: used vs rejected' : 'Aktualizacje dziennie: wykorzystane i odrzucone'}</div>
          <TimeChart data={pts} series={[{ key: 'acc', name: en ? 'used' : 'wykorzystane', color: '#34d399' }, { key: 'rej', name: en ? 'rejected' : 'odrzucone', color: '#f87171' }]} h="h-40" />
        </div>
        {ns && !ns.length && <Empty h="h-10" />}
        {ns && ns.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums" data-testid="node-contrib-table">
              <thead>
                <tr className="text-slate-500">
                  <th>{en ? 'node' : 'węzeł'}</th>
                  <th>{en ? 'type' : 'rodzaj'}</th>
                  <th>{en ? 'used / rejected' : 'wykorzystane / odrzucone'}</th>
                  <th>{en ? 'hours' : 'godziny'}</th>
                  <th>TFLOP</th>
                  <th>{en ? 'models' : 'modele'}</th>
                  <th>{en ? 'last' : 'ostatnio'}</th>
                </tr>
              </thead>
              <tbody>
                {ns.map((n) => (
                  <tr key={n.node_id} className="border-t border-white/5">
                    <td className="font-mono">{n.node_id.slice(0, 8)}</td>
                    <td>
                      {kind(n)} <span className="text-slate-500">({n.backends})</span>
                    </td>
                    <td className={n.updates && n.rejected / n.updates > 0.9 ? 'text-rose-300' : ''}>
                      {n.accepted} / {n.rejected}
                      {n.pending ? ` (+${n.pending})` : ''}
                    </td>
                    <td>{n.hours}</td>
                    <td>
                      {tf(n.flops_used)} / {tf(n.flops)}
                    </td>
                    <td>{(n.models_used ?? []).join(', ') || '—'}</td>
                    <td>{fmtTime(n.last_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  )
}
