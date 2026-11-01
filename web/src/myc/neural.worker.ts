// Modele grzybni w Rozmowie i klasyfikatorze słów: osadzenia MiniLM (transformers.js, ONNX q8) + aktualne
// wersje modeli globalnych (wagi z Supabase Storage, TF.js na CPU). Te same cechy co przy treningu
// (scripts/export_ml_shards.py): osadzenie × skala → int8/127, trigramy znaków (FNV-1a), język, definicja z Wikisłownika.
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import * as tf from '@tensorflow/tfjs-core'
import * as tfl from '@tensorflow/tfjs-layers'
import '@tensorflow/tfjs-backend-cpu'
import type { DataMeta } from '../compute/specs'
import { pointOrtToSelf } from './ortLocal'

env.allowLocalModels = false
pointOrtToSelf(env)
const BASE = import.meta.env.BASE_URL
type M = 'intent' | 'words'
let meta: Record<string, DataMeta>
const emb = new Map<string, FeatureExtractionPipeline>()
const nets = new Map<M, { mdl: tfl.Sequential; version: number }>()
let index: { E: Int8Array; leaf: Uint8Array; n: number } | undefined
const files: Record<string, { loaded: number; total: number }> = {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init)
      if (r.ok || (r.status < 500 && r.status !== 429) || i >= 4) return r
    } catch (e) {
      if (i >= 4) throw e
    }
    await sleep(500 * 2 ** i)
  }
}

async function embedder(model: string) {
  let p = emb.get(model)
  if (!p) {
    p = (await pipeline('feature-extraction', model, {
      dtype: 'q8',
      progress_callback: (x: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (x.status === 'progress' && x.file && x.total) {
          files[`${model}/${x.file}`] = {
            loaded: x.loaded ?? 0,
            total: x.total,
          }
          const v = Object.values(files)
          postMessage({
            type: 'progress',
            loaded: v.reduce((s, f) => s + f.loaded, 0),
            total: v.reduce((s, f) => s + f.total, 0),
          })
        }
      },
    })) as FeatureExtractionPipeline
    emb.set(model, p)
  }
  return p
}
async function embed(model: string, texts: string[]): Promise<Float32Array[]> {
  const p = await embedder(model)
  const t = await p(texts, { pooling: 'mean', normalize: true })
  const d = t.data as Float32Array
  return texts.map((_, i) => d.slice(i * 384, (i + 1) * 384))
}
// jak przy treningu: clip(round(x·skala·127)) / 127
const quant = (v: Float32Array, scale: number) => Float32Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * scale * 127))) / 127)

function fnv(s: string): number {
  let h = 2166136261
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 16777619) >>> 0
  return h >>> 0
}
/** Trigramy i bigramy znaków „^słowo$” (jak word_feats w export_ml_shards.py). */
function wordGrams(w: string, dim: number): number[] {
  const s = `^${w.toLowerCase()}$`
  const g: string[] = []
  for (let i = 0; i + 3 <= [...s].length; i++) g.push([...s].slice(i, i + 3).join(''))
  for (let i = 0; i + 2 <= [...s].length; i++) g.push([...s].slice(i, i + 2).join(''))
  return g.map((x) => fnv(x) % dim).slice(0, 255)
}

function build(md: DataMeta): tfl.Sequential {
  const L = tfl.layers
  return tfl.sequential({
    layers: md.arch!.layers.map((l, i) => {
      const act = l.relu ? 'relu' : undefined
      const first = i === 0 ? { inputShape: [md.dim] } : {}
      if (l.t === 'drop') return L.dropout({ rate: l.r! })
      if (l.t === 'dense') return L.dense({ ...first, units: l.u!, activation: act })
      throw new Error(`warstwa ${l.t} niewspierana w przeglądarce czatu`)
    }),
  })
}

