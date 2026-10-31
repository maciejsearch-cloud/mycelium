import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import { SB_KEY, SB_URL } from '../myc/store'
import { ago, Empty, TimeChart, type Point } from '../components/TimeChart'
import { Card, Kpi, PageHeader } from '../components/ui'

// Moc – prawdziwa telemetria węzłów (myc_moc: co minutę, 48 h; myc_moc_hour: średnie godzinowe, 30 dni).
// Liczby wysyła sam węzeł (src/iot_mycelium/mesh/moc.py); brak odczytu GPU = „brak danych GPU”, nic nie jest dorysowywane.
type Row = {
  node_id: string
  at: string
  iv: number
  cpu: number | null
  cpu_max: number | null
  cpu_proc: number | null
  gpu: number | null
  mem: number | null
  rss_mb: number | null
  threads: number
  device: string
  work: Record<string, number>
}
type Hour = Omit<Row, 'at' | 'iv'> & { hour: string; n: number }

const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const get = <T,>(q: string) =>
  fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))

export const WORK: Record<string, [string, string, string]> = {
  lm_train: ['trening modelu językowego', 'language-model training', '#5eead4'],
  lm_distill: ['trening z destylacją', 'training with distillation', '#2dd4bf'],
  lm_eval: ['ocena wersji (bramka)', 'version evaluation (gate)', '#38bdf8'],
  lm_aggregate: ['ocena kandydatów przy łączeniu', 'candidate evaluation on merge', '#818cf8'],
  rozbior: ['rozbiór zdań', 'sentence parsing', '#f472b6'],
  taxo: ['słowa i strzępki', 'words and fragments', '#fbbf24'],
  verify: ['weryfikacja', 'verification', '#a3e635'],
  images: ['obrazy', 'images', '#fb923c'],
  wallet: ['zatwierdzanie transakcji portfela', 'wallet transaction validation', '#e879f9'],
}
const COLORS = ['#5eead4', '#38bdf8', '#f472b6', '#fbbf24', '#a3e635', '#818cf8']
const short = (id: string) => id.slice(0, 8)
const pct = (x: number | null | undefined) => (x == null ? null : `${Math.round(x)}%`)

