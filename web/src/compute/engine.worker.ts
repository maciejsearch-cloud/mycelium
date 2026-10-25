// Silnik obliczeń „Start sesji” (Web Worker): TF.js na WebGPU → WebGL → WASM (SIMD/wątki) → CPU.
// Prawdziwe zadania: trening lokalny (FedAvg/FedProx), ewaluacja, próby hiperparametrów, etykietowanie,
// weryfikacja cudzych aktualizacji i agregacja z odrzucaniem złych/zatrutych aktualizacji.
import * as tf from '@tensorflow/tfjs-core'
import * as tfl from '@tensorflow/tfjs-layers'
import '@tensorflow/tfjs-backend-cpu'
import '@tensorflow/tfjs-backend-webgl'
import '@tensorflow/tfjs-backend-webgpu'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url'
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url'
import wasmThreads from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url'
import { b64, decodeDelta, encodeDelta, unb64 } from './codec'
import type { Backend, BackendInfo, DataMeta, JobMsg, JobOut, ModelId } from './specs'
import { registerWasmConvGrad } from './wasmConvGrad'

const BASE = import.meta.env.BASE_URL
// dane trzymane w pamięci JS; na GPU wysyłamy tylko bieżącą partię (małe bufory – działa też na słabych GPU)
type DS = { X: Float32Array; y: Int32Array; n: number; dim: number; shape: number[] }
let meta: Record<ModelId, DataMeta>
let info: BackendInfo
let duty = 0.85
let paused = false
const cache = new Map<string, DS>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function gate(busyMs: number) {
  while (paused) await sleep(250)
  // cykl pracy przyjazny temperaturze: przerwa proporcjonalna do pracy
  if (duty < 1) await sleep((busyMs * (1 - duty)) / duty)
}

async function initBackend(prefer: Backend[]): Promise<BackendInfo> {
  setWasmPaths({ 'tfjs-backend-wasm.wasm': wasmPlain, 'tfjs-backend-wasm-simd.wasm': wasmSimd, 'tfjs-backend-wasm-threaded-simd.wasm': wasmThreads })
  registerWasmConvGrad()
  let err = ''
  for (const b of prefer) {
    try {
      if (b === 'webgpu' && !(navigator as unknown as { gpu?: unknown }).gpu) throw new Error('brak navigator.gpu')
      if (b === 'wasm') await import('@tensorflow/tfjs-backend-wasm')
      if (!(await tf.setBackend(b))) throw new Error('setBackend=false')
      await tf.ready()
      // test dymny: mały splot z gradientem musi dać skończony wynik
      const gt = tf.tidy(() => tf.grad((w: tf.Tensor) => tf.sum(tf.conv2d(tf.ones([1, 6, 6, 1]) as tf.Tensor4D, w as tf.Tensor4D, 1, 'valid')))(tf.ones([3, 3, 1, 2])))
      const ok = Number.isFinite((await gt.data())[0])
      gt.dispose()
      if (!ok) throw new Error('test dymny')
      let device: string = b
      if (b === 'webgpu') {
        const ad = await (navigator as unknown as { gpu: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu.requestAdapter()
        device = [ad?.info?.vendor, ad?.info?.architecture, ad?.info?.description].filter(Boolean).join(' ') || 'WebGPU'
      } else if (b === 'webgl') {
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2') as WebGL2RenderingContext | null
        const ext = gl?.getExtension('WEBGL_debug_renderer_info')
        device = (ext && gl ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : '') || 'WebGL'
      } else device = `CPU × ${navigator.hardwareConcurrency ?? '?'}`
      const r: BackendInfo = { backend: b, device }
      if (b === 'wasm') {
        r.simd = !!(await tf.env().getAsync('WASM_HAS_SIMD_SUPPORT'))
        r.threads = !!(await tf.env().getAsync('WASM_HAS_MULTITHREAD_SUPPORT'))
      }
      return r
    } catch (e) {
      err += `${b}: ${(e as Error).message}; `
    }
  }
  throw new Error(err)
}

async function bin(path: string): Promise<Uint8Array> {
  const r = await fetch(`${BASE}data/ml/${path}`)
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

function parse(m: ModelId, u: Uint8Array): DS {
  const md = meta[m]
  if (md.format === 'sparse') {
    const rows: [number, number[]][] = []
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength)
    for (let o = 0; o < u.byteLength; ) {
      const y = dv.getUint16(o, true)
      const n = dv.getUint16(o + 2, true)
      const idx: number[] = []
      for (let i = 0; i < n; i++) idx.push(dv.getUint16(o + 4 + i * 2, true))
      rows.push([y, idx])
      o += 4 + n * 2
    }
    const X = new Float32Array(rows.length * md.dim)
    rows.forEach(([, idx], r) => idx.forEach((j) => (X[r * md.dim + j] = 1)))
    return { X, y: Int32Array.from(rows, (r) => r[0]), n: rows.length, dim: md.dim, shape: [md.dim] }
  }
  const rec = md.dim + 1
  const n = Math.floor(u.length / rec)
  const X = new Float32Array(n * md.dim)
  const y = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < md.dim; j++) {
      const v = u[i * rec + j]
      X[i * md.dim + j] = md.format === 'dense-u8' ? v / 255 : ((v << 24) >> 24) / 127
    }
    y[i] = u[i * rec + md.dim]
  }
  return { X, y, n, dim: md.dim, shape: md.shape ?? [md.dim] }
}

