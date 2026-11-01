// Środowisko rozmówcy w Node: model rozbioru LFG (GPL-3.0, plik statyczny w serwisie), Morfeusz 2 / SGJP (BSD-2),
// Walenty, leksykon emocji Słowosieci (CC BY 4.0) i moduły web/src/myc/rozmowa. Wspólne dla pomiarów i procesu rozmówcy.
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { loadTs } from './tsload.mjs'

const W = new URL('../../', import.meta.url).pathname
export async function rozmowaEnv() {
  const m = await loadTs(['myc/rozbior.ts', 'myc/morf.ts', 'myc/rozmowa/lexicon.ts', 'myc/rozmowa/types.ts', 'myc/rozmowa/understand.ts', 'myc/rozmowa/jokes.ts', 'myc/rozmowa/relations.ts', 'myc/rozmowa/respond.ts', 'myc/rozmowa/moderation.ts', 'myc/rozmowa/formlex.ts'])
  const rb = m.rozbior
  const gz = (p) => JSON.parse(gunzipSync(readFileSync(W + p)).toString())
  const morf = gz('public/data/rozbior/morf-lfg.json.gz')
  const wal = gz('public/data/rozbior/walenty.json.gz')
  const emo = gz('public/data/rozmowa/emo.json.gz')
  const mdir = W + 'public/data/rozbior/models/'
  const buf = readFileSync(mdir + readdirSync(mdir).find((x) => x.startsWith('rb-lfg-')))
  const M = rb.loadModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const forms = m.formlex.formLex(morf, m.morf.lexAnalyses)
  const lex = { emo, forms }
  const tokenize = (t) => rb.tokenize(t, M.wv).forms
  const parse = (fs) => m.morf.choose(M, fs, rb.predict(M, fs, 'lfg', true), morf, 'lfg', wal.verbs)
  const rawParse = (text) => {
    const fs = tokenize(text)
    return fs.length ? m.morf.choose(M, fs, rb.predict(M, fs, 'lfg', true), morf, 'lfg', wal.verbs) : []
  }
  return {
    mods: m, lex, tokenize, parse, rawParse,
    understand: (text, opts = {}) => m.understand.understand(text, tokenize, parse, lex, opts),
    model: { file: readdirSync(mdir).find((x) => x.startsWith('rb-lfg-')), licence: 'GPL-3.0 (UD Polish-LFG)' },
  }
}
