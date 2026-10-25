import type { CSSProperties, ReactNode } from 'react'

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">{title}</h1>
      {children && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-400">{children}</p>}
    </header>
  )
}

export type Tone = 'spore' | 'amber' | 'violet' | 'rose' | 'sky'
const TONE_TEXT: Record<Tone, string> = { spore: 'text-spore', amber: 'text-amber', violet: 'text-violet', rose: 'text-rose', sky: 'text-sky' }
const TONE_DOT: Record<Tone, string> = { spore: 'bg-spore', amber: 'bg-amber', violet: 'bg-violet', rose: 'bg-rose', sky: 'bg-sky' }

/** Status weryfikacji liczby (docs/data-provenance.md). */
export type Verif = 'verified' | 'db' | 'self' | 'recorded'
const VERIF: Record<Verif, { pl: string; en: string; cls: string }> = {
  verified: { pl: 'sprawdzone niezależnie', en: 'independently verified', cls: 'text-spore' },
  db: { pl: 'zapis w bazie', en: 'database record', cls: 'text-sky' },
  self: { pl: 'deklarowane przez węzły, bez niezależnej kontroli', en: 'self-reported by nodes, not independently checked', cls: 'text-amber' },
  recorded: { pl: 'nagrany przebieg, bez niezależnej kontroli', en: 'recorded run, not independently checked', cls: 'text-amber' },
}

/** Linia źródła pod liczbą: skąd pochodzi, kiedy zmierzono i czy ktoś to niezależnie sprawdził. */
export function Src({ children, v, en, className = '' }: { children: ReactNode; v?: Verif; en?: boolean; className?: string }) {
  const lang = en ?? (typeof document !== 'undefined' && document.documentElement.lang === 'en')
  return (
    <div className={`mt-1.5 flex items-start gap-1 text-[10.5px] leading-snug text-slate-500 ${className}`} data-testid="src">
      <span aria-label={lang ? 'source' : 'źródło'} className="mt-px grid h-3 w-3 shrink-0 place-items-center rounded-full border border-slate-600 text-[8px] font-semibold not-italic text-slate-400">
        i
      </span>
      <span className="min-w-0">
        {children}
        {v && <span className={`ml-1 ${VERIF[v].cls}`}>· {lang ? VERIF[v].en : VERIF[v].pl}</span>}
      </span>
    </div>
  )
}

export function Kpi({
  label,
  value,
  hint,
  src,
  verif,
  tone = 'spore',
  icon,
  children,
  href,
  testid,
  className = '',
  style,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  /** skąd liczba i kiedy zmierzona (linia „i”) */
  src?: ReactNode
  verif?: Verif
  tone?: Tone
  icon?: ReactNode
  children?: ReactNode
  href?: string
  testid?: string
  className?: string
  style?: CSSProperties
}) {
  const body = (
    <>
      <div className="eyebrow flex min-w-0 items-start gap-2 leading-tight tracking-[0.06em] sm:tracking-[0.1em]">
        {icon ? (
          <span aria-hidden className={`-mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-white/[0.04] text-[13px] tracking-normal ${TONE_TEXT[tone]}`}>
            {icon}
          </span>
        ) : (
          <span aria-hidden className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
        )}
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-[1.75rem] ${TONE_TEXT[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs leading-snug text-slate-400">{hint}</div>}
      {children}
      {src && <Src v={verif}>{src}</Src>}
    </>
  )
  const cls = `card ${className}`
  return href ? (
    <a href={href} className={`${cls} block transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-bark/70`} data-testid={testid} style={style}>
      {body}
    </a>
  ) : (
    <div className={cls} data-testid={testid} style={style}>
      {body}
    </div>
  )
}

export function Card({ title, children, right, className = '' }: { title?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-medium text-slate-200">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  )
}

export function Bar({ value, tone = 'spore' }: { value: number; tone?: Tone }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div className={`bar-in h-full rounded-full ${TONE_DOT[tone]}`} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  )
}

export const tooltipStyle = {
  contentStyle: { background: '#0a1513', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, fontSize: 12 },
  labelStyle: { color: '#e2e8f0' },
  itemStyle: { color: '#cbd5e1' },
}
