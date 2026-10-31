import { LmProgress } from '../components/LmProgress'
import { Samouk } from '../components/Samouk'
import { NodeContrib } from '../components/NodeContrib'
import { useEffect, useState } from 'react'
import { Card, Kpi, PageHeader } from '../components/ui'
import { Empty, TimeChart, fmtTime, type Point } from '../components/TimeChart'
import { L, useI18n } from '../i18n'
import { chatStats, type ChatDay } from '../myc/chatlog'
import { SB_KEY, SB_URL } from '../myc/store'

// Dowody (dawniej „Weryfikacja”): surowe, publiczne dane z bazy (tylko odczyt) + odtwarzalna ocena. Nic tu nie jest liczone „na pokaz”.
type Row = Record<string, unknown>
const REST = `${SB_URL}/rest/v1`
const Q = {
  models: 'myc_models?select=model,version,acc,val_acc,n_updates,n_rejected,samples,flops,path,created_by,verifiers,created_at&order=created_at.asc&limit=5000',
  ci: 'myc_ci_evals?select=model,version,acc_stored,acc_recomputed,diff_pp,eval_n,eval_sha,eval_sha_ok,weights_sha,n_params,ok,run_url,created_at&order=created_at.desc&limit=5000',
  rejections: 'myc_model_rejections?select=model,version,node,acc,cur_acc,val_acc,eval_n,reason,created_at&order=created_at.desc&limit=2000',
  eval_sets: 'myc_eval_sets?select=model,n,sha,created_at',
  candidate_evals: 'myc_candidate_evals?select=candidate_id,node,trusted,acc,sha,n,backend,created_at&order=created_at.desc&limit=2000',
} as const
type Key = keyof typeof Q
const MODELS = ['fashion', 'har', 'intent', 'words'] as const
const COLORS: Record<string, string> = { fashion: '#5eead4', har: '#a78bfa', intent: '#fbbf24', words: '#fb7185' }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${REST}/${path}`, { headers: { apikey: SB_KEY } })
  if (!r.ok) throw new Error(String(r.status))
  return (await r.json()) as T
}

function download(name: string, rows: Row[], kind: 'csv' | 'json') {
  let body: string
  if (kind === 'json') body = JSON.stringify(rows, null, 1)
  else {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([body], { type: kind === 'csv' ? 'text/csv' : 'application/json' }))
  a.download = `${name}.${kind}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export default function Verification() {
  const en = useI18n().lang === 'en'
  const { lang } = useI18n()
  const [d, setD] = useState<Partial<Record<Key, Row[]>>>({})
  const [err, setErr] = useState<Partial<Record<Key, string>>>({})
  const [drv, setDrv] = useState<{ sessions: number; nodes: number; samples: number; jobs: number } | undefined>()
  const [hourly, setHourly] = useState<Point[]>([])
  const [chats, setChats] = useState<ChatDay[] | undefined>()

  useEffect(() => {
    for (const k of Object.keys(Q) as Key[])
      get<Row[]>(Q[k])
        .then((rows) => setD((x) => ({ ...x, [k]: rows })))
        .catch((e) => setErr((x) => ({ ...x, [k]: String(e.message ?? e) })))
    const since = new Date(Date.now() - 3600_000).toISOString()
    get<{ node_id: string; contributor_id: string; samples: number }[]>(`myc_results?select=node_id,contributor_id,samples&created_at=gt.${since}&limit=10000`)
      .then((rs) => setDrv({ sessions: new Set(rs.map((r) => r.contributor_id)).size, nodes: new Set(rs.map((r) => r.node_id)).size, samples: rs.reduce((a, r) => a + r.samples, 0), jobs: rs.length }))
      .catch(() => setDrv(undefined))
    fetch(`${REST}/rpc/myc_compute_stats`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((s: { hourly?: { t: string; samples: number }[] }) => setHourly((s.hourly ?? []).map((h) => ({ t: new Date(h.t).getTime(), samples: h.samples }))))
      .catch(() => setHourly([]))
    chatStats()
      .then(setChats)
      .catch(() => setChats([]))
  }, [])

  const models = d.models ?? []
  const ci = d.ci ?? []
  const ciBy = new Map(ci.map((r) => [`${r.model}:${r.version}`, r]))
  const latest = MODELS.map((m) => models.filter((r) => r.model === m).at(-1)).filter(Boolean) as Row[]
  const accPts: Point[] = models.map((r) => ({ t: new Date(r.created_at as string).getTime(), [r.model as string]: r.acc as number }))
  const ciOk = ci.filter((r) => r.ok).length
  const lastRun = ci.find((r) => r.run_url)?.run_url as string | undefined
  const base = import.meta.env.BASE_URL
  const restUrl = (k: Key) => `${REST}/${Q[k]}&apikey=${SB_KEY}`
  const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—')

  return (
    <>
      <PageHeader title={en ? 'Evidence' : 'Dowody'}>
        <L
          pl="Jak sprawdzić, że postęp jest prawdziwy: surowe dane z bazy (publiczny odczyt), stałe zbiory testowe z odciskiem sha256, skrypt, którym każdy przeliczy trafność z zapisanych wag, oraz niezależna ocena każdej wersji przez GitHub Actions. Do tego to, co napędza postęp: aktywne sesje, węzły i próbki na godzinę."
          en="How to check that progress is real: raw database data (public read), fixed test sets with sha256 fingerprints, a script anyone can run to recompute accuracy from the stored weights, and an independent GitHub Actions re-evaluation of every version. Plus what drives progress: active sessions, nodes and samples per hour."
        />
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="verify-kpis">
        <Kpi label={en ? 'Model versions' : 'Wersje modeli'} value={d.models ? models.length : '…'} hint={en ? 'in myc_models' : 'w myc_models'} src={'myc_models'} verif="db" />
        <Kpi label={en ? 'Re-evaluated by CI' : 'Ocenione ponownie w CI'} value={d.ci ? `${ciOk}/${ci.length}` : '…'} hint={en ? 'match within 0.5 pp' : 'zgodne do 0,5 pkt'} tone="violet" src={en ? 'myc_ci_evals: GitHub Actions recomputes accuracy from stored weights' : 'myc_ci_evals: GitHub Actions przelicza trafność z zapisanych wag'} verif="verified" />
        <Kpi label={en ? 'Rejected versions' : 'Odrzucone wersje'} value={d.rejections ? d.rejections.length : '…'} hint={en ? 'no-regression gate' : 'bramka bez regresji'} tone="amber" src={'myc_model_rejections'} verif="db" />
        <Kpi label={en ? 'Samples, last hour' : 'Próbki, ostatnia godzina'} value={drv ? drv.samples.toLocaleString(lang) : '…'} hint={drv ? `${drv.sessions} ${en ? 'sessions' : 'sesji'} · ${drv.nodes} ${en ? 'nodes' : 'węzłów'} · ${drv.jobs} ${en ? 'jobs' : 'zadań'}` : ''} tone="spore" src={en ? 'samples reported by nodes with results' : 'próbki zgłoszone przez węzły z wynikami'} verif="self" />
      </div>

      <LmProgress detail />
      <Samouk />
      <NodeContrib />

      <Card title={en ? 'Accuracy of each published version on the fixed test set' : 'Trafność każdej opublikowanej wersji na stałym teście'} className="mb-4">
        <TimeChart data={accPts} series={MODELS.map((m) => ({ key: m, name: m, color: COLORS[m] }))} unit="" domain={[0, 1]} />
      </Card>

      <Card title={en ? 'Latest versions: stored vs recomputed' : 'Najnowsze wersje: zapisane a przeliczone'} className="mb-4">
        {!latest.length ? (
          <Empty h="h-24" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="verify-latest">
              <thead className="text-left text-xs text-slate-400">
                <tr>
                  <th className="py-1">{en ? 'model' : 'model'}</th>
                  <th>{en ? 'version' : 'wersja'}</th>
                  <th>{en ? 'stored acc' : 'zapisana'}</th>
                  <th>{en ? 'CI recomputed' : 'przeliczona w CI'}</th>
                  <th>{en ? 'weights sha256' : 'wagi sha256'}</th>
                  <th>{en ? 'published' : 'opublikowana'}</th>
                </tr>
              </thead>
              <tbody>
                {latest.map((r) => {
                  const c = ciBy.get(`${r.model}:${r.version}`)
                  return (
                    <tr key={`${r.model}`} className="border-t border-white/5">
                      <td className="py-1">{r.model as string}</td>
                      <td>v{r.version as number}</td>
                      <td className="tabular-nums">{pct(r.acc)}</td>
                      <td className="tabular-nums">{c ? <span className={c.ok ? 'text-spore' : 'text-rose'}>{pct(c.acc_recomputed)} {c.ok ? '✓' : '✗'}</span> : <span className="text-slate-500">{en ? 'waiting for CI' : 'czeka na CI'}</span>}</td>
                      <td className="font-mono text-xs text-slate-400">{c ? String(c.weights_sha).slice(0, 12) : '—'}</td>
                      <td className="text-xs text-slate-400">{fmtTime(r.created_at as string, lang)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={en ? 'Recompute it yourself' : 'Przelicz sam'}>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
            <li>
              {en ? 'Download' : 'Pobierz'}{' '}
              <a className="text-spore underline" href={`${base}verify/verify_model.py`} download data-testid="verify-script">
                verify_model.py
              </a>{' '}
              {en ? '(Python 3.10+, numpy only).' : '(Python 3.10+, tylko numpy).'}
            </li>
            <li>
              <code className="rounded bg-ink/60 px-1 text-xs">pip install numpy && python verify_model.py --latest --remote-data</code>
            </li>
            <li>
              <code className="rounded bg-ink/60 px-1 text-xs">python verify_model.py --model fashion --version N --remote-data</code>
            </li>
          </ol>
          <p className="mt-2 text-xs text-slate-400">
            {en
              ? 'The script downloads the stored weights of that version from public Storage, the architecture and the fixed test set from this site, runs the forward pass and compares accuracy and the test-set fingerprint with the database.'
              : 'Skrypt pobiera zapisane wagi tej wersji z publicznego Storage, architekturę i stały test z tej strony, liczy przejście w przód i porównuje trafność oraz odcisk zbioru testowego z bazą.'}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {en ? 'Independent CI job (hourly):' : 'Niezależne zadanie CI (co godzinę):'} <code>.github/workflows/reverify.yml</code>
            {lastRun && (
              <>
                {' '}
                · <a className="underline" href={lastRun}>{en ? 'last run' : 'ostatni przebieg'}</a> {en ? '(repo is private – log needs access; results are in the table below)' : '(repo prywatne – log wymaga dostępu; wyniki są w tabeli poniżej)'}
              </>
            )}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {en ? 'CI guard against made-up data (runs on every change):' : 'Strażnik CI przeciw zmyślonym danym (na każdej zmianie):'}{' '}
            <a className="underline" href={`${base}verify/check-authenticity.mjs`}>
              check-authenticity.mjs
            </a>
          </p>
        </Card>
        <Card title={en ? 'Fixed test sets' : 'Stałe zbiory testowe'}>
          {!d.eval_sets?.length ? (
            <Empty h="h-24" />
          ) : (
            <table className="w-full text-sm" data-testid="verify-evalsets">
              <tbody>
                {d.eval_sets.map((r) => (
                  <tr key={r.model as string} className="border-t border-white/5">
                    <td className="py-1">{r.model as string}</td>
                    <td className="tabular-nums">n={r.n as number}</td>
                    <td className="font-mono text-xs text-slate-400" title={r.sha as string}>
                      sha256 {String(r.sha).slice(0, 16)}…
                    </td>
                    <td>
                      <a className="text-xs underline" href={`${base}data/ml/${r.model}/test.bin`} download>
                        test.bin
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-xs text-slate-400">{en ? 'Fingerprint = sha256 of the comma-joined test labels. The database rejects any candidate evaluated on a different set.' : 'Odcisk = sha256 etykiet testu połączonych przecinkami. Baza odrzuca kandydata ocenionego na innym zbiorze.'}</p>
        </Card>
      </div>

      <Card title={en ? 'What drives progress' : 'Co napędza postęp'} className="mb-4">
        <p className="mb-2 text-xs text-slate-400">{en ? 'Training samples processed per hour by session nodes (myc_results).' : 'Próbki treningowe przetworzone na godzinę przez węzły w sesjach (myc_results).'}</p>
        <TimeChart data={hourly} series={[{ key: 'samples', name: en ? 'samples/h' : 'próbki/h', color: '#5eead4' }]} />
        <p className="mt-2 text-xs text-slate-400">
          {en ? 'Chats saved for learning (opt-in):' : 'Rozmowy zapisane do nauki (za zgodą):'} {chats ? chats.reduce((a, c) => a + c.exchanges, 0) : '…'} {en ? 'exchanges' : 'wymian'} · {chats ? chats.reduce((a, c) => a + c.unknown, 0) : '…'} {en ? '“I don’t know” answers (topics to teach)' : 'odpowiedzi „nie wiem” (tematy do nauczenia)'}
        </p>
      </Card>

      <Card title={en ? 'Raw data (public, read-only)' : 'Surowe dane (publiczne, tylko odczyt)'}>
        <table className="w-full text-sm" data-testid="verify-raw">
          <tbody>
            {(Object.keys(Q) as Key[]).map((k) => (
              <tr key={k} className="border-t border-white/5">
                <td className="py-1 font-mono text-xs">{Q[k].split('?')[0]}</td>
                <td className="tabular-nums text-slate-400">{d[k] ? `${d[k]!.length} ${en ? 'rows' : 'wierszy'}` : err[k] ? <span className="text-amber">{en ? 'not available' : 'niedostępne'}</span> : '…'}</td>
                <td className="space-x-2 text-right text-xs">
                  <button disabled={!d[k]} className="underline disabled:opacity-40" onClick={() => download(k, d[k]!, 'csv')} data-testid={`dl-${k}-csv`}>
                    CSV
                  </button>
                  <button disabled={!d[k]} className="underline disabled:opacity-40" onClick={() => download(k, d[k]!, 'json')}>
                    JSON
                  </button>
                  <a className="underline" href={restUrl(k)} target="_blank" rel="noreferrer">
                    REST
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-400">{en ? 'REST links are direct, unfiltered database reads with the public key (row-level security allows only reading).' : 'Linki REST to bezpośredni, niefiltrowany odczyt z bazy kluczem publicznym (zabezpieczenia wierszy pozwalają tylko czytać).'}</p>
      </Card>
    </>
  )
}