async function load(m: M, version: number, url: string) {
  if (!meta) meta = await (await fetchRetry(`${BASE}data/ml/meta.json`)).json()
  const md = meta[m]
  const r = await fetchRetry(url)
  if (!r.ok) throw new Error(`wagi ${m}: HTTP ${r.status}`)
  const flat = new Float32Array(await r.arrayBuffer())
  const mdl = build(md)
  let o = 0
  mdl.setWeights(mdl.getWeights().map((w) => tf.tensor(flat.subarray(o, (o += w.size)), w.shape)))
  if (o !== flat.length) throw new Error(`rozmiar wag ${flat.length} ≠ ${o}`)
  nets.set(m, { mdl, version })
  await embedder(md.emb!.model)
  if (m === 'words' && !index) {
    const u = new Uint8Array(await (await fetchRetry(`${BASE}data/ml/words_index.bin`)).arrayBuffer())
    const n = u.length / 385
    const E = new Int8Array(n * 384)
    const leaf = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      E.set(new Int8Array(u.buffer, i * 385, 384), i * 384)
      leaf[i] = u[i * 385 + 384]
    }
    index = { E, leaf, n }
  }
  return { version }
}

function predict(m: M, x: Float32Array[]): Float32Array[] {
  const { mdl } = nets.get(m)!
  const p = tf.tidy(() =>
    tf.softmax(
      mdl.apply(tf.tensor2d(x.map((v) => Array.from(v))), {
        training: false,
      }) as tf.Tensor,
    ),
  )
  const d = p.dataSync() as Float32Array
  p.dispose()
  const k = d.length / x.length
  return x.map((_, i) => d.slice(i * k, (i + 1) * k))
}

async function intent(texts: string[]) {
  const md = meta.intent
  const e = await embed(md.emb!.model, texts)
  return {
    probs: predict(
      'intent',
      e.map((v) => quant(v, md.emb!.scale)),
    ),
    embs: e,
  }
}

/** Słowo: korzeń z modelu globalnego (średnia po językach, gdy nieznany) + sąsiedzi w słowniku (kNN po osadzeniu). */
async function word(w: string, lang: 'en' | 'pl' | '', gloss: string) {
  const md = meta.words
  const T = md.emb!.trigrams ?? 512
  const hasGloss = !!md.emb!.gloss
  const [ew, eg] = await embed(md.emb!.model, hasGloss && gloss ? [w, gloss] : [w])
  const parts = (l: 'en' | 'pl') => {
    const x = new Float32Array(md.dim)
    x.set(quant(ew, md.emb!.scale), 0)
    let o = 384
    if (hasGloss) {
      if (eg) x.set(quant(eg, md.emb!.scale), o)
      o += 384
    }
    for (const j of wordGrams(w, T)) x[o + j] = 1
    x[o + T + (l === 'pl' ? 1 : 0)] = 1
    return x
  }
  const ls: ('en' | 'pl')[] = lang ? [lang] : ['en', 'pl']
  const ps = predict('words', ls.map(parts))
  const probs = ps[0].map((_, c) => ps.reduce((s, p) => s + p[c], 0) / ps.length)
  // kNN: kosinus z osadzeniami słów słownika (te same int8)
  const q = quant(ew, md.emb!.scale)
  const nn: [number, number][] = []
  if (index) {
    for (let i = 0; i < index.n; i++) {
      let s = 0
      for (let j = 0; j < 384; j++) s += q[j] * index.E[i * 384 + j]
      nn.push([i, s])
    }
    nn.sort((a, b) => b[1] - a[1])
  }
  const top = nn.slice(0, 15)
  const qn = Math.sqrt(q.reduce((s, v) => s + v * v, 0)) || 1
  const en = (i: number) => Math.sqrt(index!.E.subarray(i * 384, i * 384 + 384).reduce((a, v) => a + v * v, 0)) || 1
  return {
    probs,
    neighbours: top.map(([i, s]) => ({
      i,
      leaf: index!.leaf[i],
      sim: s / qn / en(i),
    })),
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { rid, op, ...a } = e.data
  try {
    let out: unknown
    if (op === 'load') out = await load(a.model, a.version, a.url)
    else if (op === 'embed') out = await embed(a.model, a.texts)
    else if (op === 'intent') out = await intent(a.texts)
    else if (op === 'word') out = await word(a.word, a.lang, a.gloss ?? '')
    postMessage({ rid, ok: true, out })
  } catch (err) {
    postMessage({
      rid,
      ok: false,
      error: (err as Error).message ?? String(err),
    })
  }
}
