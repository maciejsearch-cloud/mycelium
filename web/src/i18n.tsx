import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Lang = 'pl' | 'en'
const EN: Record<string, string> = {
  Przegląd: 'Overview',
  'Prawdziwe AI': 'Real AI',
  'Ucz AI': 'Teach the AI',
  Zadania: 'Tasks',
  Sesja: 'Session',
  Moc: 'Compute',
  Rozmowa: 'Conversation',
  'Czat globalny': 'Global chat',
  Wiedza: 'Knowledge',
  Taksonomia: 'Taxonomy',
  Wzrost: 'Growth',
  Dowody: 'Evidence',
  'Rozmowa z AI': 'Chat with AI',
  Kręgi: 'Circles',
  Start: 'Home',
  Ucz: 'Teach',
  Węzeł: 'Node',
  Więcej: 'More',
  Podzakładki: 'Sub-tabs',
  Główne: 'Main',
  Weryfikuj: 'Verify',
  'Zostań węzłem': 'Become a node',
  Konto: 'Account',
  Benchmarki: 'Benchmarks',
  Ewolucja: 'Evolution',
  'Krzywe uczenia': 'Learning curves',
  'Grzybnia i agenci': 'Mycelium & agents',
  'Postępy projektu': 'Project progress',
  'agenci IoT · wspólna grzybnia': 'IoT agents · shared mycelium',
  'Dane z': 'Data from',
  Repozytorium: 'Repository',
  'Motyw ciemny': 'Dark theme',
  'Motyw jasny': 'Light theme',
  'na żywo': 'live',
  'tryb nagrany': 'recorded mode',
  benchmarki: 'benchmarks',
  'Backend niedostępny – dane nagrane z prawdziwych przebiegów': 'Backend offline – data recorded from real runs',
  'Nie udało się wczytać danych': 'Could not load data',
  Sekcje: 'Sections',
}

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string }>({ lang: 'pl', setLang: () => {}, t: (s) => s })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('lang') as Lang) || 'pl')
  useEffect(() => {
    localStorage.setItem('lang', lang)
    document.documentElement.lang = lang
  }, [lang])
  return <Ctx.Provider value={{ lang, setLang, t: (s) => (lang === 'en' ? (EN[s] ?? s) : s) }}>{children}</Ctx.Provider>
}

// oxlint-disable-next-line react/only-export-components
export const useI18n = () => useContext(Ctx)

/** Tekst w dwóch językach w miejscu użycia: <L pl="…" en="…" /> */
export function L({ pl, en }: { pl: ReactNode; en: ReactNode }) {
  return <>{useI18n().lang === 'en' ? en : pl}</>
}

export function LangSwitch() {
  const { lang, setLang } = useI18n()
  return (
    <div className="inline-flex h-9 items-center rounded-full border border-white/10 p-0.5 text-xs" role="group" aria-label="Język / Language">
      {(['pl', 'en'] as const).map((l) => (
        <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`h-full rounded-full px-2.5 font-medium uppercase ${lang === l ? 'bg-spore/15 text-glow ring-1 ring-spore/30' : 'text-slate-400 hover:text-slate-200'}`}>
          {l}
        </button>
      ))}
    </div>
  )
}
