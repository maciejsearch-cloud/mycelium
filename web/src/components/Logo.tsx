import { useId } from 'react'

/** Znak Mycelium AI: rdzeń grzybni i rozgałęzione strzępki (oryginalny projekt, ten sam co favicon/ikony). */
export function LogoMark({ size = 36, tile = true, className = '' }: { size?: number; tile?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '')
  const h = `h${id}`
  const c = `c${id}`
  const bg = `b${id}`
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={h} x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset=".55" stopColor="#7dd3fc" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
        <radialGradient id={c} cx="29" cy="33" r="9" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0fdfa" />
          <stop offset=".6" stopColor="#99f6e4" />
          <stop offset="1" stopColor="#5eead4" />
        </radialGradient>
        <linearGradient id={bg} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0f2a25" />
          <stop offset="1" stopColor="#060f0d" />
        </linearGradient>
      </defs>
      {tile && <rect width="64" height="64" rx="15" fill={`url(#${bg})`} />}
      <g transform={tile ? 'translate(5.5 4.8) scale(.84)' : undefined}>
        <g fill="none" stroke={`url(#${h})`} strokeLinecap="round">
          <g strokeWidth="4.2" className="logo-hypha">
            <path d="M29 33C22 31 18 22 12 13" />
            <path d="M29 33C35 26 39 16 47 10" />
            <path d="M29 33C38 35 47 33 55 39" />
            <path d="M29 33C28 42 33 49 39 56" />
            <path d="M29 33C22 37 16 42 8 44" />
          </g>
          <g strokeWidth="2.6" opacity=".8">
            <path d="M17 21C13 22 9 24 6 28" />
            <path d="M39 18C45 19 50 20 56 18" />
            <path d="M46 35C49 40 49 45 47 50" />
            <path d="M32 47C27 50 24 54 21 58" />
          </g>
        </g>
        <circle cx="12" cy="13" r="5" fill="#5eead4" />
        <circle cx="47" cy="10" r="4.2" fill="#67e8f9" />
        <circle cx="55" cy="39" r="4.8" fill="#a78bfa" />
        <circle cx="39" cy="56" r="4.2" fill="#a78bfa" />
        <circle cx="8" cy="44" r="4" fill="#7dd3fc" />
        <g fill="#99f6e4">
          <circle cx="6" cy="28" r="2.4" />
          <circle cx="56" cy="18" r="2.4" />
        </g>
        <g fill="#c4b5fd">
          <circle cx="47" cy="50" r="2.4" />
          <circle cx="21" cy="58" r="2.4" />
        </g>
        <circle cx="29" cy="33" r="8.5" fill={`url(#${c})`} className="logo-core" />
      </g>
    </svg>
  )
}

export function Wordmark({ sub }: { sub?: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[1.05rem] font-semibold tracking-tight text-slate-50">
        Mycelium <span className="bg-gradient-to-r from-spore to-violet bg-clip-text text-transparent">AI</span>
      </div>
      {sub && <div className="hidden text-[11px] text-slate-400 sm:block">{sub}</div>}
    </div>
  )
}