async function data(m: ModelId, part: string): Promise<DS> {
  const k = `${m}/${part}`
  let d = cache.get(k)
  if (!d) {
    d = parse(m, await bin(`${m}/${part}.bin`))
    // pamięć: trzymamy walidację/test i ostatnie 6 odłamków
    const shards = [...cache.keys()].filter((c) => c.includes('/train-'))
    if (shards.length >= 6) cache.delete(shards[0])
    cache.set(k, d)
  }
  return d
}

type LayerSpec = NonNullable<DataMeta['arch']>['layers'][number]
/** Architektura z meta.json (ta sama co w scripts/seed_train.py); bez „arch” – pierwotne modele v1. */
function buildArch(md: DataMeta): tfl.Sequential {
  const L = tfl.layers
  const first = (o: Record<string, unknown>, i: number) => (i === 0 ? { ...o, inputShape: md.shape ?? [md.dim] } : o)
  return tfl.sequential({
    layers: md.arch!.layers.map((l: LayerSpec, i: number) => {
      const act = l.relu ? 'relu' : undefined
      if (l.t === 'conv') return L.conv2d(first({ filters: l.f!, kernelSize: 3, padding: l.same ? 'same' : 'valid', activation: act }, i) as never)
      if (l.t === 'pool') return L.maxPooling2d({ poolSize: 2 })
      if (l.t === 'flatten') return L.flatten()
      if (l.t === 'drop') return L.dropout({ rate: l.r! })
      if (l.t === 'bn') return L.batchNormalization({ epsilon: 1e-3, momentum: 0.99 })
      return L.dense(first({ units: l.u!, activation: act }, i) as never)
    }),
  })
}

function build(m: ModelId): tfl.Sequential {
  const md = meta[m]
  const L = tfl.layers
  if (md.arch) return buildArch(md)
  if (m === 'fashion')
    return tfl.sequential({
      layers: [
        L.conv2d({ inputShape: [28, 28, 1], filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }),
        L.maxPooling2d({ poolSize: 2 }),
        L.conv2d({ filters: 32, kernelSize: 3, activation: 'relu' }),
        L.maxPooling2d({ poolSize: 2 }),
        L.flatten(),
        L.dropout({ rate: 0.25 }),
        L.dense({ units: 64, activation: 'relu' }),
        L.dense({ units: md.classes }),
      ],
    })
  const hidden = m === 'har' ? [128, 64] : m === 'intent' ? [128] : [96]
  return tfl.sequential({
    layers: [
      L.dense({ inputShape: [md.dim], units: hidden[0], activation: 'relu' }),
      L.dropout({ rate: 0.2 }),
      ...hidden.slice(1).map((u) => L.dense({ units: u, activation: 'relu' })),
      L.dense({ units: md.classes }),
    ],
  })
}

/** FLOP-y przejścia w przód na próbkę (splot: H·W·Cout·K²·Cin·2, gęsta: in·out·2). */
function fwdFlops(model: tfl.Sequential): number {
  let f = 0
  for (const l of model.layers) {
    const c = l.getClassName()
    if (c === 'Conv2D') {
      const o = l.outputShape as number[]
      const k = (l.getWeights()[0].shape as number[])
      f += o[1] * o[2] * o[3] * k[0] * k[1] * k[2] * 2
    } else if (c === 'Dense') {
      const k = l.getWeights()[0].shape as number[]
      f += k[0] * k[1] * 2
    }
  }
  return f
}

