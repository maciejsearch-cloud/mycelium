import { useMemo } from 'react'
import FragGraph from '../components/FragGraph'
import ActivityFeed, { useTick, When } from '../components/ActivityFeed'
import { TimeChart, type Point } from '../components/TimeChart'
import { Card, Kpi, PageHeader, Src } from '../components/ui'
import { BROWSER_EVAL, frac } from '../myc/provenance'
import { L, useI18n } from '../i18n'
import { activities, describe, eventLabel, lastByNode, nodeKinds } from '../myc/activity'
import { agentName, FACT_CONF, useBrain } from '../myc/brain'
import { infer, truth } from '../myc/consensus'
import { ids } from '../myc/store'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export default function Knowledge() {
  const b = useBrain()
  useTick()
  const { lang } = useI18n()
  const en = lang === 'en'
  const d = b.store.data
  const opts = useMemo(() => (b.qa ? b.options() : {}), [b, b.version]) // eslint-disable-line react-hooks/exhaustive-deps

  // Odtworzenie konsensusu w punktach czasu z prawdziwych, datowanych odpowiedzi.
  const replay: Point[] = useMemo(() => {
    const ans = d.answers.filter((a) => a.created_at).sort((x, y) => x.created_at!.localeCompare(y.created_at!))
    if (!ans.length || !b.qa) return []
    const n = Math.min(ans.length, 24)
    const out: Point[] = []
    for (let i = 1; i <= n; i++) {
      const cut = ans.slice(0, Math.ceil((ans.length * i) / n))
      const c = infer(cut, opts, d.gold)
      const ts = Object.keys(c.posterior).map((q) => truth(c, q)![1])
      out.push({ t: Date.parse(cut[cut.length - 1].created_at!), facts: ts.filter((p) => p >= FACT_CONF).length, conf: ts.length ? (ts.reduce((s, p) => s + p, 0) / ts.length) * 100 : null, answers: cut.length, nodes: new Set(cut.map((a) => a.node_id)).size })
    }
    return out
  }, [d.answers, d.gold, opts, b.qa])

  const gold: Point[] = d.goldDaily.map((g) => ({ t: Date.parse(`${g.day}T12:00:00`), gold: g.n ? (g.correct / g.n) * 100 : null }))
  // tylko oceny z przeglądarki (ten sam stały test qa.json); cron Pythona liczy na innym podziale – nie mieszamy; NaN/poza 0–100% pomijane
  const p100 = (v: unknown) => (frac(v) == null ? null : frac(v)! * 100)
  const models: Point[] = d.stats
    .filter((s) => (s.kind ?? 'browser') === 'browser' && BROWSER_EVAL.has(s.label ?? '') && frac(s.acc?.intent) != null)
    .map((s) => ({
      t: Date.parse(s.created_at),
      intent: p100(s.acc.intent),
      intent_before: p100(s.acc.intent_before),
      sensor: p100(s.acc.sensor),
      sensor_before: p100(s.acc.sensor_before),
    }))

  const kinds = nodeKinds(d)
  const last = lastByNode(activities(d, 2000))
  const owners = new Set(d.answers.filter((a) => a.owner).map((a) => a.node_id))
  const nodes = Object.keys(b.cons.trust).sort((x, y) => (last[y]?.t ?? '').localeCompare(last[x]?.t ?? ''))
  const facts = Object.keys(b.cons.posterior).filter((q) => (truth(b.cons, q)?.[1] ?? 0) >= FACT_CONF)
  const g = Object.values(d.gold).reduce((s, [n, c]) => [s[0] + n, s[1] + c], [0, 0])
  const confs = Object.keys(b.cons.posterior).map((q) => truth(b.cons, q)![1])

  const factText = (id: string) => {
    const qa = b.qa
    const k = qa?.knowledge.questions.find((q) => q.id === id)
    if (k) return en ? k.en : k.pl
    const u = d.userQs.find((q) => q.id === id)
    if (u) return u.kind === 'qa' ? `${u.text} → ${u.answer}` : u.text
    const i = qa?.intent.questions.find((q) => q.id === id)
    if (i) return `„${i.text}”`
    return b.wordText(id, en) ?? (en ? `sensor window ${id}` : `okno czujnika ${id}`)
  }
  const factRows = Object.keys(b.cons.posterior)
    .map((id) => ({ id, t: truth(b.cons, id)!, n: d.answers.filter((a) => a.question_id === id).length }))
    .sort((x, y) => y.n - x.n || y.t[1] - x.t[1])
    .slice(0, 30)

  return (
    <>
      <PageHeader title={en ? 'Knowledge' : 'Wiedza'}>
        <L
          pl="Postęp wiedzy grzybni. Wszystko liczone z zapisanych, datowanych pomiarów: odpowiedzi węzłów, pytań kontrolnych i treningów. Czas: Amsterdam."
          en="The mycelium's knowledge progress, computed only from persisted, timestamped measurements: node answers, gold questions and training runs. Time zone: Amsterdam."
        />
      </PageHeader>
      <div className="mb-4">
        <FragGraph />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        <Kpi label={en ? 'Facts learned' : 'Poznane fakty'} value={facts.length} hint={`≥ ${FACT_CONF * 100}%`} src={en ? `consensus of node answers (myc_answers), trust-weighted` : `konsensus odpowiedzi węzłów (myc_answers), ważony zaufaniem`} verif="db" />
        <Kpi label={en ? 'Gold accuracy' : 'Trafność kontrolna'} value={g[0] ? pct(g[1] / g[0]) : '—'} hint={`${g[0]} ${en ? 'gold answers' : 'odp. kontrolnych'}`} tone="amber" src={en ? 'RPC myc_gold_stats: answers vs control questions with known answers' : 'RPC myc_gold_stats: odpowiedzi vs pytania kontrolne ze znaną odpowiedzią'} verif="db" />
        <Kpi label={en ? 'Consensus confidence' : 'Pewność konsensusu'} value={confs.length ? pct(confs.reduce((s, p) => s + p, 0) / confs.length) : '—'} tone="violet" src={en ? 'mean posterior of the consensus, computed in this browser from myc_answers' : 'średnia pewność konsensusu, liczona w tej przeglądarce z myc_answers'} verif="db" />
        <Kpi label={en ? 'Answering nodes' : 'Węzły odpowiadające'} value={nodes.length} src={en ? 'distinct nodes in myc_answers' : 'różne węzły w myc_answers'} verif="db" />
        <Kpi label={en ? 'Answers' : 'Odpowiedzi'} value={d.answers.length} tone="violet" src={en ? 'rows in myc_answers' : 'wiersze myc_answers'} verif="db" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Facts learned & consensus confidence over time' : 'Poznane fakty i pewność konsensusu w czasie'}>
          <TimeChart data={replay} series={[{ key: 'facts', name: en ? 'facts' : 'fakty', color: '#5eead4' }, { key: 'conf', name: en ? 'confidence %' : 'pewność %', color: '#c4b5fd' }]} />
          <Src v="db">{en ? 'consensus replayed in this browser over timestamped rows of myc_answers' : 'konsensus odtworzony w tej przeglądarce z datowanych wierszy myc_answers'}</Src>
        </Card>
        <Card title={en ? 'Gold-question accuracy per day' : 'Trafność na pytaniach kontrolnych (dziennie)'}>
          <TimeChart data={gold} series={[{ key: 'gold', name: en ? 'gold accuracy' : 'trafność', color: '#fbbf24' }]} unit="%" domain={[0, 100]} />
          <Src v="db">{en ? 'RPC myc_gold_daily: answers vs control questions with a known answer' : 'RPC myc_gold_daily: odpowiedzi vs pytania kontrolne ze znaną odpowiedzią'}</Src>
        </Card>
        <Card title={en ? 'Model accuracy: before vs after people’s feedback' : 'Trafność modeli: przed i po odpowiedziach ludzi'}>
          <TimeChart
            data={models}
            unit="%"
            series={[
              { key: 'intent_before', name: en ? 'intents – seed only' : 'intencje – start', color: '#64748b' },
              { key: 'intent', name: en ? 'intents – with feedback' : 'intencje – z odpowiedziami', color: '#5eead4' },
              { key: 'sensor_before', name: en ? 'sensor – seed only' : 'czujnik – start', color: '#78716c' },
              { key: 'sensor', name: en ? 'sensor – with feedback' : 'czujnik – z odpowiedziami', color: '#fbbf24' },
            ]}
          />
          <Src v="self">{en ? `myc_node_stats from browser nodes, fixed test set qa.json (${models.length} points)` : `myc_node_stats z węzłów-przeglądarek, stały test qa.json (punktów: ${models.length})`}</Src>
        </Card>
        <Card title={en ? 'Answers & nodes over time' : 'Odpowiedzi i węzły w czasie'}>
          <TimeChart data={replay} series={[{ key: 'answers', name: en ? 'answers (cum.)' : 'odpowiedzi (narast.)', color: '#5eead4' }, { key: 'nodes', name: en ? 'nodes' : 'węzły', color: '#fb7185' }]} />
        </Card>
      </div>

      <Card className="mt-4" title={en ? 'Agents / nodes – trust and last action' : 'Agenci / węzły – zaufanie i ostatnie działanie'}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm" data-testid="nodes-table">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-2 pr-3">{en ? 'Agent' : 'Agent'}</th>
                <th className="py-2 pr-3">{en ? 'Trust' : 'Zaufanie'}</th>
                <th className="py-2 pr-3">{en ? 'Consensus agreement' : 'Zgodność z konsensusem'}</th>
                <th className="py-2 pr-3">Gold</th>
                <th className="py-2 pr-3">{en ? 'Answers' : 'Odpowiedzi'}</th>
                <th className="py-2 pr-3">{en ? 'Last seen / last action' : 'Ostatnio / ostatnie działanie'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {nodes.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-slate-500">
                    {en ? 'no data yet' : 'brak danych jeszcze'}
                  </td>
                </tr>
              )}
              {nodes.map((n) => {
                const tr = b.cons.trust[n]
                const gs = d.gold[n]
                const la = last[n]
                return (
                  <tr key={n}>
                    <td className="py-2 pr-3">
                      <span className="text-slate-200">{agentName(n, kinds[n])}</span>
                      {n === ids.node && <span className="chip ml-1 text-spore">{en ? 'you' : 'Ty'}</span>}
                      {owners.has(n) && <span className="chip ml-1 text-violet">{en ? 'owner' : 'właścicielka'}</span>}
                      <div className="text-xs text-slate-500">{kinds[n] ?? 'browser'}</div>
                    </td>
                    <td className={`py-2 pr-3 tabular-nums ${tr >= 0.7 ? 'text-spore' : tr < 0.4 ? 'text-rose' : 'text-amber'}`}>{pct(tr)}</td>
                    <td className="py-2 pr-3 tabular-nums">{b.cons.agreement[n] == null ? '—' : pct(b.cons.agreement[n])}</td>
                    <td className="py-2 pr-3 tabular-nums text-slate-400">{gs ? `${gs[1]}/${gs[0]}` : '—'}</td>
                    <td className="py-2 pr-3 tabular-nums">{b.cons.answersPerNode[n] ?? 0}</td>
                    <td className="py-2 pr-3 text-xs text-slate-400">
                      {la ? (
                        <>
                          <When t={la.t} />
                          <div>
                            {eventLabel(la.event, en)} <span className="text-slate-500">{describe(la, en)}</span>
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          <L
            pl="Zaufanie = szacowana trafność węzła (Dawid-Skene): zgodność z konsensusem ważonym zaufaniem innych i wyniki na ukrytych pytaniach kontrolnych. Kłamcy spadają poniżej 50% i ich głosy działają przeciwnie."
            en="Trust = estimated node accuracy (Dawid-Skene): agreement with the trust-weighted consensus plus hidden gold-question results. Liars fall below 50% and their votes count inversely."
          />
        </p>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={en ? 'Facts: estimated truth probability' : 'Fakty: szacowane prawdopodobieństwo prawdy'}>
          {factRows.length === 0 ? (
            <p className="text-sm text-slate-500">{en ? 'no data yet' : 'brak danych jeszcze'}</p>
          ) : (
            <ul className="max-h-[28rem] space-y-1.5 overflow-y-auto text-sm" data-testid="facts">
              {factRows.map(({ id, t, n }) => (
                <li key={id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 text-slate-300">{factText(id)}</span>
                  <span className="shrink-0 text-xs tabular-nums">
                    <b className={t[1] >= FACT_CONF ? 'text-spore' : 'text-amber'}>{t[0] === 'tak' ? (en ? 'true' : 'prawda') : t[0] === 'nie' ? (en ? 'false' : 'fałsz') : t[0]}</b> {pct(t[1])} · {n}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={en ? 'Agent activity (live)' : 'Aktywność agentów (na żywo)'}>
          <ActivityFeed data={d} />
        </Card>
      </div>
    </>
  )
}
