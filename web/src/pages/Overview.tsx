import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Card, Kpi, Src } from '../components/ui'
import { ago, TimeChart } from '../components/TimeChart'
import { rbList, type RbRow } from '../myc/rozbiorLive'
import { LogoMark } from '../components/Logo'
import { L, useI18n } from '../i18n'
import { useBrain } from '../myc/brain'
import { MyceliumViz } from '../components/MyceliumViz'
import { backendKind, useDash, type Dash } from '../myc/dashboard'
import { ids } from '../myc/store'
import { accPoints, at, frac, lastBrowserEval } from '../myc/provenance'
import type { Progress, Snapshot, Stage } from '../types'

const HOUR = 3600_000
const pc = (v: number | undefined, lang: string) => (v == null ? '—' : `${nf(v * 100, lang, 1)}%`)
const nf = (v: number, lang: string, d = 0) => v.toLocaleString(lang === 'en' ? 'en-GB' : 'pl-PL', { maximumFractionDigits: d, minimumFractionDigits: d })

function useNarrow() {
  const q = '(max-width: 639px)'
  const [n, setN] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setN(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return n
}

export default function Overview({ snap, progress, go }: { snap: Snapshot; progress?: Progress; go: (p: 'teach' | 'progress' | 'ai') => void }) {
  const { lang } = useI18n()
  const en = lang === 'en'
  const b = useBrain()
  const d = useDash()
  const narrow = useNarrow()
  const stats = b.store.data.stats
  const stages = progress?.stages ?? []

  // kolejka Weryfikuj liczona tym samym kodem co zakładka (publiczna część, bez rozmów właściciela)
  const [queue, setQueue] = useState<number | null | undefined>()
  const ready = b.ready && !!b.qa
  const capReady = !!b.cap
  useEffect(() => {
    if (!ready) return
    let alive = true
    const t = setTimeout(() => {
      void import('../myc/review')
        .then((m) => m.buildQueue(b, en, { owner: false }))
        .then((q) => alive && setQueue(q.items.length))
        .catch(() => alive && setQueue(null))
    }, 1200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [ready, capReady, b, en])

  const live = d && [d.nodes, d.backends, d.lm, d.frags].some((x) => x !== null)
  return (
    <div className="space-y-4">
      <Hero en={en} live={live} at={d?.at} map={<MyceliumViz data={b.store.data} cons={b.cons} me={ids.node} h={narrow ? 300 : 440} />} />
      <p className="-mt-2 px-1 sm:px-2 text-xs leading-relaxed text-slate-500">
        <L
          pl="Mapa: każda kropka to prawdziwe urządzenie z bazy (przeglądarka, Pi/cron). Strzępka do środka = wkład we wspólną wiedzę, strzępki między kropkami = wspólnie ocenione pytania (kolor: zgodność). Kolor kropki = zaufanie z konsensusu, pulsowanie = aktywność w ostatnich 2 min."
          en="Map: each dot is a real device from the database (browser, Pi/cron). Hypha to the centre = contribution to shared knowledge, hyphae between dots = jointly answered questions (colour: agreement). Dot colour = consensus trust, pulsing = active in the last 2 min."
        />
      </p>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" data-testid="kpis">
        <NodesKpi d={d} lang={lang} />
        <ComputeKpi d={d} lang={lang} />
        <LmKpi d={d} lang={lang} />
        <AccKpi d={d} lang={lang} />
        <FragKpi d={d} lang={lang} />
        <Kpi
          className="fade-up"
          style={{ animationDelay: '250ms' }}
          label={en ? 'To verify' : 'Do weryfikacji'}
          icon="☑"
          tone="rose"
          href="#/weryfikuj"
          testid="kpi-review"
          value={queue === undefined ? <Dots /> : queue === null ? '—' : nf(queue, lang)}
          hint={queue === null ? (en ? 'queue unavailable' : 'kolejka niedostępna') : capReady ? (en ? 'open queue items · tap to review' : 'pozycje w kolejce · dotknij, by sprawdzić') : en ? 'without image items (load on open)' : 'bez pozycji obrazkowych (wczytują się w zakładce)'}
          src={en ? 'counted now in this browser from database rows (same code as the Verify tab)' : 'policzone teraz w tej przeglądarce z wierszy bazy (ten sam kod co zakładka Weryfikuj)'}
          verif="db"
        />
        <BenchKpi snap={snap} en={en} />
        <BrowserAccKpi en={en} lang={lang} />
        <RozbiorKpi en={en} lang={lang} />
      </div>

      <Stages stages={stages} d={d} en={en} lang={lang} onMore={() => go('progress')} />

      <ComputeSplit d={d} en={en} lang={lang} />

      <div className="grid gap-4 xl:grid-cols-2">
        <BenchCard snap={snap} en={en} lang={lang} />
        <Card className="fade-up" title={en ? 'In-browser test accuracy over time (%)' : 'Trafność w testach w przeglądarce w czasie (%)'} right={<a className="text-xs text-spore hover:underline" href="#/teach">{en ? 'teach →' : 'ucz →'}</a>}>
          <TimeChart
            data={accPoints(stats)}
            unit="%"
            domain={[0, 100]}
            series={[
              { key: 'intent', name: en ? 'intents' : 'intencje', color: '#c4b5fd' },
              { key: 'sensor', name: en ? 'sensor (bal.)' : 'czujnik (zbal.)', color: '#5eead4' },
              { key: 'knowledge', name: en ? 'facts confirmed' : 'fakty potwierdzone', color: '#fbbf24' },
            ]}
          />
          <Src v="self">
            {en
              ? `myc_node_stats rows written by browser nodes after training (${accPoints(stats).length} points; values outside 0–100% dropped). Same fixed test set (qa.json) for every node, but each node reports its own result.`
              : `wiersze myc_node_stats zapisane przez węzły-przeglądarki po treningu (punktów: ${accPoints(stats).length}; wartości spoza 0–100% pominięte). Ten sam stały zbiór testowy (qa.json) dla każdego węzła, ale wynik zgłasza sam węzeł.`}
          </Src>
        </Card>
      </div>
    </div>
  )
}

function Dots() {
  return <span className="skeleton inline-block h-7 w-16 rounded-lg align-middle" aria-label="…" />
}

function Hero({ en, live, at, map }: { en: boolean; live: boolean | undefined; at?: number; map: ReactNode }) {
  return (
    <section className="card card-glow fade-up overflow-hidden !p-0" data-testid="hero">
      <div aria-hidden className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-spore/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-violet/10 blur-3xl" />
      <div className="relative grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col justify-center gap-4 p-5 sm:p-7 lg:py-9 lg:pl-9">
          <div className="flex flex-wrap items-center gap-2.5">
            <LogoMark size={40} className="logo-live h-9 w-9 shrink-0 drop-shadow-[0_0_20px_rgb(94_234_212/0.3)]" />
            <h1 className="eyebrow !text-xs !tracking-[0.2em] text-slate-300">{en ? 'Overview' : 'Przegląd'}</h1>
            {live === undefined ? (
              <span className="chip text-slate-400">{en ? 'connecting…' : 'łączenie…'}</span>
            ) : live ? (
              <span className="chip border-spore/30 bg-spore/[0.06] text-spore" data-testid="db-live">
                <span className="breathe h-1.5 w-1.5 rounded-full bg-spore" /> {en ? 'database live' : 'baza na żywo'} · {at ? new Date(at).toLocaleTimeString(en ? 'en-GB' : 'pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }) : ''}
              </span>
            ) : (
              <span className="chip border-rose/30 text-rose" data-testid="db-off">
                {en ? 'database unreachable' : 'baza niedostępna'}
              </span>
            )}
          </div>
          <p className="font-display text-[2rem] font-semibold leading-[1.05] tracking-tight text-slate-50 [text-wrap:balance] sm:text-5xl">
            {en ? (
              <>
                An AI that grows like <span className="text-gradient">mycelium</span>
              </>
            ) : (
              <>
                AI, które rośnie jak <span className="text-gradient">grzybnia</span>
              </>
            )}
          </p>
          <p className="max-w-xl text-sm leading-relaxed text-slate-400 sm:text-[0.95rem]">
            <L
              pl="Grzybnia agentów AI uczy się na prawdziwych danych i od ludzi. Każda liczba i każdy wykres pochodzi z zapisanych pomiarów (przebiegi treningu, odpowiedzi, zdarzenia węzłów) – bez symulacji. Pod każdą liczbą (i) widać źródło, czas pomiaru i to, czy ktoś sprawdził ją niezależnie."
              en="A mycelium of AI agents learns from real data and from people. Every number and chart comes from persisted measurements (training runs, answers, node events) – no simulations. Under each number (i) shows its source, when it was measured and whether it was independently checked."
            />
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <a href="#/node" className="btn-primary px-4 py-2.5 font-semibold">
              {en ? 'Share your computer' : 'Udostępnij komputer'} <Icon name="arrow" size={16} />
            </a>
            <a href="#/chat" className="btn-ghost px-4 py-2.5">
              <Icon name="chat" size={16} className="text-spore" /> {en ? 'Talk to the AI' : 'Porozmawiaj z AI'}
            </a>
          </div>
        </div>
        <div className="night relative m-2 mt-0 overflow-hidden rounded-[1.1rem] ring-1 ring-white/[0.06] lg:my-2 lg:ml-0">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
            <span className="chip border-white/10 bg-[rgb(3_8_10/0.6)] text-slate-300 backdrop-blur">
              <span className="breathe h-1.5 w-1.5 rounded-full bg-spore" /> {en ? 'the mycelium now · real nodes' : 'grzybnia teraz · prawdziwe węzły'}
            </span>
            <a href="?join=1#/teach" className="chip border-spore/30 bg-[rgb(3_8_10/0.6)] text-spore backdrop-blur hover:bg-spore/10">
              {en ? 'join as a node →' : 'dołącz jako węzeł →'}
            </a>
          </div>
          <div className="px-2 pb-3 pt-12 text-xs sm:px-4 lg:pt-10">{map}</div>
        </div>
      </div>
    </section>
  )
}

const dly = (i: number) => ({ animationDelay: `${i * 50}ms` })

function NodesKpi({ d, lang }: { d?: Dash; lang: string }) {
  const en = lang === 'en'
  const now = Date.now()
  const ns = d?.nodes
  const n24 = ns?.filter((n) => now - Date.parse(n.last_at) < 24 * HOUR).length
  const n1 = ns?.filter((n) => now - Date.parse(n.last_at) < HOUR).length
  return (
    <Kpi
      className="fade-up"
      style={dly(0)}
      testid="kpi-nodes"
      label={en ? 'Computing nodes (24 h)' : 'Węzły liczące (24 h)'}
      icon="⬢"
      href="#/node"
      value={d === undefined ? <Dots /> : ns == null ? '—' : n24}
      hint={ns == null ? (d ? (en ? 'no data' : 'brak danych') : '') : ns.length ? `${en ? 'last hour' : 'ostatnia godzina'}: ${n1} · ${en ? 'ever computed' : 'kiedykolwiek liczyły'}: ${ns.length}${ns[0] ? ` · ${ago(ns[0].last_at, lang)}` : ''}` : en ? 'no node has sent results yet' : 'żaden węzeł nie wysłał jeszcze wyników'}
      src={en ? 'view myc_node_contrib: nodes with ≥ 1 compute result (myc_results) in the last 24 h. Nodes with any activity (answers, training, presence) are counted separately on the Node page.' : 'widok myc_node_contrib: węzły z ≥ 1 wynikiem obliczeń (myc_results) w ostatnich 24 h. Węzły z dowolną aktywnością (odpowiedzi, trening, obecność) liczone są osobno na stronie Węzeł.'}
      verif="db"
    />
  )
}

function computeSums(d?: Dash) {
  const s = { cpu: 0, wasm: 0, gpu: 0, flops: 0, results: 0, accepted: 0 }
  for (const x of d?.backends ?? []) {
    s[backendKind(x.backend)] += +x.hours
    s.flops += +x.flops
    s.results += x.results
    s.accepted += x.accepted
  }
  return s
}

function ComputeKpi({ d, lang }: { d?: Dash; lang: string }) {
  const en = lang === 'en'
  const s = computeSums(d)
  const tot = s.cpu + s.wasm + s.gpu
  return (
    <Kpi
      className="fade-up"
      style={dly(1)}
      testid="kpi-compute"
      label={en ? 'Compute contributed' : 'Wniesiona moc'}
      icon="⚡"
      tone="sky"
      value={d === undefined ? <Dots /> : d.backends == null ? '—' : `${nf(tot, lang, 1)} h`}
      hint={d?.backends ? (d.backends.length ? `CPU ${nf(s.cpu + s.wasm, lang, 1)} h · GPU ${nf(s.gpu, lang, 1)} h · ${nf(s.flops / 1e15, lang, 1)} PFLOP` : en ? 'no compute results yet' : 'brak wyników obliczeń') : ''}
      src={en ? 'myc_backend_contrib: compute time and FLOP estimate reported by each node with its result' : 'myc_backend_contrib: czas obliczeń i szacunek FLOP zgłaszane przez węzeł razem z wynikiem'}
      verif="self"
    >
      {tot > 0 && (
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white/5" aria-hidden>
          <div className="bar-in bg-violet" style={{ width: `${(s.cpu / tot) * 100}%` }} />
          <div className="bar-in bg-spore" style={{ width: `${(s.wasm / tot) * 100}%` }} />
          <div className="bar-in bg-amber" style={{ width: `${(s.gpu / tot) * 100}%` }} />
        </div>
      )}
    </Kpi>
  )
}

const lastLm = (d?: Dash) => d?.lm?.at(-1)
type Lm = NonNullable<Dash['lm']>[number]
/** Wersja LM jest niezależnie sprawdzona, gdy wynik policzył zaufany weryfikator (GitHub Actions) albo inny węzeł niż zgłaszający. */
const lmVerified = (v: Lm) => !!v.meta?.rebased?.length || !!v.verifiers?.length
function lmSrc(v: Lm, en: boolean) {
  const rb = v.meta?.rebased?.at(-1)
  if (rb) return en ? `myc_models v${v.version}: score recomputed by verifier “${rb.by ?? '?'}” (${rb.backend ?? '?'}) on ${at(rb.at, en)}` : `myc_models v${v.version}: wynik przeliczył weryfikator „${rb.by ?? '?'}” (${rb.backend ?? '?'}) ${at(rb.at, en)}`
  const k = v.verifiers?.length ?? 0
  return en ? `myc_models v${v.version}, published ${at(v.created_at, en)} after ${k} independent re-evaluation(s)` : `myc_models v${v.version}, opublikowane ${at(v.created_at, en)} po ${k} niezależnej ponownej ocenie`
}

/** Benchmark ai-bench z nagranego pliku snapshot.json (prawdziwy przebieg z commitem i datą). */
function BenchKpi({ snap, en }: { snap: Snapshot; en: boolean }) {
  const ai = snap.ai
  const runs = ai?.history?.length ?? (ai ? 1 : 0)
  return (
    <Kpi
      className="fade-up"
      style={dly(6)}
      testid="kpi-bench"
      label={en ? 'Benchmark (ai-bench, recorded)' : 'Benchmark (ai-bench, nagrany)'}
      icon="◎"
      href="#/ai"
      value={ai ? ai.mbs.toFixed(1) : '—'}
      hint={ai ? (en ? `mean of ${ai.agents.length} tasks, 0 = chance, 100 = perfect · linear ${ai.mbs_linear.toFixed(1)} · runs: ${runs}` : `średnia ${ai.agents.length} zadań, 0 = losowo, 100 = ideał · liniowy ${ai.mbs_linear.toFixed(1)} · przebiegi: ${runs}`) : en ? 'no recorded run' : 'brak nagranego przebiegu'}
      src={ai ? (en ? `snapshot.json: one ai-bench run on ${at(ai.generated_at, en)}, commit ${ai.git ?? '?'}, ${ai.machine?.device ?? 'cpu'}` : `snapshot.json: jeden przebieg ai-bench ${at(ai.generated_at, en)}, commit ${ai.git ?? '?'}, ${ai.machine?.device ?? 'cpu'}`) : undefined}
      verif={ai ? 'recorded' : undefined}
    />
  )
}

function BenchCard({ snap, en, lang }: { snap: Snapshot; en: boolean; lang: string }) {
  const ai = snap.ai
  const hist = (ai?.history ?? []).map((h) => ({ t: Date.parse(h.t), mbs: h.mbs, lin: h.mbs_linear ?? null }))
  const last = ai?.history?.at(-1)
  return (
    <Card className="fade-up" title={en ? 'ai-bench on real datasets (recorded runs)' : 'ai-bench na prawdziwych zbiorach (nagrane przebiegi)'} right={<a className="text-xs text-spore hover:underline" href="#/ai">{en ? 'details →' : 'szczegóły →'}</a>}>
      {hist.length >= 2 ? (
        <TimeChart data={hist} series={[{ key: 'mbs', name: 'MBS', color: '#5eead4' }, { key: 'lin', name: en ? 'linear baseline' : 'baseline liniowy', color: '#64748b' }]} />
      ) : last ? (
        <ul className="space-y-2.5 py-1" data-testid="bench-scores">
          {Object.entries(last.scores).map(([k, v]) => {
            const f = frac(v)
            const t = ai?.task_info?.[k]
            return (
              <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm">
                <span className="truncate text-slate-300">{(en ? t?.title_en : t?.title_pl) ?? k}</span>
                <span className="text-right text-xs tabular-nums text-slate-400">{f == null ? '—' : nf(f * 100, lang, 1)}</span>
                <span className="col-span-2 h-2 overflow-hidden rounded-full bg-white/5">
                  <span className="bar-in block h-full rounded-full bg-spore" style={{ width: `${Math.max(1, (f ?? 0) * 100)}%` }} />
                </span>
              </li>
            )
          })}
          <li className="text-xs text-slate-500">{en ? 'only one recorded run – no trend yet' : 'tylko jeden nagrany przebieg – trendu jeszcze nie ma'}</li>
        </ul>
      ) : (
        <p className="py-3 text-center text-sm text-slate-500">{en ? 'no recorded run' : 'brak danych'}</p>
      )}
      {ai && (
        <Src v="recorded">
          {en
            ? `scores on held-out test sets, normalised: 0 = chance (forecast: naive), 1 = perfect · snapshot.json, ${at(ai.generated_at, en)}, commit ${ai.git ?? '?'}`
            : `wyniki na odłożonych zbiorach testowych, znormalizowane: 0 = losowo (prognoza: naiwna), 1 = ideał · snapshot.json, ${at(ai.generated_at, en)}, commit ${ai.git ?? '?'}`}
        </Src>
      )}
    </Card>
  )
}

/** Trafność w testach w przeglądarce: liczona w tej przeglądarce teraz; bez modelu – ostatni zapisany pomiar. */
function BrowserAccKpi({ en, lang }: { en: boolean; lang: string }) {
  const b = useBrain()
  // „na żywo” tylko, gdy policzono po synchronizacji z bazą; wcześniej – ostatni zapisany pomiar (jeśli jest)
  const saved = lastBrowserEval(b.store.data.stats)
  const live = b.scores && (b.scoresSynced || !saved) ? b.scores : undefined
  const rec = live ? undefined : saved
  const v = live ?? (rec ? { intent: frac(rec.acc.intent), sensor: frac(rec.acc.sensor), knowledge: frac(rec.acc.knowledge), n: { intent: rec.acc.n_intent, sensor: rec.acc.n_sensor, knowledge: rec.acc.n_knowledge } } : undefined)
  const qa = b.qa
  const n = {
    intent: v?.n.intent ?? qa?.intent.test.length,
    sensor: v?.n.sensor ?? qa?.sensor.test.length,
    knowledge: v?.n.knowledge,
  }
  const row = (l: string, x: number | undefined, k: number | undefined, t: string) => (
    <div className="flex items-baseline justify-between gap-2" title={t}>
      <span className="text-xs font-normal text-slate-400">{l}</span>
      <span className="text-base">
        {pc(x, lang)} <span className="text-[10px] font-normal text-slate-500">n={k ?? '—'}</span>
      </span>
    </div>
  )
  return (
    <Kpi
      className="fade-up"
      style={dly(7)}
      testid="kpi-browser-acc"
      label={en ? 'In-browser tests' : 'Testy w przeglądarce'}
      icon="✺"
      tone="violet"
      href="#/teach"
      value={
        !v ? (
          b.ready ? '—' : <Dots />
        ) : (
          <div className="space-y-0.5 tracking-normal" data-testid="browser-acc">
            {row(en ? 'intents' : 'intencje', v.intent, n.intent, en ? 'accuracy on the fixed intent test set' : 'trafność na stałym zbiorze testowym intencji')}
            {row(en ? 'sensor' : 'czujnik', v.sensor, n.sensor, en ? 'balanced accuracy, NAB machine temperature' : 'trafność zbalansowana, NAB temperatura maszyny')}
            {row(en ? 'facts confirmed' : 'fakty potwierdzone', v.knowledge, n.knowledge, en ? 'share of fact questions confirmed by people (consensus ≥ 80%) – coverage, not model accuracy' : 'odsetek pytań-faktów potwierdzonych przez ludzi (konsensus ≥ 80%) – pokrycie, nie trafność modelu')}
          </div>
        )
      }
      src={
        live
          ? en
            ? `computed in this browser ${at(b.scoresAt, en)} on the fixed test sets in qa.json${b.scoresSynced ? '' : ' (database not reached – local data only)'}; facts = share confirmed by people, not model accuracy`
            : `policzone w tej przeglądarce ${at(b.scoresAt, en)} na stałych zbiorach testowych z qa.json${b.scoresSynced ? '' : ' (bez połączenia z bazą – tylko dane lokalne)'}; fakty = odsetek potwierdzonych przez ludzi, nie trafność modelu`
          : rec
            ? en
              ? `last saved browser measurement (myc_node_stats), ${at(rec.created_at, en)}`
              : `ostatni zapisany pomiar przeglądarki (myc_node_stats), ${at(rec.created_at, en)}`
            : undefined
      }
      verif={live ? undefined : rec ? 'self' : undefined}
    />
  )
}

/** Rozbiór zdań: role-F1 opublikowanej wersji, przeliczone niezależnie (weryfikator) na teście UD; bez wersji = uczciwie „—”. */
function RozbiorKpi({ en, lang }: { en: boolean; lang: string }) {
  const [rows, setRows] = useState<RbRow[] | null | undefined>()
  useEffect(() => {
    rbList(30).then(setRows, () => setRows(null))
  }, [])
  const v = rows?.filter((r) => r.status === 'published').sort((a, b) => b.version - a.version)[0]
  const pend = rows?.filter((r) => r.status === 'pending').length ?? 0
  const f1 = v ? (v.verify_f1 ?? v.f1) : undefined
  return (
    <Kpi
      className="fade-up"
      style={dly(9)}
      testid="kpi-rozbior"
      label={en ? 'Sentence understanding (role-F1)' : 'Rozumienie zdań (role-F1)'}
      icon="¶"
      tone="spore"
      href="#/chat"
      value={rows === undefined ? <Dots /> : f1 != null ? `${(f1 * 100).toFixed(1)}%` : '—'}
      hint={
        v
          ? `v${v.version} · ${en ? 'UD test' : 'test UD'} n=${nf(v.eval_n ?? 0, lang)} ${en ? 'sentences' : 'zdań'} · UPOS ${v.upos != null ? (v.upos * 100).toFixed(1) + '%' : '—'} · ${ago(v.decided_at ?? v.created_at, lang)}${pend ? ` · ${pend} ${en ? 'candidate(s) waiting' : 'kandydat(ów) czeka'}` : ''}`
          : rows === null
            ? en
              ? 'unavailable'
              : 'niedostępne'
            : rows
              ? en
                ? 'no verified version yet'
                : 'brak zweryfikowanej wersji'
              : ''
      }
      src={
        en
          ? 'myc_rb_models: who/what/whom/where roles vs UD Polish PDB+LFG test (never used for training), recomputed by an independent verifier'
          : 'myc_rb_models: role KTO/CO/KOMU/GDZIE… względem testu UD Polish PDB+LFG (nigdy nie do treningu), przeliczone przez niezależnego weryfikatora'
      }
      verif={v?.verifier ? 'verified' : v ? 'db' : undefined}
    />
  )
}

function LmKpi({ d, lang }: { d?: Dash; lang: string }) {
  const en = lang === 'en'
  const v = lastLm(d)
  const pend = d?.cands?.filter((c) => c.status === 'pending').length ?? 0
  return (
    <Kpi
      className="fade-up"
      style={dly(2)}
      testid="kpi-lm"
      label={en ? 'Language model' : 'Model językowy'}
      icon="✦"
      tone="violet"
      href="#/verify"
      value={d === undefined ? <Dots /> : v ? `v${v.version}` : '—'}
      hint={v ? `${en ? 'perplexity' : 'perpleksja'} ${v.meta?.ppl?.toFixed(2) ?? '—'} · ${ago(v.created_at, lang)}${pend ? ` · ${pend} ${en ? 'candidate(s) waiting' : 'kandydat(ów) czeka'}` : ''}` : d ? (en ? 'no published version yet' : 'brak opublikowanej wersji') : ''}
      src={v ? lmSrc(v, en) : en ? 'myc_models (model lm)' : 'myc_models (model lm)'}
      verif={v && lmVerified(v) ? 'verified' : v ? 'db' : undefined}
    />
  )
}

function AccKpi({ d, lang }: { d?: Dash; lang: string }) {
  const en = lang === 'en'
  const v = lastLm(d)
  const n = v?.meta?.eval_n
  return (
    <Kpi
      className="fade-up"
      style={dly(3)}
      testid="kpi-acc"
      label={n ? (en ? `LM accuracy (${n} q.)` : `Trafność LM (${n} pyt.)`) : en ? 'LM accuracy' : 'Trafność LM'}
      icon="◆"
      tone="amber"
      value={d === undefined ? <Dots /> : v ? `${(v.acc * 100).toFixed(1)}%` : '—'}
      hint={v ? `${v.meta?.correct ?? '—'}/${n ?? '—'} · ${en ? 'chance 25%' : 'losowo 25%'}` : d ? (en ? 'not evaluated yet' : 'jeszcze nie oceniono') : ''}
      src={v ? lmSrc(v, en) : undefined}
      verif={v && lmVerified(v) ? 'verified' : v ? 'db' : undefined}
    >
      {v && (
        <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-white/5" aria-hidden>
          <div className="bar-in h-full rounded-full bg-amber" style={{ width: `${v.acc * 100}%` }} />
          <div className="absolute inset-y-0 w-px bg-slate-300/60" style={{ left: '25%' }} title={en ? 'chance' : 'losowo'} />
        </div>
      )}
    </Kpi>
  )
}

function FragKpi({ d, lang }: { d?: Dash; lang: string }) {
  const en = lang === 'en'
  const f = d?.frags
  const by = (l: number) => f?.find((x) => x.layer === l)
  const n0 = by(0)?.n ?? 0
  return (
    <Kpi
      className="fade-up"
      style={dly(4)}
      testid="kpi-frags"
      label={en ? 'Fragments' : 'Strzępki'}
      icon="❋"
      href="#/knowledge"
      value={d === undefined ? <Dots /> : f == null ? '—' : nf(n0, lang)}
      hint={f ? (f.length ? `${en ? 'concepts' : 'pojęcia'} ${nf(by(1)?.n ?? 0, lang)} · ${en ? 'topics' : 'tematy'} ${nf(by(2)?.n ?? 0, lang)} · ${en ? 'verified' : 'zweryfikowane'} ${nf(by(0)?.verified ?? 0, lang)}` : en ? 'no fragments yet' : 'brak strzępków') : d ? (en ? 'no data' : 'brak danych') : ''}
      src={en ? 'RPC myc_frag_stats (live count); “verified” = approved by votes in Verify' : 'RPC myc_frag_stats (liczone na żywo); „zweryfikowane” = zatwierdzone głosami w Weryfikuj'}
      verif="db"
    />
  )
}

/** Podział mocy według backendu: prawdziwe agregaty myc_backend_contrib (godziny, wyniki, wykorzystane w modelach). */
function ComputeSplit({ d, en, lang }: { d?: Dash; en: boolean; lang: string }) {
  const rows = useMemo(() => [...(d?.backends ?? [])].sort((a, b) => +b.hours - +a.hours), [d])
  const max = Math.max(1e-9, ...rows.map((r) => +r.hours))
  const name: Record<string, string> = en
    ? { cpu: 'CPU · Python node (PC/box)', wasm: 'CPU · browser (WASM)', webgpu: 'GPU · browser (WebGPU)', webgl: 'GPU · browser (WebGL)' }
    : { cpu: 'CPU · węzeł Python (PC/box)', wasm: 'CPU · przeglądarka (WASM)', webgpu: 'GPU · przeglądarka (WebGPU)', webgl: 'GPU · przeglądarka (WebGL)' }
  const color = { cpu: 'bg-violet', wasm: 'bg-spore', gpu: 'bg-amber' }
  if (d === undefined) return null
  return (
    <Card className="fade-up" title={en ? 'Where the compute comes from' : 'Skąd pochodzi moc'} right={<a className="text-xs text-spore hover:underline" href="#/verify">{en ? 'node contribution →' : 'wkład węzłów →'}</a>}>
      {!rows.length ? (
        <p className="py-3 text-center text-sm text-slate-500">{d.backends == null ? (en ? 'database unreachable' : 'baza niedostępna') : en ? 'no compute results yet' : 'brak wyników obliczeń'}</p>
      ) : (
        <ul className="space-y-2.5" data-testid="compute-split">
          {rows.map((r) => {
            const k = backendKind(r.backend)
            const used = r.results ? r.accepted / r.results : 0
            return (
              <li key={r.backend} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[14rem_1fr_auto]">
                <span className="truncate text-slate-300">{name[r.backend] ?? r.backend}</span>
                <span className="order-3 col-span-2 h-2 overflow-hidden rounded-full bg-white/5 sm:order-none sm:col-span-1">
                  <span className={`bar-in block h-full rounded-full ${color[k]}`} style={{ width: `${Math.max(1, (+r.hours / max) * 100)}%` }} />
                </span>
                <span className="text-right text-xs tabular-nums text-slate-400">
                  {nf(+r.hours, lang, 1)} h · {nf(r.results, lang)} {en ? 'results' : 'wyników'} · {en ? 'used' : 'wykorzystane'} {(used * 100).toFixed(0)}%
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <Src v="self">
        {en
          ? 'hours and result counts: view myc_backend_contrib (time reported by nodes); “used” = the result went into a model version published after independent re-evaluation'
          : 'godziny i liczba wyników: widok myc_backend_contrib (czas zgłaszany przez węzły); „wykorzystane” = wynik wszedł do wersji modelu opublikowanej po niezależnej ponownej ocenie'}
      </Src>
    </Card>
  )
}

const ST = {
  done: { pl: 'zrobione', en: 'done', cls: 'border-spore/30 text-spore', bar: 'bg-spore' },
  in_progress: { pl: 'w toku', en: 'in progress', cls: 'border-amber/30 text-amber', bar: 'bg-amber' },
  planned: { pl: 'zaplanowane', en: 'planned', cls: 'border-white/10 text-slate-400', bar: 'bg-slate-500' },
}

function Stages({ stages, d, en, lang, onMore }: { stages: Stage[]; d?: Dash; en: boolean; lang: string; onMore: () => void }) {
  const all = stages.flatMap((s) => s.items)
  const doneN = all.filter((i) => i.done).length
  // miara etapu 1 (cel: odrzucone < 50% aktualizacji dziennie) z prawdziwych dziennych agregatów
  const day = d?.days?.find((x) => x.accepted + x.rejected > 0)
  const rej = day ? day.rejected / (day.accepted + day.rejected) : null
  return (
    <Card
      className="fade-up"
      title={en ? 'Roadmap stages' : 'Etapy rozwoju'}
      right={
        <button className="text-xs text-spore hover:underline" onClick={onMore}>
          {en ? 'all →' : 'wszystko →'}
        </button>
      }
    >
      {!stages.length ? (
        <p className="py-3 text-center text-sm text-slate-500">{en ? 'no roadmap data' : 'brak danych mapy rozwoju'}</p>
      ) : (
        <div data-testid="stages">
          <div className="mb-3 flex items-end justify-between gap-2">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-slate-50">{Math.round((doneN / Math.max(1, all.length)) * 100)}%</div>
              <div className="text-xs text-slate-400">
                {doneN}/{all.length} {en ? 'items done (docs/roadmap.md)' : 'punktów zrobionych (docs/roadmap.md)'}
              </div>
            </div>
          </div>
          <ul className="space-y-2">
            {stages.map((s) => {
              const k = s.items.filter((i) => i.done).length
              const st = ST[s.status]
              return (
                <li key={s.id}>
                  <details className="group rounded-xl border border-white/5 bg-white/[0.015] px-3 py-2 open:bg-white/[0.03]">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm">
                      <span className="w-5 shrink-0 font-mono text-xs text-slate-500">{s.id}</span>
                      <span className="min-w-0 flex-1 leading-snug text-slate-200">{s.title}</span>
                      <span className={`chip shrink-0 ${st.cls}`}>{en ? st.en : st.pl}</span>
                    </summary>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                        <div className={`bar-in h-full rounded-full ${st.bar}`} style={{ width: `${Math.max(3, (k / Math.max(1, s.items.length)) * 100)}%` }} />
                      </div>
                      <span className="text-[11px] tabular-nums text-slate-500">
                        {k}/{s.items.length}
                      </span>
                    </div>
                    {s.id === '1' && rej != null && (
                      <div className="mt-1 text-[11px] text-slate-400" data-testid="stage1-metric">
                        {en ? 'rejected updates' : 'odrzucone aktualizacje'} ({day!.day}): <span className={rej < 0.5 ? 'text-spore' : 'text-rose'}>{(rej * 100).toFixed(0)}%</span> · {en ? 'target < 50%' : 'cel < 50%'}
                      </div>
                    )}
                    <ul className="mt-2 space-y-1 text-xs">
                      {s.items.map((i) => (
                        <li key={i.t} className="flex gap-2">
                          <span aria-hidden className={i.done ? 'text-spore' : 'text-slate-600'}>
                            {i.done ? '✓' : '○'}
                          </span>
                          <span className={i.done ? 'text-slate-300' : 'text-slate-500'}>{i.t}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              )
            })}
          </ul>
          <Src>
            {en
              ? `checklist in docs/roadmap.md (web/scripts/roadmap.json), ticked by hand at each release – a plan status, not a measurement · ${nf(stages.length, lang)} stages`
              : `lista w docs/roadmap.md (web/scripts/roadmap.json), odhaczana ręcznie przy wydaniu – stan planu, nie pomiar · etapów: ${nf(stages.length, lang)}`}
          </Src>
        </div>
      )}
    </Card>
  )
}

export function StatusDot({ status }: { status: 'done' | 'in_progress' | 'planned' }) {
  const cls = { done: 'bg-spore', in_progress: 'bg-amber', planned: 'bg-slate-600' }[status]
  return <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${cls}`} />
}