const rows = (d: DS, from: number, count: number) => tf.tensor(d.X.subarray(from * d.dim, (from + count) * d.dim), [count, ...d.shape])
function gatherRows(d: DS, idx: Int32Array): tf.Tensor {
  const out = new Float32Array(idx.length * d.dim)
  idx.forEach((r, i) => out.set(d.X.subarray(r * d.dim, (r + 1) * d.dim), i * d.dim))
  return tf.tensor(out, [idx.length, ...d.shape])
}
/** Permutacja z ziarnem (mulberry32 + Fisher-Yates) – kolejność próbek odtwarzalna dla zadania. */
function perm(n: number, seed: number): Int32Array {
  let h = seed | 0
  const rnd = () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const p = Int32Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  return p
}

const models = new Map<ModelId, tfl.Sequential>()
function model(m: ModelId) {
  let x = models.get(m)
  if (!x) models.set(m, (x = build(m)))
  return x
}
const sizes = (mdl: tfl.Sequential) => mdl.getWeights().map((w) => w.size)
async function getFlat(mdl: tfl.Sequential): Promise<Float32Array> {
  const ws = mdl.getWeights()
  const out = new Float32Array(ws.reduce((s, w) => s + w.size, 0))
  let o = 0
  for (const w of ws) {
    out.set((await w.data()) as Float32Array, o)
    o += w.size
  }
  return out
}
function setFlat(mdl: tfl.Sequential, flat: Float32Array) {
  let o = 0
  const ts = mdl.getWeights().map((w) => {
    const t = tf.tensor(flat.subarray(o, o + w.size), w.shape)
    o += w.size
    return t
  })
  if (o !== flat.length) throw new Error(`zły rozmiar wag: ${flat.length} ≠ ${o}`)
  mdl.setWeights(ts)
  ts.forEach((t) => t.dispose())
}

async function accuracy(mdl: tfl.Sequential, d: DS): Promise<number> {
  let hit = 0
  for (let i = 0; i < d.n; i += 128) {
    const s = Math.min(128, d.n - i)
    const p = tf.tidy(() => tf.argMax(mdl.apply(rows(d, i, s), { training: false }) as tf.Tensor, -1))
    const a = await p.data()
    p.dispose()
    for (let k = 0; k < s; k++) if (a[k] === d.y[i + k]) hit++
  }
  return hit / d.n
}

/** Augmentacja obrazów (jak w seed_train.py): przesunięcie ±2 px i odbicie poziome, deterministycznie z ziarna partii. */
function augment(x: tf.Tensor4D, seed: number): tf.Tensor4D {
  const h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  const dx = h % 5
  const dy = (h >>> 3) % 5
  const flip = (h >>> 6) & 1
  let y = tf.slice(tf.pad(x, [[0, 0], [2, 2], [2, 2], [0, 0]]), [0, dy, dx, 0], [-1, 28, 28, -1]) as tf.Tensor4D
  if (flip) y = tf.reverse(y, 2)
  return y
}

async function train(m: ModelId, base: Float32Array, d: DS, p: { lr: number; epochs: number; batch: number; mu: number; seed: number }) {
  const mdl = model(m)
  const aug = !!meta[m].augment
  setFlat(mdl, base)
  const w0 = mdl.trainableWeights.map((w) => tf.keep(w.read().clone()))
  const opt = tf.train.adam(p.lr)
  const k = meta[m].classes
  let busy = 0
  let samples = 0
  let loss = 0
  for (let ep = 0; ep < p.epochs; ep++) {
    // kolejność próbek: permutacja z ziarnem zadania (odtwarzalna)
    const order = perm(d.n, p.seed * 31 + ep)
    for (let i = 0; i < d.n; i += p.batch * 4) {
      const t0 = performance.now()
      for (let j = i; j < Math.min(d.n, i + p.batch * 4); j += p.batch) {
        const s = Math.min(p.batch, d.n - j)
        const idx = order.subarray(j, j + s)
        const l = tf.tidy(() => {
          const xb = aug ? augment(gatherRows(d, idx) as tf.Tensor4D, p.seed * 7919 + j) : gatherRows(d, idx)
          const yb = tf.oneHot(tf.tensor1d(Int32Array.from(idx, (r) => d.y[r]), 'int32'), k)
          return opt.minimize(() => {
            let lo = tf.losses.softmaxCrossEntropy(yb, mdl.apply(xb, { training: true }) as tf.Tensor) as tf.Scalar
            if (p.mu > 0) {
              // FedProx: kara μ/2·‖w − w_global‖²
              const prox = tf.addN(mdl.trainableWeights.map((w, q) => tf.sum(tf.square(tf.sub(w.read(), w0[q])))))
              lo = tf.add(lo, tf.mul(p.mu / 2, prox))
            }
            return lo
          }, true)!
        })
        loss = (await l.data())[0]
        l.dispose()
        samples += s
      }
      const dt = performance.now() - t0
      busy += dt
      await gate(dt)
    }
  }
  opt.dispose()
  w0.forEach((t) => t.dispose())
  const after = await getFlat(mdl)
  const delta = after.map((v, i) => v - base[i])
  return { delta, after, busy, samples, loss }
}

