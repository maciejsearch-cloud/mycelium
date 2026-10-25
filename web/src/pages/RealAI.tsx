import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TimeChart } from '../components/TimeChart'
import { Card, Kpi, PageHeader, Src, tooltipStyle } from '../components/ui'
import { at } from '../myc/provenance'
import { pct } from '../data'
import { L, useI18n } from '../i18n'
import type { AiAgent, FedCompare, Snapshot } from '../types'
import { RozbiorCard } from '../components/RozbiorCard'

const FED_KEYS = [
  { k: 'local', pl: 'tylko lokalnie', en: 'local only', c: '#64748b' },
  { k: 'fedavg', pl: 'FedAvg', en: 'FedAvg', c: '#5eead4' },
  { k: 'fedprox', pl: 'FedProx', en: 'FedProx', c: '#a78bfa' },
  { k: 'fed_private', pl: 'prywatnie (DP + secure agg)', en: 'private (DP + secure agg)', c: '#fbbf24' },
  { k: 'centralized', pl: 'centralnie (wszystkie dane)', en: 'centralized (all data)', c: '#f1f5f9' },
] as const

function metric(a: AiAgent['test'], kind: string) {
  // brak pomiaru = „—”, nigdy zero zastępcze
  const f3 = (x?: number) => (x == null ? '—' : x.toFixed(3))
  return kind === 'classification' ? `${a.accuracy == null ? '—' : pct(a.accuracy)} acc · F1 ${f3(a.macro_f1)}` : `RMSE ${f3(a.rmse)} (naiwna ${f3(a.naive_rmse)})`
}

