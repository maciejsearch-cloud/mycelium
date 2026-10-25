// Strażnik autentyczności (CI): w kodzie produkcyjnym UI nie wolno używać Math.random ani danych
// zmyślonych (mock/fake/dummy/lorem/symulacja). Wyjątki tylko z komentarzem `authentic-ok: <powód>`
// w tej samej linii (np. identyfikatory, jitter). Dane syntetyczne – wyłącznie w testach (e2e/, tests/).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/', import.meta.url).pathname
const RULES = [
  [/Math\.random\s*\(/, 'Math.random w kodzie UI'],
  [/\b(mock|fake|dummy|lorem ipsum)\w*/i, 'dane zmyślone (mock/fake/dummy/lorem)'],
  [/\b(simulated|simulate|symulowan\w*|symuluj\w*)\b/i, 'symulacja w ścieżce UI'],
  [/\bTODO\b|\bFIXME\b/, 'niedokończony kod (TODO/FIXME)'],
  // sztuczna skala „IQ” (40 + 120 × średnia) wprowadzała w błąd – pokazujemy tylko trafność w % i n (docs/data-provenance.md)
  [/\bIQ\b/, 'wymyślona skala „IQ” w UI'],
]
// teksty opisujące brak symulacji są dozwolone („bez symulacji”, „no simulations”)
const NEGATED = /(bez|nie|no|not|zero)\s+(symulacj|simulat)/i
const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f)) files.push(p)
  }
}
walk(ROOT)
const bad = []
for (const f of files) {
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes('authentic-ok:')) return
      for (const [re, why] of RULES) {
        if (!re.test(line)) continue
        if (why.startsWith('symulacja') && NEGATED.test(line)) continue
        bad.push(`${f.replace(ROOT, 'src/')}:${i + 1}: ${why}\n    ${line.trim().slice(0, 140)}`)
      }
    })
}
if (bad.length) {
  console.error(`check-authenticity: ${bad.length} naruszeń\n` + bad.join('\n'))
  process.exit(1)
}
console.log(`check-authenticity: OK (${files.length} plików)`)
