import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { activities, describe, eventLabel, type Activity } from '../myc/activity'
import type { Shared } from '../myc/store'
import { ago, Empty, fmtTime } from './TimeChart'

const TONE: Record<string, string> = { accept: 'text-spore', spawn: 'text-spore', reject: 'text-rose', prune: 'text-amber', train: 'text-violet', join: 'text-glow' }

/** Odświeża względny czas co 30 s (dane odświeża mózg co 15 s). */
export function useTick(ms = 30_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

export function When({ t }: { t: string }) {
  const { lang } = useI18n()
  return (
    <span className="tabular-nums" title={`${fmtTime(t, lang)} (Amsterdam)`}>
      {fmtTime(t, lang)} · <span className="text-slate-500">{ago(t, lang)}</span>
    </span>
  )
}

export default function ActivityFeed({ data, filter, limit = 40 }: { data: Shared; filter?: (a: Activity) => boolean; limit?: number }) {
  useTick()
  const en = useI18n().lang === 'en'
  const acts = activities(data, 200).filter(filter ?? (() => true)).slice(0, limit)
  if (!acts.length) return <Empty h="h-24" />
  return (
    <ol className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1 text-sm" data-testid="activity">
      {acts.map((a, i) => (
        <li key={`${a.t}-${a.node}-${i}`} className="grid grid-cols-[auto_1fr] gap-x-3 border-b border-white/5 pb-1.5">
          <span className="text-xs text-slate-400">
            <When t={a.t} />
          </span>
          <span className="min-w-0">
            <b className="text-slate-200">{a.agent}</b> <span className={TONE[a.event] ?? 'text-slate-400'}>{eventLabel(a.event, en)}</span>
            <span className="ml-1 break-words text-xs text-slate-500">{describe(a, en)}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