/** Wagi z Supabase Storage: ponowienia z wykładniczym odstępem (sieć, 429, 5xx); 4xx = błąd stały. */
async function weights(url: string): Promise<Float32Array> {
  let last = ''
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return new Float32Array(await r.arrayBuffer())
      last = `HTTP ${r.status}`
      if (r.status !== 429 && r.status < 500) break
    } catch (e) {
      last = (e as Error).message
    }
    await sleep(500 * 2 ** i)
  }
  throw new Error(`wagi: ${last}`)
}

/** Odcisk stałego zbioru testowego (sha256 z etykiet „y0,y1,…”) – baza porównuje go przy publikacji. */
async function evalSet(m: ModelId): Promise<{ evalN: number; evalSha: string }> {
  const t = await data(m, 'test')
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(Array.from(t.y).join(','))))
  return { evalN: t.n, evalSha: Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('') }
}

async function runJob(j: JobMsg & { baseUrl?: string; deltaB64?: string }): Promise<JobOut> {
  const t0 = performance.now()
  const m = j.model
  const mdl = model(m)
  const F = fwdFlops(mdl)
  const P = j.params as Record<string, number>
  const base = j.baseUrl ? await weights(j.baseUrl) : await getFlat(mdl)
  if (j.kind === 'train' || j.kind === 'hparam') {
    const shard = `train-${String(P.shard).padStart(2, '0')}`
    const d = await data(m, shard)
    const r = await train(m, base, d, { lr: P.lr, epochs: P.epochs, batch: P.batch ?? 32, mu: P.mu ?? 0, seed: j.id })
    const val = await data(m, 'val')
    const accFull = await accuracy(mdl, val)
    const enc = encodeDelta(r.delta, sizes(mdl), P.frac ?? 0.25)
    // deklarowana trafność dotyczy dokładnie tego, co wysyłamy (po kompresji) – agregator sprawdzi to samo
    const dq = decodeDelta(enc)
    setFlat(mdl, base.map((v, i) => v + dq[i]))
    const acc = await accuracy(mdl, val)
    let nrm = 0
    for (const v of r.delta) nrm += v * v
    return { payload: b64(enc), metrics: { val_acc: +acc.toFixed(4), val_acc_full: +accFull.toFixed(4), loss: +r.loss.toFixed(4), norm: +Math.sqrt(nrm).toFixed(4), n: d.n, lr: P.lr, epochs: P.epochs, sps: Math.round(r.samples / (r.busy / 1000)), backend: info.backend }, samples: r.samples, flops: r.samples * F * 3, ms: Math.round(performance.now() - t0), busy: r.busy }
  }
  if (j.kind === 'reeval') {
    // niezależna ocena kandydata na stałym teście (baza porówna z deklaracją agregatora)
    const d = await data(m, 'test')
    setFlat(mdl, base)
    const s = performance.now()
    const acc = await accuracy(mdl, d)
    const busy = performance.now() - s
    const es = await evalSet(m)
    return { metrics: { acc: +acc.toFixed(6), n: es.evalN, eval_sha: es.evalSha, candidate: P.candidate }, samples: d.n, flops: d.n * F, ms: Math.round(performance.now() - t0), busy }
  }
  if (j.kind === 'eval' || j.kind === 'verify') {
    const d = await data(m, j.kind === 'eval' ? 'test' : 'val')
    const w = j.kind === 'verify' && j.deltaB64 ? (() => { const dl = decodeDelta(unb64(j.deltaB64!)); return base.map((v, i) => v + dl[i]) })() : base
    setFlat(mdl, w)
    const s = performance.now()
    const acc = await accuracy(mdl, d)
    const busy = performance.now() - s
    return { metrics: { acc: +acc.toFixed(4), n: d.n, ...(j.kind === 'verify' ? { result: P.result } : { split: 'test' }) }, samples: d.n, flops: d.n * F, ms: Math.round(performance.now() - t0), busy }
  }
  if (j.kind === 'label') {
    // etykietowanie nieocenionych obrazków z puli zadań captcha (klasa + pewność dla każdego)
    setFlat(mdl, base)
    const cap = (await (await fetch(`${BASE}data/captcha.json`)).json()) as { fashion: { pool: { id: string; px: string }[] } }
    const pool = cap.fashion.pool
    const X = new Float32Array(pool.length * 784)
    pool.forEach((q, i) => unb64(q.px).forEach((v, k) => (X[i * 784 + k] = v / 255)))
    const s = performance.now()
    const pa = new Float32Array(pool.length * 10)
    for (let i = 0; i < pool.length; i += 120) {
      const c = Math.min(120, pool.length - i)
      const pr = tf.tidy(() => tf.softmax(mdl.apply(tf.tensor4d(X.subarray(i * 784, (i + c) * 784), [c, 28, 28, 1]), { training: false }) as tf.Tensor))
      pa.set((await pr.data()) as Float32Array, i * 10)
      pr.dispose()
    }
    const out = new Uint8Array(pool.length * 2)
    let conf = 0
    for (let i = 0; i < pool.length; i++) {
      let best = 0
      for (let c = 1; c < 10; c++) if (pa[i * 10 + c] > pa[i * 10 + best]) best = c
      out[i * 2] = best
      out[i * 2 + 1] = Math.round(pa[i * 10 + best] * 255)
      conf += pa[i * 10 + best]
    }
    const busy = performance.now() - s
    return { payload: b64(out), metrics: { n: pool.length, mean_conf: +(conf / pool.length).toFixed(4) }, samples: pool.length, flops: pool.length * F, ms: Math.round(performance.now() - t0), busy }
  }
  throw new Error(`nieznany rodzaj zadania ${j.kind}`)
}

