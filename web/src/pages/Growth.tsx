import { useState } from 'react'
import ActivityFeed from '../components/ActivityFeed'
import { TimeChart, type Point } from '../components/TimeChart'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
import { Card, Kpi, PageHeader, Src } from '../components/ui'
import { L, useI18n } from '../i18n'
import { FACT_CONF, useBrain, type GrowthStep } from '../myc/brain'
import { truth } from '../myc/consensus'
import { accPoints } from '../myc/provenance'

const GROWTH_EVENTS = new Set(['action', 'accept', 'reject', 'spawn', 'prune', 'question', 'join', 'train'])

export default function Growth() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const d = b.store.data
  const [step, setStep] = useState<GrowthStep | undefined>(b.autonomy.last)
  const [copied, setCopied] = useState(false)
  const invite = `${location.origin}${import.meta.env.BASE_URL}?join=1#/teach`

  const accs = accPoints(d.stats)
  const decisions: Point[] = (() => {
    const ev = d.growth.filter((g) => ['accept', 'spawn', 'prune', 'reject'].includes(g.event) && g.created_at).sort((x, y) => x.created_at.localeCompare(y.created_at))
    let acc = 0
    let rej = 0
    return ev.map((g) => {
      if (g.event === 'reject') rej++
      else acc++
      return { t: Date.parse(g.created_at), acc, rej }
    })
  })()
  const facts = Object.keys(b.cons.posterior).filter((q) => (truth(b.cons, q)?.[1] ?? 0) >= FACT_CONF).length
  const g = Object.values(d.gold).reduce((s, [n, c]) => [s[0] + n, s[1] + c], [0, 0])
  const nodes = new Set([...d.answers.map((a) => a.node_id), ...d.growth.map((x) => x.node_id)]).size
  const sc = b.scores
  const specialists = b.cfg.intent.specialists
  const labels = b.qa?.intent.labels_pl ?? []
  const labelsEn = b.qa?.intent.labels ?? []

  const run = () => setStep(b.growStep())
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Mycelium AI', text: en ? 'Join the mycelium as a node' : 'Dołącz do grzybni jako węzeł', url: invite })
      else {
        await navigator.clipboard.writeText(invite)
        setCopied(true)
      }
    } catch {
      /* anulowane */
    }
  }

  return (
    <>
      <PageHeader title={en ? 'Growth' : 'Wzrost'}>
        <L
          pl="Grzybnia sama dąży do wyższej trafności w testach i większej wiedzy: mierzy cele, z ciekawości wybiera, czego uczyć się dalej, wymyśla zmiany i przyjmuje je tylko wtedy, gdy wynik rośnie bez regresji. Tworzy specjalistów dla słabych nisz i przycina zbędnych. Działa w każdej otwartej przeglądarce i w cronie GitHub Actions."
          en="The mycelium strives for higher test accuracy and more knowledge on its own: it measures goals, picks what to learn next out of curiosity, invents changes and keeps them only if the score rises without regressions. It spawns specialists for weak niches and prunes useless ones. It runs in every open browser and in a GitHub Actions cron."
        />
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi
          label={en ? 'Goal: test accuracy' : 'Cel: trafność w testach'}
          value={sc ? pct(sc.intent) : '…'}
          hint={sc ? `${en ? 'intents' : 'intencje'} n=${sc.n.intent} · ${en ? 'sensor' : 'czujnik'} ${pct(sc.sensor)} (n=${sc.n.sensor})` : undefined}
          src={en ? 'computed in this browser on fixed test sets (qa.json)' : 'policzone w tej przeglądarce na stałych zbiorach testowych (qa.json)'}
        />
        <Kpi label={en ? 'Goal: facts known' : 'Cel: poznane fakty'} value={facts} tone="amber" src={en ? `questions with consensus ≥ ${FACT_CONF * 100}% (myc_answers)` : `pytania z konsensusem ≥ ${FACT_CONF * 100}% (myc_answers)`} verif="db" />
        <Kpi label={en ? 'Goal: gold accuracy' : 'Cel: trafność kontrolna'} value={g[0] ? `${((g[1] / g[0]) * 100).toFixed(1)}%` : '—'} hint={g[0] ? `${g[1]}/${g[0]}` : undefined} tone="violet" src={en ? 'RPC myc_gold_stats: answers to control questions with a known answer' : 'RPC myc_gold_stats: odpowiedzi na pytania kontrolne ze znaną odpowiedzią'} verif="db" />
        <Kpi label={en ? 'Goal: answering nodes' : 'Cel: węzły odpowiadające'} value={nodes} src={en ? 'distinct node ids in myc_answers and myc_growth' : 'różne identyfikatory węzłów w myc_answers i myc_growth'} verif="db" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title={en ? 'In-browser test accuracy over time (%)' : 'Trafność w testach w przeglądarce w czasie (%)'} className="xl:col-span-2">
          <TimeChart
            data={accs}
            unit="%"
            domain={[0, 100]}
            series={[
              { key: 'intent', name: en ? 'intents' : 'intencje', color: '#c4b5fd' },
              { key: 'sensor', name: en ? 'sensor (bal.)' : 'czujnik (zbal.)', color: '#5eead4' },
              { key: 'knowledge', name: en ? 'facts confirmed' : 'fakty potwierdzone', color: '#fbbf24' },
            ]}
          />
          <Src v="self">{en ? `myc_node_stats rows from browser nodes (${accs.length} points)` : `wiersze myc_node_stats z węzłów-przeglądarek (punktów: ${accs.length})`}</Src>
        </Card>
        <Card title={en ? 'Autonomy' : 'Autonomia'}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={b.autonomy.on} onChange={(e) => b.setAutonomy(e.target.checked)} data-testid="autonomy" />
            {en ? 'grow on its own while this page is open (every 3 min)' : 'rośnij sama, gdy strona jest otwarta (co 3 min)'}
          </label>
          <button onClick={run} disabled={!b.ready} className="mt-3 w-full rounded-xl border border-spore/40 px-4 py-2 text-sm text-spore hover:bg-spore/10 disabled:opacity-50" data-testid="grow-now">
            {en ? 'Run one growth step now' : 'Wykonaj krok wzrostu teraz'}
          </button>
          {step && (
            <p className="mt-2 text-xs text-slate-400" data-testid="grow-result">
              {en ? 'curiosity chose' : 'ciekawość wybrała'}: <b className="text-slate-200">{step.niche}</b> · {step.change} →{' '}
              <b className={step.accepted ? 'text-spore' : 'text-rose'}>{step.accepted ? (en ? 'accepted' : 'przyjęta') : en ? 'rejected' : 'odrzucona'}</b> ({step.gain >= 0 ? '+' : ''}
              {(step.gain * 100).toFixed(1)} pp)
            </p>
          )}
          <div className="mt-4 border-t border-white/5 pt-3">
            <div className="text-xs uppercase tracking-wider text-slate-500">{en ? 'Recruit nodes' : 'Werbuj węzły'}</div>
            <p className="mt-1 text-xs text-slate-400">{en ? 'Anyone who opens the link becomes a node automatically.' : 'Każdy, kto otworzy link, automatycznie zostaje węzłem.'}</p>
            <div className="mt-2 flex gap-2">
              <input readOnly value={invite} className="w-full rounded-lg border border-white/10 bg-ink/60 px-2 py-1.5 text-xs" aria-label={en ? 'Invite link' : 'Link zaproszenia'} data-testid="invite" />
              <button onClick={share} className="shrink-0 rounded-lg border border-white/10 px-3 text-xs">
                {copied ? (en ? 'Copied' : 'Skopiowano') : en ? 'Share' : 'Udostępnij'}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title={en ? 'Accepted vs rejected improvements (cumulative)' : 'Przyjęte i odrzucone ulepszenia (narastająco)'} className="xl:col-span-2">
          <TimeChart data={decisions} series={[{ key: 'acc', name: en ? 'accepted' : 'przyjęte', color: '#5eead4' }, { key: 'rej', name: en ? 'rejected' : 'odrzucone', color: '#fb7185' }]} />
        </Card>
        <Card title={en ? 'Specialised agents' : 'Agenci specjaliści'}>
          {specialists.length === 0 ? (
            <p className="text-sm text-slate-500">{en ? 'none yet – spawned when a niche is weak' : 'jeszcze brak – powstają, gdy nisza jest słaba'}</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="specialists">
              {specialists.map((c) => (
                <li key={c}>
                  ✣ {en ? 'specialist' : 'specjalista'}: <b className="text-spore">{en ? labelsEn[c] : labels[c]}</b>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            {en ? 'config' : 'konfiguracja'}: intent lr {b.cfg.intent.lr}, dim {b.cfg.intent.dim}
            {b.cfg.intent.bigrams ? ', bigrams' : ''}; sensor thr {b.cfg.sensor.threshold}, w+ {b.cfg.sensor.pos_weight}
          </p>
        </Card>
      </div>

      <Card className="mt-4" title={en ? 'Growth timeline: goals, self-chosen actions, decisions' : 'Oś wzrostu: cele, samodzielne akcje, decyzje'}>
        <ActivityFeed data={d} filter={(a) => GROWTH_EVENTS.has(a.event)} limit={60} />
      </Card>
    </>
  )
}
