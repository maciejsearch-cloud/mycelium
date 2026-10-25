// Osadzenia zdań/słów (transformers.js, te same skwantowane modele ONNX co w przeglądarce) dla CLINC150 i słowników.
// Wynik: ~/.cache/iot-mycelium/emb/{intent_train,intent_test,words}.f32 (float32, 384 na wiersz, kolejność jak w źródłach).
// Potem: python scripts/export_ml_shards.py (czyta te pliki i zapisuje odłamki dense-i8).
import { pipeline, env } from '@huggingface/transformers'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

if (process.env.HF_LOCAL) {
  env.localModelPath = process.env.HF_LOCAL
  env.allowRemoteModels = false
}
const DS = `${homedir()}/.cache/iot-mycelium/datasets`
const OUT = `${homedir()}/.cache/iot-mycelium/emb`
mkdirSync(OUT, { recursive: true })
const MODELS = { intent: 'Xenova/all-MiniLM-L6-v2', words: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' }

async function embed(model, texts, file) {
  const ex = await pipeline('feature-extraction', model, { dtype: 'q8' })
  const out = new Float32Array(texts.length * 384)
  for (let i = 0; i < texts.length; i += 64) {
    const t = await ex(texts.slice(i, i + 64), { pooling: 'mean', normalize: true })
    out.set(t.data, i * 384)
  }
  writeFileSync(`${OUT}/${file}.f32`, Buffer.from(out.buffer))
  console.log(file, texts.length)
}

const lex = JSON.parse(readFileSync('public/data/lexicon.json', 'utf8'))
const lw = lex.words.filter((w) => w[2].length)
// Definicje z Wikisłownika (scripts/fetch_glosses.py); brak definicji → wektor zerowy
async function glosses() {
  const g = JSON.parse(readFileSync(`${homedir()}/.cache/iot-mycelium/gloss.json`, 'utf8'))
  const txt = lw.map((w) => g[`${w[1]}:${w[0]}`] || '')
  const has = txt.map((t, i) => (t ? i : -1)).filter((i) => i >= 0)
  const ex = await pipeline('feature-extraction', MODELS.words, { dtype: 'q8' })
  const out = new Float32Array(lw.length * 384)
  for (let i = 0; i < has.length; i += 64) {
    const ids = has.slice(i, i + 64)
    const t = await ex(ids.map((k) => txt[k]), { pooling: 'mean', normalize: true })
    ids.forEach((k, j) => out.set(t.data.subarray(j * 384, (j + 1) * 384), k * 384))
  }
  writeFileSync(`${OUT}/words_gloss.f32`, Buffer.from(out.buffer))
  console.log('words_gloss', has.length, '/', lw.length)
}
if (process.env.ONLY === 'gloss') {
  await glosses()
  process.exit(0)
}
const d = JSON.parse(readFileSync(`${DS}/data_small.json`, 'utf8'))
await embed(MODELS.intent, [...d.train, ...d.val].map((r) => r[0]), 'intent_train')
await embed(MODELS.intent, d.test.map((r) => r[0]), 'intent_test')
await embed(MODELS.words, lw.map((w) => w[0]), 'words')
await glosses()
