import type { ReactNode } from 'react'
import QRCode from 'qrcode'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { LmProgress } from '../components/LmProgress'
import { Samouk } from '../components/Samouk'
import { PcDownload } from '../components/PcDownload'
import { Empty, TimeChart, type Point } from '../components/TimeChart'
import { Card, Kpi, PageHeader } from '../components/ui'
import { L, useI18n } from '../i18n'
import { refCode, useBrain } from '../myc/brain'
import { nodeMode } from '../myc/node'
import { session } from '../myc/session'
import { ids, SB_KEY, SB_URL } from '../myc/store'
import { mesh } from '../mesh/mesh'

type Daily = { day: string; active: number; new_nodes: number; total: number }
type Ref = { ref: string; joins: number; last: string }
type Contrib = { contributor_id: string; jobs: number; samples: number; flops: number; accepted: number }

const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
const rpc = <T,>(fn: string) => fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: '{}' }).then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
const short = (id: string) => id.replace(/-/g, '').slice(0, 8)
const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} mld` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} mln` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} tys.` : String(n))

export const DEMO = 'https://maciejsearch-cloud.github.io/demo/mycelium/'

export default function NodePage({ embed = false }: { embed?: boolean }) {
  const en = useI18n().lang === 'en'
  useBrain()
  useSyncExternalStore(nodeMode.subscribe, nodeMode.getVersion)
  useSyncExternalStore(session.subscribe, session.getVersion)
  useSyncExternalStore(mesh.subscribe, mesh.getVersion)
  const [daily, setDaily] = useState<Daily[] | null | undefined>()
  const [computing, setComputing] = useState<number | null | undefined>()
  const [refs, setRefs] = useState<Ref[] | null | undefined>()
  const [board, setBoard] = useState<Contrib[] | undefined>()
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState('')
  const me = refCode()
  const base = location.origin + import.meta.env.BASE_URL
  const invite = `${base}?join=1&ref=${me}#/node`
  const widget = `<script src="${base}widget.js" data-ref="${me}" async></script>`
  const oneLiner = `pip install torch websockets --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple && curl -LO ${base}node/mycelium-node.pyz && python3 mycelium-node.pyz --join --name moj-wezel --threads 2`
  const docker = `docker run -d --restart unless-stopped --name mycelium-node -v myc-cache:/cache python:3.12-slim sh -c "pip install -q torch websockets --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple && python -c \\"import urllib.request as u; u.urlretrieve('${base}node/mycelium-node.pyz', '/n.pyz')\\" && MYC_CACHE=/cache python /n.pyz --join --name docker --threads 2"`

  useEffect(() => {
    void mesh.connect().catch(() => undefined)
    rpc<Daily[]>('myc_node_daily').then(setDaily, () => setDaily(null))
    // ta sama definicja co „Węzły liczące (24 h)” na Start: myc_node_contrib (węzły z wynikiem obliczeń)
    fetch(`${SB_URL}/rest/v1/myc_node_contrib?select=last_at&order=last_at.desc&limit=500`, { headers: H })
      .then((r) => (r.ok ? (r.json() as Promise<{ last_at: string }[]>) : Promise.reject(new Error(String(r.status)))))
      .then((rows) => setComputing(rows.filter((x) => Date.now() - Date.parse(x.last_at) < 24 * 3600e3).length), () => setComputing(null))
    rpc<Ref[]>('myc_referrals').then(setRefs, () => setRefs(null))
    rpc<{ contributors?: Contrib[] }>('myc_compute_stats').then((s) => setBoard(s?.contributors ?? []), () => setBoard([]))
  }, [])
  useEffect(() => {
    void QRCode.toDataURL(invite, { margin: 1, width: 200, color: { dark: '#0b1215', light: '#e2e8f0' } }).then(setQr, () => setQr(''))
  }, [invite])
  useEffect(() => {
    // widżet: zgoda kliknięta na stronie osadzającej → start dopiero teraz
    if (embed && new URLSearchParams(location.search).get('autostart') === '1' && !nodeMode.on) nodeMode.enable()
  }, [embed])

  const copy = async (what: string, txt: string) => {
    try {
      await navigator.clipboard.writeText(txt)
      setCopied(what)
    } catch {
      setCopied('')
    }
  }
  const myRefs = refs?.find((r) => r.ref === me)?.joins ?? 0
  const refBy = new Map((refs ?? []).map((r) => [r.ref, r.joins]))
  const pts: Point[] = (daily ?? []).map((d) => ({ t: Date.parse(`${d.day}T12:00:00`), active: d.active, total: d.total })).sort((a, b) => a.t - b.t)
  const meshNodes = mesh.view.nodes
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })
  const latest = daily?.reduce<Daily | undefined>((a, d) => (!a || d.day > a.day ? d : a), undefined)
  const todayRow = daily?.find((d) => d.day === today)
  const dv = (v: ReactNode) => (daily === undefined ? '…' : daily === null ? '—' : v)
  const st = session.running ? (en ? 'working' : 'pracuje') : session.active ? (en ? `paused${session.reason ? ` (${session.reason})` : ''}` : `wstrzymany${session.reason ? ` (${session.reason})` : ''}`) : en ? 'off' : 'wyłączony'
  const wakeTxt = { on: en ? 'screen kept on' : 'ekran nie gaśnie', off: en ? 'off' : 'wył.', unsupported: en ? 'not supported here' : 'brak w tej przeglądarce', denied: en ? 'denied' : 'odmowa' }[nodeMode.wake]

  const toggle = (
    <div className="flex flex-wrap items-center gap-3">
      {nodeMode.on ? (
        <button onClick={() => nodeMode.disable()} className="rounded-xl border border-rose/40 px-4 py-2 text-sm text-rose hover:bg-rose/10" data-testid="node-off">
          {en ? 'Stop being a node' : 'Przestań być węzłem'}
        </button>
      ) : (
        <button onClick={() => nodeMode.enable()} className="rounded-xl bg-spore px-4 py-2 text-sm font-semibold text-ink hover:brightness-110" data-testid="node-on">
          {en ? 'Become a node' : 'Zostań węzłem'}
        </button>
      )}
      <span className="text-sm text-slate-300" data-testid="node-state" data-on={nodeMode.on ? '1' : '0'}>
        {en ? 'session' : 'sesja'}: <b>{st}</b> · Wake Lock: <b data-testid="wake">{wakeTxt}</b>
      </span>
    </div>
  )
  if (embed)
    return (
      <div className="p-3 text-slate-200">
        <div className="mb-2 text-sm font-semibold text-glow">Mycelium AI</div>
        {toggle}
        <p className="mt-2 text-xs text-slate-400">
          {en ? 'Trains open models with spare CPU/GPU while this page is open. No personal data. ' : 'Trenuje otwarte modele wolną mocą CPU/GPU, gdy strona jest otwarta. Bez danych osobowych. '}
          <a className="underline" href={`${DEMO}#/node`} target="_blank" rel="noreferrer">
            {en ? 'More' : 'Więcej'}
          </a>
        </p>
      </div>
    )

  return (
    <>
      <PageHeader title={en ? 'Become a node' : 'Zostań węzłem'}>
        <L
          pl="Za Twoją zgodą ta przeglądarka trenuje modele grzybni wolną mocą CPU/GPU (zadania z kolejki, wyniki sprawdzane). Zgoda zostaje zapamiętana: po ponownym otwarciu strony sesja wznawia się sama, a Wake Lock nie pozwala zgasnąć ekranowi, gdy węzeł pracuje. Zainstaluj stronę jako aplikację, żeby mieć ją pod ręką. Bez danych osobowych; w każdej chwili możesz przestać."
          en="With your consent this browser trains the mycelium's models with spare CPU/GPU (jobs from the queue, results verified). Consent is remembered: when you reopen the page the session resumes by itself, and Wake Lock keeps the screen on while the node works. Install the page as an app to keep it handy. No personal data; you can stop any time."
        />
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label={en ? 'Nodes in the model mesh (now)' : 'Węzły w sieci modelu (teraz)'} value={mesh.view.connected ? meshNodes : '…'} src={en ? 'live count from the mesh relay' : 'liczone na żywo przez przekaźnik sieci (mesh)'} verif="db" />
        <Kpi
          label={en ? 'Nodes with any activity today' : 'Węzły z dowolną aktywnością dziś'}
          testid="kpi-active-today"
          value={dv(todayRow?.active ?? 0)}
          hint={computing == null ? undefined : en ? `of which computing (24 h): ${computing}` : `w tym liczące (24 h): ${computing}`}
          tone="amber"
          src={en ? `RPC myc_node_daily: distinct nodes with an answer, event or result on ${today} (Amsterdam)` : `RPC myc_node_daily: różne węzły z odpowiedzią, zdarzeniem lub wynikiem w dniu ${today} (Amsterdam)`} verif="db" />
        <Kpi label={en ? 'Nodes ever (any activity)' : 'Węzły kiedykolwiek (dowolna aktywność)'} value={dv(latest?.total ?? 0)} tone="violet" src={en ? 'RPC myc_node_daily: distinct node ids with any event since the start' : 'RPC myc_node_daily: różne identyfikatory węzłów z dowolnym zdarzeniem od początku'} verif="db" />
        <Kpi label={en ? 'People you referred' : 'Polecone przez Ciebie'} value={refs === undefined ? '…' : refs === null ? '—' : myRefs} hint={`${en ? 'code' : 'kod'} ${me}`} src="RPC myc_referrals" verif="db" />
      </div>

      <p className="mt-2 text-xs text-slate-500" data-testid="node-defs">
        {en
          ? 'Two definitions, two numbers: “computing nodes (24 h)” on Start = nodes that sent ≥ 1 compute result (myc_results) in the last 24 h; “any activity today” here = an answer, growth, federated training, a result or headless presence on the calendar day (Amsterdam). Every computing node is also active, not the other way round.'
          : 'Dwie definicje, dwie liczby: „węzły liczące (24 h)” na Start = węzły, które w ostatnich 24 h wysłały ≥ 1 wynik obliczeń (myc_results); „dowolna aktywność dziś” tutaj = odpowiedź, wzrost, trening federacyjny, wynik albo obecność bez przeglądarki w danym dniu kalendarzowym (Amsterdam). Każdy węzeł liczący jest też aktywny, ale nie odwrotnie.'}
      </p>


      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title={en ? 'This device' : 'To urządzenie'} className="xl:col-span-2">
          {toggle}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {nodeMode.installed ? (
              <span className="chip border-spore/40 text-spore">{en ? 'installed as an app' : 'zainstalowana jako aplikacja'}</span>
            ) : nodeMode.installable ? (
              <button onClick={() => void nodeMode.install()} className="rounded-lg border border-white/10 px-3 py-1.5" data-testid="install">
                {en ? 'Install as an app' : 'Zainstaluj jako aplikację'}
              </button>
            ) : (
              <span className="text-slate-500">{en ? 'Install: browser menu → “Install app” / “Add to Home screen”.' : 'Instalacja: menu przeglądarki → „Zainstaluj aplikację” / „Dodaj do ekranu głównego”.'}</span>
            )}
            <a href="#/session" className="rounded-lg border border-white/10 px-3 py-1.5">
              {en ? 'Session details and power limit →' : 'Szczegóły sesji i limit mocy →'}
            </a>
          </div>
        </Card>
        <Card title={en ? 'Invite' : 'Zaproś'}>
          <div className="flex gap-3">
            {qr ? <img src={qr} alt={en ? 'Invite QR code' : 'Kod QR zaproszenia'} width={120} height={120} className="rounded-lg" data-testid="qr" /> : <Empty h="h-28" />}
            <div className="min-w-0 flex-1 text-xs text-slate-400">
              {en ? 'Whoever opens your link becomes a node and is counted as your referral.' : 'Kto otworzy Twój link, zostaje węzłem i liczy się jako Twoje polecenie.'}
              <input readOnly value={invite} className="mt-2 w-full rounded-lg border border-white/10 bg-ink/60 px-2 py-1.5 text-xs" aria-label={en ? 'Invite link' : 'Link zaproszenia'} data-testid="invite-ref" />
              <button onClick={() => void copy('invite', invite)} className="mt-2 rounded-lg border border-white/10 px-3 py-1">
                {copied === 'invite' ? (en ? 'Copied' : 'Skopiowano') : en ? 'Copy' : 'Kopiuj'}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <Section id="pc" title={en ? 'Download the node for your PC (24/7)' : 'Węzeł na PC (24/7)'}>
        <PcDownload />
      </Section>
      <Section id="lm" title={en ? 'Language model progress' : 'Postęp modelu językowego'}>
        <LmProgress />
        <Samouk />
      </Section>

      <Section id="time" open title={en ? 'Nodes over time and leaderboard' : 'Węzły w czasie i ranking'}>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title={en ? 'Nodes over time (any activity per day, ever)' : 'Węzły w czasie (z dowolną aktywnością dziennie, kiedykolwiek)'} className="xl:col-span-2">
          {pts.length ? (
            <TimeChart data={pts} series={[{ key: 'active', name: en ? 'any activity' : 'dowolna aktywność', color: '#fbbf24' }, { key: 'total', name: en ? 'ever' : 'kiedykolwiek', color: '#5eead4' }]} />
          ) : (
            <Empty />
          )}
          <p className="mt-1 text-xs text-slate-500">{en ? 'From real events: answers, growth, federated training, compute results, headless node presence.' : 'Z prawdziwych zdarzeń: odpowiedzi, wzrost, trening federacyjny, wyniki obliczeń, obecność węzłów bez przeglądarki.'}</p>
        </Card>
        <Card title={en ? 'Leaderboard (compute)' : 'Ranking (obliczenia)'}>
          {!board ? (
            <Empty h="h-24" />
          ) : board.length === 0 ? (
            <p className="text-sm text-slate-500">{en ? 'no data yet' : 'brak danych jeszcze'}</p>
          ) : (
            <ol className="space-y-1 text-sm" data-testid="leaderboard">
              {board.slice(0, 10).map((c, i) => (
                <li key={c.contributor_id} className={`flex justify-between gap-2 ${c.contributor_id === ids.contributor ? 'text-spore' : ''}`}>
                  <span>
                    {i + 1}. {c.contributor_id === ids.contributor ? (en ? 'you' : 'Ty') : short(c.contributor_id)}
                  </span>
                  <span className="tabular-nums text-slate-400">
                    {fmt(c.samples)} {en ? 'samples' : 'próbek'} · {c.jobs} {en ? 'jobs' : 'zadań'} · {refBy.get(short(c.contributor_id)) ?? 0} {en ? 'ref.' : 'pol.'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      </Section>

      <Section id="install" title={en ? 'Always-on node and widget' : 'Stały węzeł i widżet'}>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Always-on node (computer, server, Raspberry Pi)' : 'Stały węzeł (komputer, serwer, Raspberry Pi)'}>
          <p className="text-xs text-slate-400">
            {en
              ? 'One self-contained file: the whole Qwen2.5-0.5B on CPU (PyTorch, ~2 GB RAM, ~1 GB download once). Answers chat with streamed tokens. Python 3.10+.'
              : 'Jeden samodzielny plik: cały Qwen2.5-0.5B na CPU (PyTorch, ~2 GB RAM, ~1 GB pobierane raz). Odpowiada w czacie strumieniem tokenów. Python 3.10+.'}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-ink/60 p-2 text-[11px]" data-testid="one-liner">{oneLiner}</pre>
          <button onClick={() => void copy('pip', oneLiner)} className="mt-1 rounded-lg border border-white/10 px-3 py-1 text-xs">
            {copied === 'pip' ? (en ? 'Copied' : 'Skopiowano') : en ? 'Copy' : 'Kopiuj'}
          </button>
          <div className="mt-3 text-xs text-slate-400">Docker:</div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-ink/60 p-2 text-[11px]">{docker}</pre>
          <button onClick={() => void copy('docker', docker)} className="mt-1 rounded-lg border border-white/10 px-3 py-1 text-xs">
            {copied === 'docker' ? (en ? 'Copied' : 'Skopiowano') : en ? 'Copy' : 'Kopiuj'}
          </button>
        </Card>
        <Card title={en ? 'Widget for your website (opt-in)' : 'Widżet na Twoją stronę (za zgodą)'}>
          <p className="text-xs text-slate-400">
            {en
              ? 'Visitors see a small box; nothing runs until they click “Become a node”. Joins are counted as your referrals.'
              : 'Odwiedzający widzą małe okienko; nic nie działa, dopóki nie klikną „Zostań węzłem”. Dołączenia liczą się jako Twoje polecenia.'}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-ink/60 p-2 text-[11px]" data-testid="widget-code">{widget}</pre>
          <button onClick={() => void copy('widget', widget)} className="mt-1 rounded-lg border border-white/10 px-3 py-1 text-xs">
            {copied === 'widget' ? (en ? 'Copied' : 'Skopiowano') : en ? 'Copy' : 'Kopiuj'}
          </button>
        </Card>
      </div>
      </Section>
    </>
  )
}

/** Zwijana sekcja strony Węzeł – na telefonie widać najpierw to urządzenie i liczby; reszta po dotknięciu. */
function Section({ id, title, open = false, children }: { id: string; title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group mt-4" open={open} data-testid={`sec-${id}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-slate-200">
        {title}
        <span className="text-slate-500 transition group-open:rotate-180">▾</span>
      </summary>
      {children}
    </details>
  )
}
