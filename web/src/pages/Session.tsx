// „Start sesji”: dobrowolny wkład mocy obliczeniowej (24 h) – prawdziwe zadania treningowe na GPU/CPU,
// kolejka zadań, model globalny w wersjach, pomiary przepustowości i wkład na osobę (pod przyszłe nagrody).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Card, Kpi, PageHeader } from '../components/ui'
import { Empty, TimeChart, ago, type Point } from '../components/TimeChart'
import { L, useI18n } from '../i18n'
import { agentName } from '../myc/brain'
import { session } from '../myc/session'
import { SB_KEY, SB_URL, ids } from '../myc/store'
import { pool, type ModelRow } from '../compute/pool'
import { MODELS, TITLES, titleOf, type ModelId } from '../compute/specs'

const hm = (ms: number) => `${Math.floor(ms / 3600_000)} h ${String(Math.floor((ms % 3600_000) / 60_000)).padStart(2, '0')} min`
const num = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)} M` : x >= 1e4 ? `${(x / 1e3).toFixed(1)} k` : String(Math.round(x)))
const fl = (x?: number | null) => (x == null ? '—' : x >= 1e15 ? `${(x / 1e15).toFixed(2)} PFLOP` : x >= 1e12 ? `${(x / 1e12).toFixed(2)} TFLOP` : `${(x / 1e9).toFixed(1)} GFLOP`)
const pct = (x?: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
const COLORS: Record<ModelId, string> = { fashion: '#5eead4', har: '#fbbf24', intent: '#c4b5fd', words: '#fb7185' }

interface Stats {
  contributors: { contributor_id: string; jobs: number; samples: number; flops: number; gpu_flops: number | null; cpu_flops: number | null; accepted: number; rejected: number; last: string }[]
  hourly: { t: string; samples: number; flops: number; gpu_flops: number | null }[]
  backends: Record<string, { jobs: number; samples: number; ms: number; flops: number }>
  queue: { open: number; leased: number; done: number }
}

interface CandRow {
  model: ModelId
  version: number
  acc_claimed: number
  status: string
  verified_acc: number | null
  verifiers: { node: string; acc: number; trusted: boolean; backend?: string }[] | null
  reason: string | null
  created_at: string
}
interface GateRow {
  model: ModelId
  version: number
  acc: number | null
  cur_acc: number | null
  reason: string
  created_at: string
}

function useNetwork() {
  const [d, set] = useState<{ models: ModelRow[]; stats?: Stats; gate?: GateRow[]; cands?: CandRow[]; at?: number; err?: string }>({ models: [] })
  useEffect(() => {
    let on = true
    const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
    const load = async () => {
      try {
        const [models, stats, gate, cands] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/myc_models?select=model,version,path,acc,val_acc,n_updates,n_rejected,samples,flops,meta,created_at&order=created_at&limit=5000`, { headers: H }).then((r) => (r.ok ? r.json() : [])),
          fetch(`${SB_URL}/rest/v1/rpc/myc_compute_stats`, { method: 'POST', headers: H, body: '{}' }).then((r) => (r.ok ? r.json() : undefined)),
          fetch(`${SB_URL}/rest/v1/myc_model_rejections?select=model,version,acc,cur_acc,reason,created_at&order=id.desc&limit=6`, { headers: H }).then((r) => (r.ok ? r.json() : undefined)),
          fetch(`${SB_URL}/rest/v1/myc_candidates?select=model,version,acc_claimed,status,verified_acc,verifiers,reason,created_at&order=id.desc&limit=6`, { headers: H }).then((r) => (r.ok ? r.json() : undefined)),
        ])
        if (on) set({ models, stats, gate, cands, at: Date.now() })
      } catch (e) {
        if (on) set((x) => ({ ...x, err: String(e) }))
      }
    }
    void load()
    const t = setInterval(load, 20_000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [])
  return d
}

