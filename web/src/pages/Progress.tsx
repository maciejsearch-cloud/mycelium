import { Card, PageHeader } from '../components/ui'
import { fmtDate } from '../data'
import type { Commit, Progress } from '../types'
import { StatusDot } from './Overview'

const STATUS = { done: 'zrobione', in_progress: 'w toku', planned: 'zaplanowane' } as const

export default function ProgressPage({ progress }: { progress?: Progress }) {
  if (!progress) return <div className="card text-slate-400">Brak danych o postępach.</div>
  const url = `https://github.com/${progress.repo}`
  return (
    <>
      <PageHeader title="Postępy projektu">
        Fazy rozwoju i historia zmian – generowane z gita przy każdym buildzie ({fmtDate(progress.generated_at)}).
      </PageHeader>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="phases">
        {progress.phases.map((p) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <StatusDot status={p.status} />
                <h2 className="text-sm font-medium text-slate-100">
                  <span className="text-slate-500">Faza {p.id}.</span> {p.title}
                </h2>
              </div>
              <span className={`chip shrink-0 ${p.status === 'done' ? 'text-spore' : p.status === 'in_progress' ? 'text-amber' : 'text-slate-500'}`}>{STATUS[p.status]}</span>
            </div>
            <ul className="mt-3 space-y-1 text-sm text-slate-400">
              {p.items.map((i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-spore/60">·</span>
                  {i}
                </li>
              ))}
            </ul>
            {p.pr && (
              <a className="mt-3 inline-block text-xs text-spore hover:underline" href={`${url}/pull/${p.pr}`}>
                PR #{p.pr} →
              </a>
            )}
          </Card>
        ))}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Scalone pull requesty">
          <Commits list={progress.merged_prs} url={url} />
        </Card>
        <Card title={`Bieżąca praca${progress.branch && progress.branch !== 'main' ? ` (${progress.branch})` : ''}`}>
          {progress.branch_commits.length ? <Commits list={progress.branch_commits} url={url} /> : <p className="text-sm text-slate-500">Brak niescalonych commitów.</p>}
        </Card>
      </div>
      <Card className="mt-4" title="Ostatnie commity na main">
        <Commits list={progress.main_commits} url={url} />
      </Card>
    </>
  )
}

function Commits({ list, url }: { list: Commit[]; url: string }) {
  return (
    <ul className="divide-y divide-white/5 text-sm">
      {list.map((c) => (
        <li key={c.sha} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
          <a href={c.pr ? `${url}/pull/${c.pr}` : `${url}/commit/${c.sha}`} className="font-mono text-xs text-spore hover:underline">
            {c.pr ? `#${c.pr}` : c.sha}
          </a>
          <span className="min-w-0 flex-1 text-slate-300">{c.subject.replace(/\s*\(#\d+\)$/, '')}</span>
          <span className="text-xs text-slate-500">{fmtDate(c.date)}</span>
        </li>
      ))}
    </ul>
  )
}
