// Pomiar czystej grzybni poza przeglądarką: ten sam kod TS (myc/czysta.ts, myc/czystaWiedza.ts, rozbior.ts, morf.ts)
// i ten sam model rozbioru co strona. Wejście: JSON {model, items:[{id,q}], kb?} ; wyjście: JSON z odpowiedziami i śladem.
//   node scripts/czysta-eval.mjs in.json out.json
import ts from 'typescript'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const here = new URL('.', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'czysta-'))
// transpilacja plików TS (jak rozbior-parity.mjs); import.meta.env → wartości domyślne z kodu
for (const f of ['czysta', 'czystaLiczby', 'czystaQ', 'czystaSzkolne', 'czystaJednostki', 'czystaZadania', 'czystaGeometria', 'czystaWiedza', 'rozbior', 'morf', 'retrieval', 'store']) {
  const src = readFileSync(join(here, `../src/myc/${f}.ts`), 'utf8')
    .replace(/import\.meta\.env\.[A-Z_]+/g, 'undefined')
    .replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.mjs'")
  writeFileSync(join(dir, `${f}.mjs`), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
}
const imp = async (f) => import(join(dir, `${f}.mjs`))
const m = { ...(await imp('czysta')), ...(await imp('czystaWiedza')), ...(await imp('rozbior')), choose: (await imp('morf')).choose }

const [inp, outp] = process.argv.slice(2)
const job = JSON.parse(readFileSync(inp, 'utf8'))
const buf = readFileSync(job.model)
const M = m.loadModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const pub = join(here, '../public/data/rozbior')
const lex = JSON.parse(gunzipSync(readFileSync(join(pub, 'morf.json.gz'))).toString())
const wal = JSON.parse(gunzipSync(readFileSync(join(pub, 'walenty.json.gz'))).toString())
const cache = new Map()
const parseFn = (text) => {
  const k = text.trim()
  if (cache.has(k)) return cache.get(k)
  const { forms } = m.tokenize(k, M.wv)
  if (!forms.length) return undefined
  const fs = forms.slice(0, 60)
  const raw = m.predict(M, fs, 'pdb', true)
  const toks = m.choose(M, fs, raw, lex, 'pdb', wal.verbs).map(({ lp: _lp, ...t }) => t)
  const r = { a: m.analyse(toks), conf: toks.reduce((s, t) => s + (t.p ?? 0), 0) / toks.length }
  cache.set(k, r)
  return r
}
if (process.env.CZYSTA_PARSE) {
  for (const it of job.items) for (const t of parseFn(it.q)?.a.tokens ?? []) console.error(t.i, t.form, t.lemma, t.upos, t.head, t.part ?? '', JSON.stringify(t.feats ?? {}))
  process.exit(0)
}
const kb = job.kb ?? { facts: [], qa: [], loadedAt: '', skipped: 0 }
const t0 = Date.now()
const res = job.items.map((it) => {
  const a = m.answerPure(it.q, parseFn, kb, lex)
  return { id: it.id, answer: a.answer, source: a.source, method: a.method ?? null, conf: a.conf, trace: a.trace.map((s) => `${s.kind}: ${s.text}`), missing: a.missing }
})
writeFileSync(outp, JSON.stringify({ n: res.length, ms: Date.now() - t0, results: res }))
console.log(`czysta: ${res.length} odpowiedzi w ${((Date.now() - t0) / 1000).toFixed(1)} s`)
