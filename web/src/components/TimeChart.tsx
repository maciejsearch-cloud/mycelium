import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useI18n } from '../i18n'
import { tooltipStyle } from './ui'

export type Series = { key: string; name: string; color: string }
export type Point = { t: number } & Record<string, number | null | undefined>

const TZ = 'Europe/Amsterdam'
export const fmtTime = (t: number | string, lang: string, withDate = true) =>
  new Date(t).toLocaleString(lang === 'en' ? 'en-GB' : 'pl-PL', { timeZone: TZ, ...(withDate ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' })

export function ago(t: string | number, lang: string): string {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000)
  const en = lang === 'en'
  if (s < 60) return en ? 'just now' : 'przed chwilą'
  const m = Math.round(s / 60)
  if (m < 60) return en ? `${m} min ago` : `${m} min temu`
  const h = Math.round(m / 60)
  if (h < 48) return en ? `${h} h ago` : `${h} godz. temu`
  const d = Math.round(h / 24)
  return en ? `${d} days ago` : `${d} dni temu`
}

export function Empty({ h = 'h-40' }: { h?: string }) {
  const en = useI18n().lang === 'en'
  return (
    <div className={`flex ${h} items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500`} data-testid="empty">
      {en ? 'no data yet' : 'brak danych jeszcze'}
    </div>
  )
}

/** Szereg czasowy z prawdziwych, zapisanych pomiarów. Brak punktów → pusty stan. */
export function TimeChart({ data, series, unit = '', domain, h = 'h-48' }: { data: Point[]; series: Series[]; unit?: string; domain?: [number | 'auto', number | 'auto']; h?: string }) {
  const { lang } = useI18n()
  const pts = data.filter((p) => series.some((s) => p[s.key] != null)).sort((a, b) => a.t - b.t)
  if (!pts.length) return <Empty h={h} />
  return (
    <div className={h} data-testid="timechart" data-points={pts.length}>
      <ResponsiveContainer>
        <LineChart data={pts} margin={{ left: -12, right: 8, top: 4 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => fmtTime(t, lang)} tick={{ fill: '#94a3b8', fontSize: 10 }} minTickGap={40} />
          <YAxis domain={domain ?? ['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <Tooltip {...tooltipStyle} labelFormatter={(t) => `${fmtTime(t as number, lang)} (Amsterdam)`} formatter={(v) => `${typeof v === 'number' ? Math.round(v * 10) / 10 : v}${unit}`} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} connectNulls dot={pts.length < 30} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