export default function Moc() {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [rows, setRows] = useState<Row[] | undefined>()
  const [hours, setHours] = useState<Hour[] | undefined>()
  const [err, setErr] = useState(false)
  useEffect(() => {
    const load = () => {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString()
      get<Row[]>(`myc_moc?select=node_id,at,iv,cpu,cpu_max,cpu_proc,gpu,mem,rss_mb,threads,device,work&at=gt.${since}&order=at&limit=5000`).then(
        (r) => (setRows(r), setErr(false)),
        () => (setRows([]), setErr(true)),
      )
      const since7 = new Date(Date.now() - 7 * 86400_000).toISOString()
      get<Hour[]>(`myc_moc_hour?select=node_id,hour,n,cpu,cpu_max,cpu_proc,gpu,mem,rss_mb,threads,device,work&hour=gt.${since7}&order=hour&limit=5000`).then(setHours, () => setHours([]))
    }
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const nodes = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows ?? []) m.set(r.node_id, [...(m.get(r.node_id) ?? []), r])
    return [...m.entries()].sort((a, b) => Date.parse(b[1].at(-1)!.at) - Date.parse(a[1].at(-1)!.at))
  }, [rows])
  const live = nodes.filter(([, rs]) => Date.now() - Date.parse(rs.at(-1)!.at) < 5 * 60_000)

  // na co poszła moc: sekundy pracy wg rodzaju (ostatnia godzina i 7 dni z godzinowych średnich)
  const workSum = (rs: { work: Record<string, number> }[]) => {
    const o: Record<string, number> = {}
    for (const r of rs) for (const [k, v] of Object.entries(r.work ?? {})) o[k] = (o[k] ?? 0) + v
    return o
  }
  const lastHour = workSum((rows ?? []).filter((r) => Date.now() - Date.parse(r.at) < 3600_000))
  const week = workSum([...(hours ?? []), ...(rows ?? []).filter((r) => !hours?.some((h) => h.node_id === r.node_id && Date.parse(h.hour) === Math.floor(Date.parse(r.at) / 3600_000) * 3600_000))])
  const sumH = Object.values(lastHour).reduce((a, b) => a + b, 0)
  const sumW = Object.values(week).reduce((a, b) => a + b, 0)

  const series = nodes.slice(0, 6).map(([id], i) => ({ id, color: COLORS[i % COLORS.length] }))
  const chart = (key: 'cpu_proc' | 'cpu' | 'gpu'): Point[] =>
    (rows ?? []).filter((r) => series.some((s) => s.id === r.node_id)).map((r) => ({ t: Date.parse(r.at), [short(r.node_id)]: r[key] }))
  const hourChart: Point[] = (hours ?? []).map((h) => ({ t: Date.parse(h.hour), [short(h.node_id)]: h.cpu_proc }))
  const gpuAny = (rows ?? []).some((r) => r.gpu != null)

  const Bar = ({ w, total }: { w: Record<string, number>; total: number }) =>
    total <= 0 ? (
      <p className="text-sm text-slate-500">{en ? 'No reported work in this period.' : 'Brak zgłoszonej pracy w tym okresie.'}</p>
    ) : (
      <div>
        <div className="flex h-3 overflow-hidden rounded-full bg-white/5">
          {Object.entries(w)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <div key={k} title={k} style={{ width: `${(v / total) * 100}%`, background: WORK[k]?.[2] ?? '#94a3b8' }} />
            ))}
        </div>
        <ul className="mt-2 grid gap-1 text-xs text-slate-300 sm:grid-cols-2">
          {Object.entries(w)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <li key={k} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: WORK[k]?.[2] ?? '#94a3b8' }} />
                {WORK[k]?.[en ? 1 : 0] ?? k}: {v >= 3600 ? `${(v / 3600).toFixed(1)} h` : `${Math.round(v / 60)} min`} ({Math.round((v / total) * 100)}%)
              </li>
            ))}
        </ul>
      </div>
    )

  return (
    <div data-testid="moc">
      <PageHeader title={en ? 'Compute' : 'Moc'}>
        {en
          ? 'Live CPU/GPU use reported by the nodes every minute, and what the power was spent on. Only nodes that report telemetry are shown; a device that does not report GPU use shows “no GPU data”.'
          : 'Na żywo: ile CPU i GPU zużywają węzły (raport co minutę) i na co poszła ta moc. Widać tylko węzły, które wysyłają telemetrię; gdy urządzenie nie podaje użycia GPU, jest „brak danych GPU”.'}
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={en ? 'Nodes reporting now' : 'Węzły raportujące teraz'} value={rows ? live.length : '…'} hint={en ? 'report in the last 5 min' : 'raport w ostatnich 5 min'} src="myc_moc" verif="self" />
        <Kpi
          label={en ? 'Node CPU (avg, now)' : 'CPU węzłów (średnio, teraz)'}
          value={rows ? (live.length ? pct(live.reduce((a, [, rs]) => a + (rs.at(-1)!.cpu_proc ?? 0), 0) / live.length) ?? '—' : '—') : '…'}
          hint={en ? 'share of all cores used by the node process' : 'udział wszystkich rdzeni zajęty przez proces węzła'}
          src="myc_moc.cpu_proc"
          verif="self"
        />
        <Kpi
          label={en ? 'GPU (now)' : 'GPU (teraz)'}
          value={rows ? (live.some(([, rs]) => rs.at(-1)!.gpu != null) ? pct(Math.max(...live.map(([, rs]) => rs.at(-1)!.gpu ?? 0))) ?? '—' : en ? 'no GPU data' : 'brak danych GPU') : '…'}
          hint={en ? 'max over nodes that report GPU' : 'maks. z węzłów, które podają GPU'}
          tone="violet"
          src="myc_moc.gpu"
          verif="self"
        />
        <Kpi label={en ? 'Work, last hour' : 'Praca, ostatnia godzina'} value={rows ? `${Math.round(sumH / 60)} min` : '…'} hint={en ? 'summed over nodes' : 'suma po węzłach'} tone="amber" src="myc_moc.work" verif="self" />
      </div>

      {err && <p className="mb-4 text-sm text-rose-300">{en ? 'Could not load telemetry.' : 'Nie udało się wczytać telemetrii.'}</p>}

      <Card title={en ? 'What the power went to – last hour' : 'Na co poszła moc – ostatnia godzina'} className="mb-4">
        {rows ? <Bar w={lastHour} total={sumH} /> : <p className="text-sm text-slate-500">…</p>}
      </Card>

      <Card title={en ? 'Nodes now' : 'Węzły teraz'} className="mb-4">
        {!rows ? (
          <p className="text-sm text-slate-500">…</p>
        ) : !nodes.length ? (
          <p className="text-sm text-slate-400" data-testid="moc-empty">
            {en ? 'No node has reported telemetry in the last 6 hours.' : 'Żaden węzeł nie wysłał telemetrii w ostatnich 6 godzinach.'}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="moc-nodes">
            {nodes.map(([id, rs]) => {
              const r = rs.at(-1)!
              const on = Date.now() - Date.parse(r.at) < 5 * 60_000
              const w = workSum(rs.filter((x) => Date.now() - Date.parse(x.at) < 3600_000))
              const tot = Object.values(w).reduce((a, b) => a + b, 0)
              return (
                <div key={id} className="rounded-xl border border-white/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-slate-100">{short(id)}</span>
                    <span className={`text-xs ${on ? 'text-spore' : 'text-slate-500'}`}>
                      {on ? (en ? 'live' : 'na żywo') : en ? 'offline' : 'offline'} · {ago(r.at, lang)}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-slate-400">{en ? 'node process CPU' : 'CPU procesu węzła'}</dt>
                    <dd className="text-right text-slate-100">{pct(r.cpu_proc) ?? '—'}</dd>
                    <dt className="text-slate-400">{en ? 'whole computer CPU' : 'CPU całego komputera'}</dt>
                    <dd className="text-right text-slate-100">{pct(r.cpu) ?? (en ? 'no data' : 'brak danych')}</dd>
                    <dt className="text-slate-400">GPU</dt>
                    <dd className="text-right text-slate-100">{pct(r.gpu) ?? (en ? 'no GPU data' : 'brak danych GPU')}</dd>
                    <dt className="text-slate-400">{en ? 'memory (computer)' : 'pamięć (komputer)'}</dt>
                    <dd className="text-right text-slate-100">{pct(r.mem) ?? '—'}</dd>
                    <dt className="text-slate-400">{en ? 'node RAM' : 'RAM węzła'}</dt>
                    <dd className="text-right text-slate-100">{r.rss_mb != null ? `${(r.rss_mb / 1024).toFixed(1)} GB` : '—'}</dd>
                    <dt className="text-slate-400">{en ? 'threads · device' : 'wątki · urządzenie'}</dt>
                    <dd className="text-right text-slate-100">
                      {r.threads} · {r.device === 'directml' ? 'GPU (DirectML)' : r.device === 'cuda' ? 'GPU (CUDA)' : 'CPU'}
                    </dd>
                  </dl>
                  <div className="mt-2">
                    <Bar w={w} total={tot} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Card title={en ? 'Node process CPU – last 6 h (per node)' : 'CPU procesu węzła – ostatnie 6 h (każdy węzeł)'} className="mb-4">
        {rows && rows.length ? <TimeChart data={chart('cpu_proc')} series={series.map((s) => ({ key: short(s.id), name: short(s.id), color: s.color }))} unit="%" domain={[0, 100]} /> : <Empty />}
      </Card>
      <Card title={en ? 'GPU – last 6 h' : 'GPU – ostatnie 6 h'} className="mb-4">
        {gpuAny ? (
          <TimeChart data={chart('gpu')} series={series.map((s) => ({ key: short(s.id), name: short(s.id), color: s.color }))} unit="%" domain={[0, 100]} />
        ) : (
          <p className="text-sm text-slate-400" data-testid="moc-nogpu">
            {en ? 'No GPU data: none of the reporting nodes exposes GPU utilisation.' : 'Brak danych GPU: żaden z raportujących węzłów nie podaje użycia GPU.'}
          </p>
        )}
      </Card>
      <Card title={en ? 'Hourly averages – 7 days' : 'Średnie godzinowe – 7 dni'} className="mb-4">
        {hours && hours.length ? (
          <TimeChart data={hourChart} series={[...new Set(hours.map((h) => short(h.node_id)))].slice(0, 6).map((k, i) => ({ key: k, name: k, color: COLORS[i % COLORS.length] }))} unit="%" domain={[0, 100]} />
        ) : (
          <Empty />
        )}
        <div className="mt-3">
          <p className="mb-1 text-xs text-slate-400">{en ? 'What the power went to – 7 days' : 'Na co poszła moc – 7 dni'}</p>
          <Bar w={week} total={sumW} />
        </div>
      </Card>
      <p className="text-xs text-slate-500">
        {en
          ? 'Source: myc_moc (per-minute reports, kept 48 h) and myc_moc_hour (hourly averages, 30 days). Nodes send only numbers – no computer name, no IP. Browser nodes do not report CPU/GPU use yet.'
          : 'Źródło: myc_moc (raporty co minutę, 48 h) i myc_moc_hour (średnie godzinowe, 30 dni). Węzły wysyłają tylko liczby – bez nazwy komputera i bez IP. Węzły w przeglądarce nie podają jeszcze użycia CPU/GPU.'}
      </p>
    </div>
  )
}