interface Upd {
  id: number
  kind: string
  payload: string
  n: number
  claimed: number
  verified: number[]
}
/** Agregacja: przycinanie normy, test kosinusowy, ponowny test na walidacji, weryfikacja krzyżowa, FedAvg. */
async function aggregate(m: ModelId, baseUrl: string, ups: Upd[]) {
  const t0 = performance.now()
  const mdl = model(m)
  const base = await weights(baseUrl)
  const val = await data(m, 'val')
  const test = await data(m, 'test')
  setFlat(mdl, base)
  const baseVal = await accuracy(mdl, val)
  const ds = ups.map((u) => decodeDelta(unb64(u.payload)))
  const norms = ds.map((d) => Math.sqrt(d.reduce((s, v) => s + v * v, 0)))
  const medN = [...norms].sort((a, b) => a - b)[Math.floor(norms.length / 2)]
  const clip = 2 * medN
  // mediana po współrzędnych jako odporny kierunek odniesienia
  const N = base.length
  const med = new Float32Array(N)
  const col = new Float32Array(ds.length)
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < ds.length; k++) col[k] = ds[k][i]
    col.sort()
    med[i] = col[Math.floor(ds.length / 2)]
  }
  const medNorm = Math.sqrt(med.reduce((s, v) => s + v * v, 0)) || 1e-12
  const verdict: { id: number; ok: boolean; why: string; acc: number; cos: number; norm: number }[] = []
  for (let k = 0; k < ups.length; k++) {
    const d = ds[k]
    const sc = norms[k] > clip ? clip / norms[k] : 1
    if (sc < 1) for (let i = 0; i < N; i++) d[i] *= sc
    let dot = 0
    for (let i = 0; i < N; i++) dot += d[i] * med[i]
    const cos = dot / ((norms[k] * sc || 1e-12) * medNorm)
    setFlat(mdl, base.map((v, i) => v + d[i]))
    const acc = await accuracy(mdl, val)
    const u = ups[k]
    let why = ''
    if (!Number.isFinite(norms[k]) || norms[k] === 0) why = 'pusta lub nieskończona aktualizacja'
    else if (cos < 0) why = `kierunek przeciwny do mediany (cos ${cos.toFixed(2)})`
    else if (acc < baseVal - 0.03) why = `pogarsza walidację (${(acc * 100).toFixed(1)}% < ${(baseVal * 100).toFixed(1)}%)`
    else if (Math.abs(acc - u.claimed) > 0.06) why = `deklaracja ${(u.claimed * 100).toFixed(1)}% ≠ sprawdzenie ${(acc * 100).toFixed(1)}%`
    else if (u.verified.some((v) => Math.abs(v - acc) > 0.04)) why = 'niezgodna weryfikacja na innym węźle'
    verdict.push({ id: u.id, ok: !why, why, acc, cos: +cos.toFixed(3), norm: +norms[k].toFixed(3) })
  }
  const ok = verdict.map((v, k) => (v.ok ? k : -1)).filter((k) => k >= 0)
  if (ok.length < 3) return { ok: false, verdict, baseVal, ms: performance.now() - t0 }
  const tot = ok.reduce((s, k) => s + ups[k].n, 0)
  const avg = new Float32Array(N)
  for (const k of ok) for (let i = 0; i < N; i++) avg[i] += (ups[k].n / tot) * ds[k][i]
  // krok serwera: 1.0 lub 0.5 – wybór na walidacji
  let best: { lr: number; val: number; w: Float32Array } | undefined
  for (const slr of [1, 0.5]) {
    const w = base.map((v, i) => v + slr * avg[i])
    setFlat(mdl, w)
    const v = await accuracy(mdl, val)
    if (!best || v > best.val) best = { lr: slr, val: v, w }
  }
  setFlat(mdl, best!.w)
  const acc = await accuracy(mdl, test)
  return { ok: true, verdict, baseVal, val: best!.val, acc, serverLr: best!.lr, weights: best!.w, ms: performance.now() - t0, ...(await evalSet(m)) }
}