export default function RealAI({ snap }: { snap: Snapshot }) {
  const { lang } = useI18n()
  const ai = snap.ai
  if (!ai)
    return (
      <PageHeader title={lang === 'en' ? 'Real AI' : 'Prawdziwe AI'}>
        <L pl="Brak wyników – uruchom python -m iot_mycelium ai-bench." en="No results yet – run python -m iot_mycelium ai-bench." />
      </PageHeader>
    )
  const har = ai.federated.find((f) => f.task === 'har') ?? ai.federated[0]
  return (
    <>
      <PageHeader title={lang === 'en' ? 'Real AI' : 'Prawdziwe AI'}>
        <L
          pl="Agenci PyTorch uczą się na prawdziwych, publicznych zbiorach danych. Hiperparametry dobiera Optuna wyłącznie na walidacji, wynik liczony raz na odłożonym zbiorze testowym. Wszystko na CPU."
          en="PyTorch agents learn from real public datasets. Optuna picks hyperparameters on validation only; scores are measured once on a held-out test set. CPU only."
        />
      </PageHeader>
      <Src v="recorded" className="-mt-3 mb-3">
        {lang === 'en'
          ? `All numbers on this tab come from one recorded run of python -m iot_mycelium ai-bench on ${at(ai.generated_at, true)} (commit ${ai.git ?? '?'}, ${ai.machine.cpu} CPU, torch ${ai.machine.torch}, synthetic data: ${ai.synthetic ? 'yes' : 'no'}). Anyone can re-run it; it is not re-checked automatically.`
          : `Wszystkie liczby na tej karcie pochodzą z jednego nagranego przebiegu python -m iot_mycelium ai-bench z ${at(ai.generated_at, false)} (commit ${ai.git ?? '?'}, ${ai.machine.cpu} CPU, torch ${ai.machine.torch}, dane syntetyczne: ${ai.synthetic ? 'tak' : 'nie'}). Każdy może go powtórzyć; nie jest automatycznie sprawdzany ponownie.`}
      </Src>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi
          label={lang === 'en' ? 'Benchmark (MBS, recorded)' : 'Benchmark (MBS, nagrany)'}
          value={ai.mbs.toFixed(1)}
          hint={lang === 'en' ? `mean of chance-normalised test scores · linear baseline ${ai.mbs_linear.toFixed(1)} · 0–100` : `średnia wyników testowych znormalizowanych wzgl. losowania · baseline liniowy ${ai.mbs_linear.toFixed(1)} · 0–100`}
          src={`snapshot.json · ${at(ai.generated_at, lang === 'en')} · commit ${ai.git ?? '?'}`}
          verif="recorded"
        />
        <Kpi label={lang === 'en' ? 'Real datasets' : 'Prawdziwe zbiory'} value={ai.agents.length} hint={ai.agents.map((a) => a.task).join(', ')} tone="violet" />
        {har && (
          <Kpi
            label={lang === 'en' ? `Federated gain (${har.task})` : `Zysk z federacji (${har.task})`}
            value={`${har.fedavg.test.score >= har.local.test.score ? '+' : ''}${((har.fedavg.test.score - har.local.test.score) * 100).toFixed(1)} pp`}
            hint={lang === 'en' ? `vs. each agent alone; centralized ${pct(har.centralized.test.score)}` : `vs. agent sam; centralnie ${pct(har.centralized.test.score)}`}
            tone="amber"
          />
        )}
        <Kpi label={lang === 'en' ? 'Shared memory' : 'Wspólna pamięć'} value={ai.memory.size} hint={lang === 'en' ? 'experience vectors' : 'wektorów doświadczeń'} />
      </div>
      <RozbiorCard en={lang === 'en'} />

      <Card className="mt-4" title={lang === 'en' ? 'Agents on real data (held-out test set)' : 'Agenci na prawdziwych danych (zbiór testowy)'}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="ai-table">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="py-2 pr-3">{lang === 'en' ? 'Task / data' : 'Zadanie / dane'}</th>
                <th className="py-2 pr-3">{lang === 'en' ? 'Agent result' : 'Wynik agenta'}</th>
                <th className="py-2 pr-3">{lang === 'en' ? 'Linear baseline' : 'Baseline liniowy'}</th>
                <th className="py-2 pr-3">{lang === 'en' ? 'Model' : 'Model'}</th>
                <th className="py-2 pr-3">{lang === 'en' ? 'Memory warm start' : 'Start z pamięci'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {ai.agents.map((a) => (
                <tr key={a.task} className="align-top">
                  <td className="py-2.5 pr-3">
                    <div className="text-slate-200">{(lang === 'en' ? a.summary.title_en : a.summary.title_pl) ?? a.task}</div>
                    <div className="text-xs text-slate-500">
                      {a.summary.url ? (
                        <a className="underline decoration-white/20 hover:text-slate-300" href={a.summary.url} target="_blank" rel="noreferrer">
                          {a.summary.source}
                        </a>
                      ) : (
                        a.summary.source
                      )}{' '}
                      · train {a.summary.n_train.toLocaleString()} / test {a.summary.n_test.toLocaleString()}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums">
                    <b className="text-spore">{pct(a.test.score)}</b>
                    <div className="text-xs text-slate-400">{metric(a.test, a.summary.kind)}</div>
                  </td>
                  <td className="py-2.5 pr-3 tabular-nums text-slate-400">
                    {pct(a.linear.score)}
                    <div className="text-xs">{metric(a.linear, a.summary.kind)}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-slate-400">
                    <span className="font-mono text-slate-300">{a.model.spec}</span>
                    <div>
                      {(a.model.n_params / 1000).toFixed(0)}k {lang === 'en' ? 'params' : 'parametrów'} · {a.seconds.toFixed(0)} s ·{' '}
                      {a.selected === 'linear' ? (lang === 'en' ? 'linear won on validation' : 'liniowy wygrał na walidacji') : `Optuna ${a.tuning.trials.length} ${lang === 'en' ? 'trials' : 'prób'}`}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-slate-400">
                    {a.tuning.warm_start ? (
                      <>
                        {lang === 'en' ? 'from' : 'z'} <span className="font-mono text-slate-300">{a.tuning.warm_start.from}</span> (cos {a.tuning.warm_start.similarity.toFixed(2)})
                        <div>{lang === 'en' ? `rank ${a.tuning.warm_rank} of ${a.tuning.trials.length}` : `miejsce ${a.tuning.warm_rank} z ${a.tuning.trials.length}`}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          <L
            pl="Wynik = dokładność znormalizowana względem zgadywania (klasyfikacja) albo poprawa względem prognozy naiwnej „jak ostatnio” (czujniki)."
            en="Score = accuracy normalised against chance (classification) or improvement over the naive “same as last reading” forecast (sensors)."
          />
        </p>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {ai.federated.map((f) => (
          <FedCard key={f.task} f={f} />
        ))}
      </div>

      <Card className="mt-4" title={lang === 'en' ? 'Test score per dataset over time (real runs)' : 'Wynik testowy na zbiorach w czasie (prawdziwe przebiegi)'}>
        <TimeChart
          data={(ai.history ?? []).map((h) => ({ t: Date.parse(h.t), ...Object.fromEntries(Object.entries(h.scores).map(([k, v]) => [k, Math.round(v * 1000) / 10])) }))}
          series={ai.agents.map((a, i) => ({ key: a.task, name: a.task, color: ['#5eead4', '#c4b5fd', '#fbbf24', '#fb7185', '#94a3b8'][i % 5] }))}
          unit="%"
        />
        <p className="mt-3 text-xs text-slate-500">
          {lang === 'en' ? 'Run' : 'Przebieg'}: {new Date(ai.generated_at).toLocaleString(lang === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Amsterdam' })} (Amsterdam) · git {ai.git ?? '—'} ·
          torch {ai.machine.torch} · {ai.machine.cpu} CPU · {ai.seconds.toFixed(0)} s
        </p>
      </Card>
    </>
  )
}

function FedCard({ f }: { f: FedCompare }) {
  const { lang } = useI18n()
  const bars = FED_KEYS.map((x) => ({ name: lang === 'en' ? x.en : x.pl, v: +(f[x.k].test.score * 100).toFixed(1), c: x.c }))
  const rounds = f.fedavg.history.map((h, i) => ({ round: h.round, fedavg: +(h.val * 100).toFixed(1), fedprox: f.fedprox.history[i] ? +(f.fedprox.history[i].val * 100).toFixed(1) : null, priv: f.fed_private.history[i] ? +(f.fed_private.history[i].val * 100).toFixed(1) : null }))
  return (
    <Card title={`${lang === 'en' ? 'Federated learning' : 'Uczenie federacyjne'} · ${f.task}`}>
      <p className="mb-2 text-xs text-slate-400">
        {lang === 'en'
          ? `${f.fedavg.clients.length} devices (${f.config.partition === 'natural' ? 'one per group of people' : 'non-IID label split'}), ${f.config.rounds} rounds; only weights leave a device (${f.fedavg.comm_mb.toFixed(0)} MB sent).`
          : `${f.fedavg.clients.length} urządzeń (${f.config.partition === 'natural' ? 'każde = inne osoby' : 'nierówny podział klas'}), ${f.config.rounds} rund; z urządzenia wychodzą tylko wagi (${f.fedavg.comm_mb.toFixed(0)} MB).`}
      </p>
      <table className="w-full text-sm tabular-nums" data-testid="fed-table">
        <tbody className="divide-y divide-white/5">
          {bars.map((b) => (
            <tr key={b.name}>
              <td className="py-1 pr-2 text-slate-300">
                <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: b.c }} />
                {b.name}
              </td>
              <td className="py-1 text-right">{b.v}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 h-40">
        <ResponsiveContainer>
          <LineChart data={rounds} margin={{ left: -16, right: 8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="round" tick={{ fill: '#94a3b8', fontSize: 11 }} />
            <YAxis domain={['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 11 }} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${v}%`} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line dataKey="fedavg" name="FedAvg" stroke="#5eead4" dot={false} isAnimationActive={false} />
            <Line dataKey="fedprox" name="FedProx" stroke="#a78bfa" dot={false} isAnimationActive={false} />
            <Line dataKey="priv" name={lang === 'en' ? 'private' : 'prywatnie'} stroke="#fbbf24" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-slate-500">{lang === 'en' ? 'validation score per round' : 'wynik walidacyjny po każdej rundzie'}</p>
    </Card>
  )
}
