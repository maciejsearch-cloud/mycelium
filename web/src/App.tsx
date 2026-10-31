import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LogoMark, Wordmark } from './components/Logo'
import { Icon } from './components/Icon'
import { setTheme, themeStore } from './myc/theme'
import { fmtDate, useData } from './data'
import { LangSwitch, useI18n } from './i18n'
import { captureRef } from './myc/account'
import { badges, type BadgeKey } from './myc/badges'
import Overview from './pages/Overview'

const RealAI = lazy(() => import('./pages/RealAI'))
const Czysta = lazy(() => import('./pages/Czysta'))
const Teach = lazy(() => import('./pages/Teach'))
const Chat = lazy(() => import('./pages/Chat'))
const GlobalChat = lazy(() => import('./pages/GlobalChat'))
const Tasks = lazy(() => import('./pages/Tasks'))
const SessionPage = lazy(() => import('./pages/Session'))
const Knowledge = lazy(() => import('./pages/Knowledge'))
const Growth = lazy(() => import('./pages/Growth'))
const ProgressPage = lazy(() => import('./pages/Progress'))
const Verification = lazy(() => import('./pages/Verification'))
const NodePage = lazy(() => import('./pages/Node'))
const Review = lazy(() => import('./pages/Review'))
const Taxonomy = lazy(() => import('./pages/Taxonomy'))
const AccountPage = lazy(() => import('./pages/Account'))
const CirclesPage = lazy(() => import('./pages/CirclesPage'))

const PAGES = [
  { id: 'overview', label: 'Przegląd', icon: 'home' },
  { id: 'chat', label: 'Rozmowa z AI', icon: 'chat' },
  { id: 'czat', label: 'Czat globalny', icon: 'globe' },
  { id: 'czysta', label: 'Czysta grzybnia', icon: 'hypha' },
  { id: 'kregi', label: 'Kręgi', icon: 'circles' },
  { id: 'teach', label: 'Ucz AI', icon: 'teach' },
  { id: 'tasks', label: 'Zadania', icon: 'tasks' },
  { id: 'weryfikuj', label: 'Weryfikuj', icon: 'check' },
  { id: 'node', label: 'Zostań węzłem', icon: 'node' },
  { id: 'session', label: 'Sesja', icon: 'bolt' },
  { id: 'growth', label: 'Wzrost', icon: 'growth' },
  { id: 'knowledge', label: 'Wiedza', icon: 'book' },
  { id: 'taxonomy', label: 'Taksonomia', icon: 'tree' },
  { id: 'ai', label: 'Prawdziwe AI', icon: 'spark' },
  { id: 'verify', label: 'Dowody', icon: 'proof' },
  { id: 'progress', label: 'Postępy projektu', icon: 'flag' },
  { id: 'konto', label: 'Konto', icon: 'user' },
] as const
type PageId = (typeof PAGES)[number]['id']

/** Grupy nawigacji (docs/ux-proposals.md): 5 głównych + „Więcej”. Stare adresy #/… zostają – każda strona należy do grupy. */
const GROUPS: { id: string; label: string; icon: string; pages: PageId[]; badge?: BadgeKey }[] = [
  { id: 'start', label: 'Start', icon: 'home', pages: ['overview'] },
  { id: 'rozmowa', label: 'Rozmowa', icon: 'chat', pages: ['chat', 'czysta', 'czat', 'kregi'] },
  { id: 'ucz', label: 'Ucz', icon: 'teach', pages: ['teach', 'tasks'], badge: 'teach' },
  { id: 'weryfikuj', label: 'Weryfikuj', icon: 'check', pages: ['weryfikuj'], badge: 'weryfikuj' },
  { id: 'wezel', label: 'Węzeł', icon: 'node', pages: ['node', 'session'] },
  { id: 'wiecej', label: 'Więcej', icon: 'more', pages: ['growth', 'knowledge', 'taxonomy', 'ai', 'verify', 'progress', 'konto'] },
]
const groupOf = (p: PageId) => GROUPS.find((g) => g.pages.includes(p))!
const pageMeta = (p: PageId) => PAGES.find((x) => x.id === p)!
const BADGE_OF: Partial<Record<PageId, BadgeKey>> = { teach: 'teach', weryfikuj: 'weryfikuj' }

