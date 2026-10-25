// Zgodność warstwy Morfeusza: TypeScript (src/myc/morf.ts) ↔ Python (rozbior/morf.py select) na tych samych
// log-prawdopodobieństwach modelu i leksykonie przeglądarki. Odciski: public/data/rozbior/morf-parity.json
// (scripts/export_morf.py). Uruchom: node scripts/morf-parity.mjs
import ts from 'typescript'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const here = new URL('.', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'morf-'))
for (const n of ['rozbior', 'morf']) {
  const src = readFileSync(join(here, `../src/myc/${n}.ts`), 'utf8').replace("from './rozbior'", "from './rozbior.mjs'")
  writeFileSync(
    join(dir, `${n}.mjs`),
    ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )
}
const { select } = await import(join(dir, 'morf.mjs'))
const lex = JSON.parse(gunzipSync(readFileSync(join(here, '../public/data/rozbior/morf.json.gz'))).toString())
const fx = JSON.parse(readFileSync(join(here, '../public/data/rozbior/morf-parity.json'), 'utf8'))
const canon = (x) => {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']'
  if (x && typeof x === 'object')
    return (
      '{' +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(x[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(x === undefined ? null : x)
}
let n = 0
const bad = []
fx.sents.forEach((s, si) => {
  const got = select(fx.head, s.toks, lex, 'pdb')
  got.forEach((t, i) => {
    n++
    const g = canon({
      lemma: t.lemma ?? null,
      upos: t.upos,
      feats: t.feats ?? {},
    })
    const w = canon({
      lemma: s.want[i].lemma ?? null,
      upos: s.want[i].upos,
      feats: s.want[i].feats ?? {},
    })
    if (g !== w) bad.push(`${si}:${i} ${t.form}: TS ${g} ≠ Py ${w}`)
  })
})
if (bad.length) {
  console.error(`morf: ${bad.length}/${n} słów różni się między TS a Pythonem\n` + bad.slice(0, 5).join('\n'))
  process.exit(1)
}
console.log(`morf: TS = Python na ${n} słowach (${fx.sents.length} zdań)`)