async function initModel(m: ModelId) {
  const mdl = build(m)
  models.set(m, mdl)
  const w = await getFlat(mdl)
  const val = await accuracy(mdl, await data(m, 'val'))
  const acc = await accuracy(mdl, await data(m, 'test'))
  return { weights: w, val, acc, params: w.length, flops: fwdFlops(mdl), ...(await evalSet(m)) }
}

async function bench(m: ModelId, seconds: number) {
  const mdl = model(m)
  const d = await data(m, 'train-00')
  const opt = tf.train.adam(0.001)
  const k = meta[m].classes
  const step = (s: number) =>
    tf.tidy(() => {
      const xb = rows(d, 0, s)
      const yb = tf.oneHot(tf.tensor1d(d.y.subarray(0, s), 'int32'), k)
      return opt.minimize(() => tf.losses.softmaxCrossEntropy(yb, mdl.apply(xb, { training: true }) as tf.Tensor) as tf.Scalar, true)!
    })
  const w = step(64)
  await w.data()
  w.dispose()
  let n = 0
  const t0 = performance.now()
  while (performance.now() - t0 < seconds * 1000) {
    const l = step(64)
    await l.data()
    l.dispose()
    n += 64
  }
  const dt = (performance.now() - t0) / 1000
  opt.dispose()
  const F = fwdFlops(mdl) * 3
  return { sps: Math.round(n / dt), gflops: +((n * F) / dt / 1e9).toFixed(2) }
}

self.onmessage = async (e: MessageEvent) => {
  const { rid, op, ...a } = e.data
  try {
    let out: unknown
    if (op === 'init') {
      meta = await (await fetch(`${BASE}data/ml/meta.json`)).json()
      info = await initBackend(a.prefer)
      out = info
    } else if (op === 'ctl') {
      if (a.duty != null) duty = a.duty
      if (a.paused != null) paused = a.paused
      out = true
    } else if (op === 'bench') out = { ...info, ...(await bench(a.model, a.seconds ?? 3)) }
    else if (op === 'job') out = await runJob(a.job)
    else if (op === 'aggregate') out = await aggregate(a.model, a.baseUrl, a.ups)
    else if (op === 'initModel') out = await initModel(a.model)
    const tr: Transferable[] = []
    const o = out as { weights?: Float32Array }
    if (o && o.weights instanceof Float32Array) tr.push(o.weights.buffer as ArrayBuffer)
    ;(self as unknown as Worker).postMessage({ rid, ok: true, out }, tr)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ rid, ok: false, error: (err as Error).message ?? String(err) })
  }
}
