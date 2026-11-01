// Bezpieczniki testów szkolnych (czysta grzybnia): niepewny odczyt → „nie wiem” (null), pewny → wynik.
// Sprawdza reguły, które nie potrzebują modelu rozbioru (zakupy, „suma … od różnicy”, procenty, geometria);
// zdania napisane tu od nowa – nie są zadaniami z zamrożonego zestawu testowego.
//   node scripts/szkolne-guards.mjs
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const here = new URL('.', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'szk-guards-'))
for (const f of ['czysta', 'czystaLiczby', 'czystaQ', 'czystaSzkolne', 'czystaJednostki', 'czystaZadania', 'czystaGeometria', 'czystaGramatyka', 'czystaWiedza', 'rozbior', 'morf', 'retrieval', 'store']) {
  const src = readFileSync(join(here, `../src/myc/${f}.ts`), 'utf8')
    .replace(/import\.meta\.env\.[A-Z_]+/g, 'undefined')
    .replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.mjs'")
  writeFileSync(join(dir, `${f}.mjs`), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
}
const { school } = await import(join(dir, 'czystaSzkolne.mjs'))
// bez modelu rozbioru: reguły, które go potrzebują, rzucają wyjątek i school() je pomija
const ctx = () => ({ trace: [], parse: () => { throw new Error('bez modelu rozbioru') } })
const cases = [
  // [pytanie, oczekiwana odpowiedź albo null = „nie wiem”]
  ['Ola kupiła 3 lizaki po 2 zł i 2 gumy po 1,50 zł. Ile zapłaciła?', '9 zł'],
  ['Ola miała 10 zł. Kupiła 3 lizaki po 2 zł. Ile pieniędzy jej zostało?', null],
  ['Kupiono 2 kg jabłek po 3 zł za kilogram i 3 kg gruszek po 4 zł za kilogram. Ile złotych kosztował kilogram mieszanki?', null],
  ['Oblicz sumę liczb 5 i 3.', '8'],
  ['O ile suma liczb 5 i 3 jest większa od ich różnicy?', null],
  ['Rower kosztował 1000 zł. Cenę podwyższono o 10 %. Potem cenę obniżono o 10 %. Ile wynosi różnica między ceną początkową a ceną końcową?', '10 zł'],
  ['Rower kosztował 1000 zł. Cenę podwyższono o 10 %. Potem cenę obniżono o 10 %. Ile kosztuje rower po obu zmianach?', '990 zł'],
  ['Prostokąt ma obwód 30 cm, a jeden z jego boków ma 7,5 cm. Oblicz długość drugiego boku.', '7,5 cm'],
]
let bad = 0
for (const [q, want] of cases) {
  const c = ctx()
  const r = school(q, c)
  const got = r ? r.answer : null
  if (got !== want) {
    bad++
    console.error(`szkolne-guards: „${q}”\n  oczekiwano ${JSON.stringify(want)}, jest ${JSON.stringify(got)}\n  ${c.trace.map((s) => s.text).join(' | ')}`)
  }
}
if (bad) process.exitCode = 1
else console.log(`szkolne-guards: ${cases.length} przypadków OK`)