function usePage(): [PageId, (p: PageId) => void] {
  const read = () => (PAGES.find((p) => `#/${p.id}` === location.hash)?.id ?? 'overview') as PageId
  const [page, setPage] = useState<PageId>(read)
  useEffect(() => {
    const on = () => setPage(read())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return [page, (p) => (location.hash = `/${p}`)]
}

function useBadge(k?: BadgeKey) {
  useSyncExternalStore(badges.subscribe, badges.version)
  return k ? badges.get(k) : null
}

function Badge({ k, className = '' }: { k?: BadgeKey; className?: string }) {
  const { lang } = useI18n()
  const b = useBadge(k)
  if (!b || b.n <= 0) return null
  const when = new Date(b.at).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
  return (
    <span
      data-testid={`badge-${k}`}
      title={lang === 'en' ? `${b.more ? 'at least ' : ''}${b.n} waiting (counted at ${when})` : `${b.more ? 'co najmniej ' : ''}${b.n} czeka (policzone o ${when})`}
      className={`inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-amber px-1 text-[0.65rem] font-semibold leading-[1.15rem] text-ink ${className}`}
    >
      {b.n > 99 ? '99+' : `${b.n}${b.more ? '+' : ''}`}
    </span>
  )
}

export default function App() {
  const { snap, progress, source, error } = useData()
  const [page, go] = usePage()
  const { t } = useI18n()
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const group = groupOf(page)
  const [more, setMore] = useState(false)
  useEffect(() => {
    setMore(false)
    window.scrollTo({ top: 0 })
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [page])
  useEffect(() => captureRef(), [])
  // węzeł modelu grzybni (fragmenty LLM) wznawia się po odświeżeniu; ?shard=N włącza go z linku
  useEffect(() => {
    const q = Number(new URLSearchParams(location.search).get('shard') ?? localStorage.getItem('myc.meshNode') ?? 0)
    if (q > 0) void import('./mesh/mesh').then((m) => m.mesh.serve(Math.min(6, q)))
  }, [])
  // trwająca sesja (24 h) wznawia się po odświeżeniu, na dowolnej stronie
  useEffect(() => {
    try {
      const st = JSON.parse(localStorage.getItem('myc.session') ?? '{}') as { start?: number }
      if (st.start && Date.now() - st.start < 24 * 3600_000) void import('./myc/session').then((m) => m.session.resume())
    } catch {
      /* brak sesji */
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-dvh max-w-[90rem] flex-col lg:flex-row lg:gap-8 lg:px-6 lg:pt-6">
      <aside className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink/75 backdrop-blur-xl lg:top-6 lg:flex lg:h-[calc(100dvh-3rem)] lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:rounded-[1.5rem] lg:border lg:border-white/[0.07] lg:bg-moss/50 lg:p-3 lg:shadow-[0_30px_60px_-40px_rgb(0_0_0/0.9)]">
        <div className="flex items-center justify-between gap-2 px-3 py-2 sm:px-6 lg:px-2 lg:py-1.5">
          <a href="#/overview" className="flex items-center gap-2.5 rounded-xl py-1" aria-label="Mycelium AI">
            <LogoMark size={36} className="logo-live shrink-0 drop-shadow-[0_0_14px_rgb(94_234_212/0.25)]" />
            <Wordmark sub={t('agenci IoT · wspólna grzybnia')} />
          </a>
          <div className="flex items-center gap-1.5 lg:hidden">
            <span className="hidden sm:inline-flex">
              <SourceBadge source={source} />
            </span>
            <ThemeToggle />
            <LangSwitch />
            <a
              href="#/konto"
              data-testid="account-icon"
              aria-label={t('Konto')}
              aria-current={page === 'konto' ? 'page' : undefined}
              className={`grid h-9 w-9 place-items-center rounded-full border ${page === 'konto' ? 'border-spore/50 bg-spore/15 text-glow' : 'border-white/10 text-slate-300 hover:border-white/20'}`}
            >
              <Icon name="user" size={17} />
            </a>
          </div>
        </div>
        {/* telefon: podzakładki bieżącej grupy (gdy jest ich więcej niż jedna) */}
        {group.pages.length > 1 && (
          <nav aria-label={t('Podzakładki')} data-testid="subtabs" className="no-scrollbar mt-2 flex gap-1 overflow-x-auto px-3 pb-2 sm:px-6 lg:hidden">
            {group.pages.map((id) => (
              <button
                key={id}
                ref={page === id ? activeRef : undefined}
                onClick={() => go(id)}
                aria-current={page === id ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${
                  page === id ? 'bg-spore/15 font-medium text-glow ring-1 ring-spore/35' : 'text-slate-400 ring-1 ring-white/10 hover:text-slate-200'
                }`}
              >
                <Icon name={pageMeta(id).icon} size={15} className={page === id ? 'text-spore' : 'opacity-70'} />
                {t(pageMeta(id).label)}
                <Badge k={BADGE_OF[id]} />
              </button>
            ))}
          </nav>
        )}
        {/* komputer: boczne menu w 6 grupach */}
        <nav aria-label={t('Sekcje')} className="mt-5 hidden flex-col gap-4 lg:flex">
          {GROUPS.map((g) => (
            <div key={g.id}>
              <div className="px-3 pb-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">{t(g.label)}</div>
              <div className="flex flex-col gap-0.5">
                {g.pages.map((id) => {
                  const p = pageMeta(id)
                  return (
                    <button
                      key={id}
                      onClick={() => go(id)}
                      aria-current={page === id ? 'page' : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm ${
                        page === id
                          ? 'bg-gradient-to-r from-spore/[0.16] to-spore/[0.02] font-medium text-glow'
                          : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                      }`}
                    >
                      {page === id && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-spore shadow-[0_0_12px_rgb(94_234_212/0.8)]" />}
                      <Icon name={p.icon} size={17} className={page === id ? 'text-spore' : 'opacity-75 group-hover:opacity-100'} />
                      <span className="flex-1">{t(p.label)}</span>
                      <Badge k={BADGE_OF[id]} />
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2.5 border-t border-white/[0.06] px-2 pt-4 text-xs text-slate-500 lg:block">
          <SourceBadge source={source} />
          <div className="flex items-center gap-2">
            <LangSwitch />
            <ThemeToggle />
          </div>
          {snap && (
            <p>
              {t('Dane z')}: {fmtDate(snap.generated_at)}
            </p>
          )}
          <p>
            <a className="inline-flex items-center gap-1.5 hover:text-slate-200" href="https://github.com/maciejsearch-cloud/mycelium">
              <Icon name="repo" size={14} />
              {t('Repozytorium')}
            </a>
          </p>
        </div>
      </aside>
      <BottomBar page={page} go={go} more={more} setMore={setMore} />
      <main className="min-w-0 flex-1 overflow-x-clip px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 lg:px-0 lg:pb-16 lg:pt-0">
        {error && <div className="card border-rose/30 text-rose">
            {t('Nie udało się wczytać danych')}: {error}
          </div>}
        {!snap && !error && <Skeleton />}
        {snap && (
          <Suspense fallback={<Skeleton />}>
            {page === 'overview' && <Overview snap={snap} progress={progress} go={go} />}
            {page === 'chat' && <Chat />}
            {page === 'czat' && <GlobalChat />}
            {page === 'czysta' && <Czysta />}
            {page === 'teach' && <Teach />}
            {page === 'weryfikuj' && <Review />}
            {page === 'taxonomy' && <Taxonomy />}
            {page === 'tasks' && <Tasks />}
            {page === 'node' && <NodePage />}
            {page === 'session' && <SessionPage />}
            {page === 'knowledge' && <Knowledge />}
            {page === 'growth' && <Growth />}
            {page === 'ai' && <RealAI snap={snap} />}
            {page === 'verify' && <Verification />}
            {page === 'progress' && <ProgressPage progress={progress} />}
            {page === 'konto' && <AccountPage />}
            {page === 'kregi' && <CirclesPage />}
          </Suspense>
        )}
      </main>
    </div>
  )
}

/** Telefon: dolny pasek z 5 grupami + „Więcej” (arkusz z resztą stron). */
function BottomBar({ page, go, more, setMore }: { page: PageId; go: (p: PageId) => void; more: boolean; setMore: (v: boolean) => void }) {
  const { t } = useI18n()
  const cur = groupOf(page)
  const wiecej = GROUPS[GROUPS.length - 1]
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 bg-[rgb(0_0_0/0.55)] backdrop-blur-sm lg:hidden" onClick={() => setMore(false)}>
          <div
            role="dialog"
            aria-label={t('Więcej')}
            data-testid="more-sheet"
            className="fade-up absolute inset-x-0 bottom-0 rounded-t-[1.75rem] border-t border-white/10 bg-moss px-3 pb-[calc(5.75rem+env(safe-area-inset-bottom))] pt-3 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
            <div className="eyebrow mb-2 px-1">{t('Więcej')}</div>
            <div className="grid grid-cols-2 gap-2">
              {wiecej.pages.map((id) => {
                const p = pageMeta(id)
                return (
                  <button
                    key={id}
                    onClick={() => go(id)}
                    aria-current={page === id ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-2xl px-3 py-3 text-left text-sm ${page === id ? 'bg-spore/15 text-glow ring-1 ring-spore/30' : 'bg-white/[0.04] text-slate-200 ring-1 ring-white/[0.05]'}`}
                  >
                    <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-spore/10 text-spore">
                      <Icon name={p.icon} size={17} />
                    </span>
                    {t(p.label)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
      <nav
        aria-label={t('Główne')}
        data-testid="bottom-bar"
        className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-6 border-t border-white/[0.08] bg-ink/85 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        {GROUPS.map((g) => {
          const active = g.id === 'wiecej' ? more || (cur.id === g.id && !more) : cur.id === g.id && !more
          return (
            <button
              key={g.id}
              data-testid={`tab-${g.id}`}
              onClick={() => (g.id === 'wiecej' ? setMore(!more) : (setMore(false), go(cur.id === g.id ? page : g.pages[0])))}
              aria-current={cur.id === g.id ? 'page' : undefined}
              aria-expanded={g.id === 'wiecej' ? more : undefined}
              className={`relative flex flex-col items-center gap-1 pb-1.5 pt-2 text-[0.68rem] font-medium ${active ? 'text-glow' : 'text-slate-400'}`}
            >
              <span aria-hidden className={`grid h-7 w-12 place-items-center rounded-full ${active ? 'bg-spore/15 text-spore shadow-[0_0_16px_-2px_rgb(94_234_212/0.45)]' : ''}`}>
                <Icon name={g.icon} size={19} strokeWidth={active ? 2 : 1.75} />
              </span>
              {t(g.label)}
              <Badge k={g.badge} className="absolute right-[14%] top-1" />
            </button>
          )
        })}
      </nav>
    </>
  )
}

function ThemeToggle() {
  const { t } = useI18n()
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get)
  const light = theme === 'light'
  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={() => setTheme(light ? 'dark' : 'light')}
      aria-label={light ? t('Motyw ciemny') : t('Motyw jasny')}
      title={light ? t('Motyw ciemny') : t('Motyw jasny')}
      className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-slate-300 hover:border-white/20 hover:text-slate-100"
    >
      <Icon name={light ? 'moon' : 'sun'} size={17} />
    </button>
  )
}

function SourceBadge({ source }: { source: 'live' | 'recorded' }) {
  const { t } = useI18n()
  return source === 'live' ? (
    <span className="chip border-spore/40 text-spore" data-testid="source">
      <span className="breathe h-1.5 w-1.5 rounded-full bg-spore" /> {t('na żywo')}
    </span>
  ) : (
    <span className="chip border-amber/30 text-amber" data-testid="source" title={t('Backend niedostępny – dane nagrane z prawdziwych przebiegów')}>
      <span className="h-1.5 w-1.5 rounded-full bg-amber" /> {t('benchmarki')}: {t('tryb nagrany')}
    </span>
  )
}

function Skeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card skeleton h-40" />
      ))}
    </div>
  )
}