export default function SessionPage() {
  useSyncExternalStore(session.subscribe, session.getVersion)
  const { lang } = useI18n()
  const en = lang === 'en'
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const net = useNetwork()
  const st = session
  const status = st.running
    ? en ? 'working – training in the background' : 'pracuje – trening w tle'
    : !st.active
      ? st.s.start ? (en ? 'session ended – renew it' : 'sesja wygasła – odnów ją') : en ? 'not started' : 'nie rozpoczęta'
      : st.reason === 'hidden'
        ? en ? 'paused – tab in background' : 'wstrzymana – karta w tle'
        : st.reason === 'battery'
          ? en ? 'stopped – low battery' : 'zatrzymana – słaba bateria'
          : en ? 'paused' : 'wstrzymana'
  const latest = (m: ModelId) => net.models.filter((r) => r.model === m).at(-1)
  const accPoints: Point[] = net.models.filter((r) => r.acc != null).map((r) => ({ t: Date.parse(r.created_at), [r.model]: +(100 * r.acc!).toFixed(2) }))
  const stats = net.stats
  const contrib = stats?.contributors ?? []
  const mine = contrib.find((c) => c.contributor_id === ids.contributor)
  const rank = mine ? contrib.indexOf(mine) + 1 : undefined
  const tot = contrib.reduce((a, c) => ({ samples: a.samples + c.samples, flops: a.flops + c.flops, gpu: a.gpu + (c.gpu_flops ?? 0) }), { samples: 0, flops: 0, gpu: 0 })
  const hourly: Point[] = (stats?.hourly ?? []).map((h) => ({ t: Date.parse(h.t), cpu: +((h.flops - (h.gpu_flops ?? 0)) / 1e12).toFixed(3), gpu: +((h.gpu_flops ?? 0) / 1e12).toFixed(3) }))
  const bench = pool.bench
  const bGpu = bench.find((b) => b.backend === 'webgpu' || b.backend === 'webgl')
  const bCpu = bench.find((b) => b.backend === 'wasm' || b.backend === 'cpu')
  const loc = pool.local

  return (
    <>
      <PageHeader title={en ? 'Session' : 'Sesja'}>
        <L
          pl="Dołącz moc swojego urządzenia do grzybni. Póki ta karta jest otwarta, karta graficzna (WebGPU/WebGL) i rdzenie procesora (WASM w kilku wątkach roboczych) wykonują prawdziwe zadania z kolejki: trening sieci na odłamkach otwartych danych, ocenę modeli, próby hiperparametrów, etykietowanie i weryfikację cudzych aktualizacji."
          en="Lend your device's power to the mycelium. While this tab is open, the graphics card (WebGPU/WebGL) and CPU cores (WASM in several workers) run real jobs from the queue: training networks on shards of open data, evaluating models, hyperparameter trials, labelling and verifying other nodes' updates."
        />
      </PageHeader>
      <div className="grid gap-4 xl:grid-cols-5">
        <Card title={en ? 'Your session' : 'Twoja sesja'} className="xl:col-span-3">
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={() => (st.running ? st.pause() : st.start())}
              className={`h-28 w-28 rounded-full text-base font-semibold shadow-lg transition active:scale-95 ${st.running ? 'myc-breathe bg-amber/90 text-ink' : 'bg-spore/90 text-ink hover:bg-spore'}`}
              data-testid="session-btn"
            >
              {st.running ? (en ? 'Pause' : 'Pauza') : st.active ? (en ? 'Resume' : 'Wznów') : st.s.start ? (en ? 'Renew session' : 'Odnów sesję') : en ? 'Start session' : 'Start sesji'}
            </button>
            <div className="space-y-2 text-sm">
              <div data-testid="session-status" data-running={st.running ? '1' : '0'}>
                <span className={st.running ? 'text-spore' : 'text-amber'}>●</span> {status}
              </div>
              {st.active && (
                <div className="text-slate-400">
                  {en ? 'time left' : 'pozostało'}: <b className="text-slate-200">{hm(st.remaining)}</b>
                </div>
              )}
              <label className="block text-xs text-slate-400">
                CPU: {Math.round(st.s.throttle * 100)}% · {pool.cpuWorkers} {en ? 'workers' : 'wątków roboczych'} / {navigator.hardwareConcurrency ?? '?'} {en ? 'cores' : 'rdzeni'}
                <input type="range" min={10} max={100} step={10} value={Math.round(st.s.throttle * 100)} onChange={(e) => st.setThrottle(Number(e.target.value) / 100)} className="block w-56 accent-[#5eead4]" data-testid="throttle" />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input type="checkbox" checked={pool.settings.gpu} onChange={(e) => st.setGpu(e.target.checked)} data-testid="gpu-toggle" />
                {en ? 'use the GPU (WebGPU → WebGL)' : 'używaj karty graficznej (WebGPU → WebGL)'}
              </label>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="workers">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2">{en ? 'worker' : 'wątek'}</th>
                  <th className="py-1 pr-2">backend</th>
                  <th className="py-1 pr-2">{en ? 'device' : 'urządzenie'}</th>
                  <th className="py-1">{en ? 'now' : 'teraz'}</th>
                </tr>
              </thead>
              <tbody>
                {pool.slots.map((s, i) => (
                  <tr key={i} className="border-t border-white/5 text-slate-300">
                    <td className="py-1 pr-2">{s.role === 'gpu' ? 'GPU' : `CPU ${i}`}</td>
                    <td className="py-1 pr-2" data-testid="backend">{s.info ? `${s.info.backend}${s.info.backend === 'wasm' ? ` (SIMD ${s.info.simd ? '✓' : '✗'}, ${en ? 'threads' : 'wątki'} ${s.info.threads ? '✓' : '✗'})` : ''}` : '…'}</td>
                    <td className="py-1 pr-2 text-slate-400">{s.info?.device ?? '…'}</td>
                    <td className="py-1 text-slate-400">{s.job ?? (s.busy ? '…' : en ? 'idle' : 'czeka')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!pool.slots.length && <p className="text-xs text-slate-500">{en ? 'Workers start with the session.' : 'Wątki robocze startują razem z sesją.'}</p>}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-3 xl:col-span-2">
          <Kpi label={en ? 'Streak' : 'Seria'} value={`${st.streak} ${en ? (st.streak === 1 ? 'day' : 'days') : st.streak === 1 ? 'dzień' : 'dni'}`} tone="amber" hint={en ? 'days in a row with a session' : 'dni z rzędu z sesją'} src={en ? 'session days saved on this device' : 'dni z sesją zapisane na tym urządzeniu'} />
          <Kpi label={en ? 'This tab' : 'Ta karta'} value={loc.jobs} hint={<span data-testid="tab-stats">{num(loc.samples)} {en ? 'samples' : 'próbek'} · {fl(loc.flops)} · {(loc.busyMs / 1000).toFixed(1)} s</span>} src={en ? 'measured in this tab now' : 'zmierzone teraz w tej karcie'} />
          <Kpi label={en ? 'My total' : 'Mój wkład'} value={mine ? fl(mine.flops) : '—'} tone="violet" hint={mine ? `${mine.jobs} ${en ? 'jobs' : 'zadań'} · ${num(mine.samples)} ${en ? 'samples' : 'próbek'}` : undefined} src={en ? 'RPC myc_compute_stats: FLOP estimate and samples reported by your nodes' : 'RPC myc_compute_stats: szacunek FLOP i próbki zgłoszone przez Twoje węzły'} verif="self" />
          <Kpi label={en ? 'Rank' : 'Miejsce'} value={rank ? `#${rank}` : '—'} hint={`${contrib.length} ${en ? 'contributors' : 'uczestników'}`} src={'RPC myc_compute_stats'} verif="self" />
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Measured throughput on this device (Fashion-MNIST CNN training)' : 'Zmierzona przepustowość tego urządzenia (trening CNN Fashion-MNIST)'}>
          {!bench.length ? (
            <Empty h="h-24" />
          ) : (
            <table className="w-full text-left text-sm" data-testid="bench">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1">backend</th>
                  <th className="py-1">{en ? 'device' : 'urządzenie'}</th>
                  <th className="py-1 text-right">{en ? 'samples/s' : 'próbek/s'}</th>
                  <th className="py-1 text-right">GFLOPS</th>
                </tr>
              </thead>
              <tbody>
                {bench.map((b) => (
                  <tr key={b.backend} className="border-t border-white/5 text-slate-300">
                    <td className="py-1">{b.backend}</td>
                    <td className="py-1 text-xs text-slate-400">{b.device}</td>
                    <td className="py-1 text-right tabular-nums">{b.sps}</td>
                    <td className="py-1 text-right tabular-nums">{b.gflops}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bGpu && bCpu && (
            <p className="mt-2 text-sm text-spore" data-testid="speedup">
              {en ? 'GPU vs one WASM worker' : 'GPU vs jeden wątek WASM'}: ×{(bGpu.sps / bCpu.sps).toFixed(1)}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            <L pl="Pomiar: 3 s treningu (partie po 64) na prawdziwym odłamku; GFLOPS = próbki/s × FLOP-y sieci na próbkę (przód + wstecz ≈ 3× przód)." en="Measured: 3 s of training (batches of 64) on a real shard; GFLOPS = samples/s × network FLOPs per sample (forward + backward ≈ 3× forward)." />
          </p>
        </Card>
        <Card title={en ? 'Global models (latest version, held-out test)' : 'Modele globalne (ostatnia wersja, odłożony test)'}>
          <table className="w-full text-left text-sm" data-testid="models">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1">{en ? 'task' : 'zadanie'}</th>
                <th className="py-1">{en ? 'version' : 'wersja'}</th>
                <th className="py-1 text-right">{en ? 'accuracy' : 'trafność'}</th>
                <th className="py-1 text-right">{en ? 'updates ✓/✗' : 'aktualizacje ✓/✗'}</th>
              </tr>
            </thead>
            <tbody>
              {MODELS.map((m) => {
                const r = latest(m)
                return (
                  <tr key={m} className="border-t border-white/5 text-slate-300" data-model={m}>
                    <td className="py-1">
                      {en ? TITLES[m].en : TITLES[m].pl}
                      <div className="text-xs text-slate-500">{TITLES[m].arch}{r?.meta.algo && r.meta.algo !== 'init' ? ` · ${r.meta.algo}` : ''}</div>
                    </td>
                    <td className="py-1 tabular-nums">{r ? `v${r.version}` : '—'}</td>
                    <td className="py-1 text-right tabular-nums">{pct(r?.acc)}</td>
                    <td className="py-1 text-right tabular-nums text-xs">{r ? `${r.n_updates}/${r.n_rejected}` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {stats?.queue && ( // pusta/niepełna odpowiedź bazy = brak linii, nie błąd strony
            <p className="mt-2 text-xs text-slate-500" data-testid="queue">
              {en ? 'Queue' : 'Kolejka'}: {stats.queue.open} {en ? 'open' : 'otwartych'} · {stats.queue.leased} {en ? 'in progress' : 'w toku'} · {stats.queue.done} {en ? 'done (2 days)' : 'gotowych (2 dni)'}
            </p>
          )}
          <div className="mt-3 border-t border-white/5 pt-2" data-testid="candidates">
            <p className="text-xs text-slate-400">
              <L pl="Niezależna ocena: kandydat staje się wersją dopiero, gdy stały test policzą 2 inne węzły z innych adresów IP albo zaufany węzeł (cron GitHub). Liczy się najniższy wynik." en="Independent evaluation: a candidate becomes a version only after 2 other nodes from different IP addresses, or the trusted node (GitHub cron), compute the fixed test. The lowest result counts." />
            </p>
            {net.cands && !net.cands.length && <p className="text-xs text-slate-500">{en ? 'no candidates yet' : 'brak kandydatów jeszcze'}</p>}
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {(net.cands ?? []).map((c, i) => (
                <li key={i} className="tabular-nums">
                  {ago(c.created_at, lang)} · {en ? titleOf(c.model).en : titleOf(c.model).pl} v{c.version}: {en ? 'declared' : 'deklaracja'} {(c.acc_claimed * 100).toFixed(2)}%
                  {c.verified_acc != null ? ` · ${en ? 'verified' : 'sprawdzone'} ${(c.verified_acc * 100).toFixed(2)}%` : ''} · {c.verifiers?.length ?? 0} {en ? 'verifiers' : 'weryf.'}
                  {c.verifiers?.some((v) => v.trusted) ? ' (cron)' : ''} · {{ pending: en ? 'waiting' : 'czeka', published: en ? 'published' : 'opublikowany', rejected: en ? 'rejected' : 'odrzucony', expired: en ? 'expired' : 'wygasł' }[c.status] ?? c.status}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 border-t border-white/5 pt-2" data-testid="gate">
            <p className="text-xs text-slate-400">
              <L pl="Bramka bez regresji (baza): nowa wersja wchodzi tylko z trafnością ≥ bieżącej na stałym teście. Ostatnio odrzucone:" en="No-regression gate (database): a new version is accepted only with accuracy ≥ the current one on the fixed test set. Recently rejected:" />
            </p>
            {net.gate && !net.gate.length && <p className="text-xs text-slate-500">{en ? 'none yet' : 'brak jeszcze'}</p>}
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {(net.gate ?? []).map((g, i) => (
                <li key={i} className="tabular-nums">
                  {ago(g.created_at, lang)} · {en ? titleOf(g.model).en : titleOf(g.model).pl} v{g.version}: {g.acc != null && g.cur_acc != null ? `${(g.acc * 100).toFixed(2)}% < ${(g.cur_acc * 100).toFixed(2)}%` : g.reason}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Global model accuracy per version' : 'Trafność modelu globalnego w kolejnych wersjach'}>
          <TimeChart data={accPoints} series={MODELS.map((m) => ({ key: m, name: en ? TITLES[m].en : TITLES[m].pl, color: COLORS[m] }))} unit="%" domain={[0, 100]} />
        </Card>
        <Card title={en ? 'Compute contributed per hour (TFLOP, GPU vs CPU)' : 'Wkład obliczeń na godzinę (TFLOP, GPU vs CPU)'}>
          <TimeChart data={hourly} series={[{ key: 'gpu', name: 'GPU', color: '#5eead4' }, { key: 'cpu', name: 'CPU (WASM)', color: '#fbbf24' }]} />
          <p className="mt-2 text-xs text-slate-400" data-testid="totals">
            {en ? 'Total' : 'Razem'}: {num(tot.samples)} {en ? 'samples' : 'próbek'} · {fl(tot.flops)} · GPU {tot.flops ? `${((100 * tot.gpu) / tot.flops).toFixed(0)}%` : '—'}
            {stats?.backends &&
              Object.entries(stats.backends).map(([b, v]) => (
                <span key={b}> · {b}: {v.ms ? Math.round(v.samples / (v.ms / 1000)) : '—'} {en ? 'samples/s per job' : 'próbek/s na zadanie'}</span>
              ))}
          </p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Contributors (for future rewards)' : 'Uczestnicy (pod przyszłe nagrody)'}>
          {!contrib.length && <Empty h="h-24" />}
          <ol className="space-y-1 text-sm" data-testid="ranking">
            {contrib.slice(0, 12).map((c, i) => (
              <li key={c.contributor_id} className={`flex justify-between gap-2 ${c.contributor_id === ids.contributor ? 'text-glow' : 'text-slate-300'}`}>
                <span>
                  {i + 1}. {agentName(c.contributor_id)} {c.contributor_id === ids.contributor && (en ? '(you)' : '(Ty)')}
                </span>
                <span className="tabular-nums text-xs text-slate-400">
                  {fl(c.flops)} · GPU {c.flops ? `${((100 * (c.gpu_flops ?? 0)) / c.flops).toFixed(0)}%` : '—'} · {c.jobs} {en ? 'jobs' : 'zadań'} · ✓{c.accepted} ✗{c.rejected} · {ago(c.last, lang)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
        <Card title={en ? 'This tab: recent work' : 'Ta karta: ostatnia praca'}>
          {!pool.log.length && <Empty h="h-24" />}
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs" data-testid="log">
            {pool.log.map((l, i) => (
              <li key={i} className={l.ok ? 'text-slate-300' : 'text-rose-300'}>
                <span className="text-slate-500">{ago(l.at, lang)}</span> {l.backend && <span className="text-slate-500">[{l.backend}]</span>} {l.what}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="mt-4" title={en ? 'Privacy and how it works' : 'Prywatność i jak to działa'}>
        <div className="space-y-2 text-sm text-slate-300" data-testid="privacy">
          <p><L
            pl="Strona NIE zbiera Twoich danych osobowych, plików, zdjęć, lokalizacji ani historii przeglądania. Trening odbywa się na publicznych zbiorach (Fashion-MNIST, UCI HAR, CLINC150, WordNet/plWordNet), pobieranych odłamkami. Do grzybni trafiają tylko skompresowane zmiany wag (top-k + int8), metryki, liczba próbek, FLOP-y, czas i rodzaj backendu, z losowym identyfikatorem tego urządzenia."
            en="This page does NOT collect your personal data, files, photos, location or browsing history. Training uses public datasets (Fashion-MNIST, UCI HAR, CLINC150, WordNet/plWordNet) downloaded in shards. Only compressed weight changes (top-k + int8), metrics, sample counts, FLOPs, time and backend type are sent, with a random ID of this device."
          /></p>
          <p><L
            pl="Działa tylko, gdy karta jest widoczna: po przełączeniu karty praca się wstrzymuje, a przy baterii poniżej 20% (bez ładowania) sesja się zatrzymuje. Suwak CPU ustala liczbę wątków roboczych i cykl pracy (przerwy chłodzące poniżej 100%), GPU włączasz osobno."
            en="It only runs while the tab is visible: switching tabs pauses it, and below 20% battery (not charging) the session stops. The CPU slider sets the number of workers and the duty cycle (cooling pauses below 100%); the GPU has its own switch."
          /></p>
          <p><L
            pl="Każda aktualizacja jest sprawdzana przed scaleniem: przycięcie normy, test kierunku (kosinus względem mediany), ponowny pomiar na danych walidacyjnych, porównanie z deklaracją węzła, a co czwarta – weryfikacja na innym węźle. Przyjęte łączy FedProx/FedAvg w nową wersję modelu (wagi w Supabase Storage). Licznik wkładu jest zapisywany na przyszłe nagrody – dziś nie ma żadnego tokena ani płatności."
            en="Every update is checked before merging: norm clipping, a direction test (cosine vs. the median), re-measurement on validation data, comparison with the node's claim, and every fourth is verified on another node. Accepted ones are merged with FedProx/FedAvg into a new model version (weights in Supabase Storage). The contribution meter is kept for future rewards – there is no token or payment today."
          /></p>
        </div>
      </Card>
    </>
  )
}
