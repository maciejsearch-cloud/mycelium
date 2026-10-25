// Generowane przy buildzie: fazy projektu + historia commitów / scalonych PR-ów z gita.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const roadmap = JSON.parse(readFileSync(resolve(here, 'roadmap.json'), 'utf8'))
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: resolve(here, '../..'), encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const parse = (out) =>
  out
    ? out.split('\n').map((l) => {
        const [sha, date, author, ...s] = l.split('\x1f')
        const subject = s.join(' ')
        const pr = subject.match(/\(#(\d+)\)\s*$/)
        return { sha, date, author, subject, pr: pr ? Number(pr[1]) : null }
      })
    : []
const fmt = '--format=%h%x1f%aI%x1f%an%x1f%s'
const mainRef = git('rev-parse', '--verify', '-q', 'main') ? 'main' : 'origin/main'
const main = parse(git('log', fmt, '-40', mainRef))
const head = git('rev-parse', '--abbrev-ref', 'HEAD')
const branch = head && head !== 'main' && head !== 'HEAD' ? parse(git('log', fmt, '-30', `${mainRef}..${head}`)) : []
const out = {
  generated_at: new Date().toISOString(),
  repo: 'maciejsearch-cloud/mycelium',
  phases: roadmap.phases,
  stages: roadmap.stages ?? [],
  merged_prs: main.filter((c) => c.pr),
  main_commits: main.slice(0, 25),
  branch: head,
  branch_commits: branch,
}
const target = resolve(here, '../public/data/progress.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(out))
console.log(`progress.json: ${out.merged_prs.length} PR, ${branch.length} commitów na ${head}`)
