// Zgodność reguł rozbioru: TypeScript (src/myc/rozbior.ts) ↔ Python (src/iot_mycelium/rozbior/analiza.py).
// Odciski Pythona: web/public/data/rozbior/parity.json (scripts/rozbior_parity_fixture.py). Uruchom: node scripts/rozbior-parity.mjs
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const here = new URL('.', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'rb-'))
const out = join(dir, 'rozbior.mjs')
const src = readFileSync(join(here, '../src/myc/rozbior.ts'), 'utf8')
writeFileSync(out, ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
const rb = await import(out)
const fx = JSON.parse(readFileSync(join(here, '../public/data/rozbior/parity.json'), 'utf8'))
const canon = (x) => {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']'
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}'
  return JSON.stringify(x === undefined ? null : x)
}
const got = []
for (const name of ['test-pdb.json.gz', 'test-lfg.json.gz']) {
  const ss = JSON.parse(gunzipSync(readFileSync(join(here, '../public/data/rozbior', name))).toString()).sents.slice(0, fx.n / 2)
  for (const s of ss) got.push(createHash('sha256').update(canon(rb.analyse(s.toks))).digest('hex').slice(0, 16))
}
const bad = got.map((h, i) => (h === fx.sha[i] ? -1 : i)).filter((i) => i >= 0)
if (bad.length) {
  console.error(`rozbiór: ${bad.length}/${got.length} zdań różni się między TS a Pythonem (pierwsze: ${bad.slice(0, 5).join(', ')})`)
  process.exit(1)
}
console.log(`rozbiór: TS = Python na ${got.length} zdaniach`)
