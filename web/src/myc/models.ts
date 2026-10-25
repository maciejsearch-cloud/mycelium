// Małe modele uczone w przeglądarce (bez serwera). Lustro src/iot_mycelium/ai/learners.py.
export type Mat = Float64Array[]

export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(s)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function textFeatures(texts: string[], dim: number, bigrams: boolean): Mat {
  return texts.map((t) => {
    const x = new Float64Array(dim + 1)
    const toks = t.toLowerCase().match(/[a-z0-9']+/g) ?? []
    const grams = bigrams ? [...toks, ...toks.slice(1).map((b, i) => `${toks[i]}_${b}`)] : toks
    for (const gr of grams) x[fnv1a(gr) % dim] += 1
    let n = 0
    for (let i = 0; i < dim; i++) n += x[i] * x[i]
    n = Math.sqrt(n)
    if (n) for (let i = 0; i < dim; i++) x[i] /= n
    x[dim] = 1
    return x
  })
}

export interface SensorItem {
  seg: number[]
  ctx: number[]
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
const std = (a: number[]) => {
  const m = mean(a)
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)))
}
export function sensorFeatures(items: SensorItem[]): Mat {
  return items.map(({ seg, ctx }) => {
    const mu = mean(ctx)
    const sd = std(ctx) + 1e-3
    const z = seg.map((v) => (v - mu) / sd)
    const n = seg.length
    const xm = (n - 1) / 2
    const zm = mean(z)
    let num = 0
    let den = 0
    z.forEach((v, i) => {
      num += (i - xm) * (v - zm)
      den += (i - xm) ** 2
    })
    const diffs = seg.slice(1).map((v, i) => Math.abs(v - seg[i]))
    return Float64Array.from([
      zm,
      Math.min(...z),
      Math.max(...z),
      std(seg) / sd,
      (num / den) * n,
      z[n - 1] - z[0],
      mean(diffs) / sd,
      (Math.max(...seg) - Math.min(...seg)) / sd,
      (mean(seg) - 85) / 10,
      (Math.min(...seg) - 85) / 10,
      1,
    ])
  })
}

export function softmaxRow(z: Float64Array | number[]): Float64Array {
  const m = Math.max(...z)
  const e = Float64Array.from(z, (v) => Math.exp(v - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / s)
}

/** Regresja softmax, Adam, pełny batch (deterministycznie). w: [d][k] spłaszczone. */
export function trainSoftmax(x: Mat, y: number[], k: number, lr: number, l2: number, epochs: number, classWeight?: number[]): Float64Array {
  const d = x[0].length
  const w = new Float64Array(d * k)
  const m = new Float64Array(d * k)
  const v = new Float64Array(d * k)
  const sw = y.map((c) => classWeight?.[c] ?? 1)
  const swSum = sw.reduce((a, b) => a + b, 0)
  const g = new Float64Array(d * k)
  for (let t = 1; t <= epochs; t++) {
    g.fill(0)
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]
      const z = new Float64Array(k)
      for (let j = 0; j < d; j++) if (xi[j]) for (let c = 0; c < k; c++) z[c] += xi[j] * w[j * k + c]
      const p = softmaxRow(z)
      p[y[i]] -= 1
      for (let j = 0; j < d; j++) if (xi[j]) for (let c = 0; c < k; c++) g[j * k + c] += (xi[j] * p[c] * sw[i]) / swSum
    }
    const b1 = 1 - 0.9 ** t
    const b2 = 1 - 0.999 ** t
    for (let j = 0; j < d * k; j++) {
      const gj = g[j] + l2 * w[j]
      m[j] = 0.9 * m[j] + 0.1 * gj
      v[j] = 0.999 * v[j] + 0.001 * gj * gj
      w[j] -= (lr * (m[j] / b1)) / (Math.sqrt(v[j] / b2) + 1e-8)
    }
  }
  return w
}

export function logits(x: Float64Array, w: Float64Array, k: number): Float64Array {
  const z = new Float64Array(k)
  for (let j = 0; j < x.length; j++) if (x[j]) for (let c = 0; c < k; c++) z[c] += x[j] * w[j * k + c]
  return z
}

export interface IntentCfg {
  dim: number
  bigrams: boolean
  lr: number
  l2: number
  epochs: number
  min_conf: number
  specialists: number[]
}
export interface SensorCfg {
  lr: number
  l2: number
  epochs: number
  pos_weight: number
  threshold: number
  min_conf: number
}
export interface Cfg {
  intent: IntentCfg
  sensor: SensorCfg
}
export const DEFAULT_CFG: Cfg = {
  intent: { dim: 512, bigrams: false, lr: 0.05, l2: 1e-3, epochs: 150, min_conf: 0.7, specialists: [] },
  sensor: { lr: 0.05, l2: 1e-3, epochs: 200, pos_weight: 3, threshold: 0.5, min_conf: 0.7 },
}

export class IntentAgent {
  w!: Float64Array
  spec = new Map<number, Float64Array>()
  cfg: IntentCfg
  k: number
  constructor(cfg: IntentCfg, k: number) {
    this.cfg = cfg
    this.k = k
  }
  fit(texts: string[], y: number[]) {
    const x = textFeatures(texts, this.cfg.dim, this.cfg.bigrams)
    this.w = trainSoftmax(x, y, this.k, this.cfg.lr, this.cfg.l2, this.cfg.epochs)
    for (const c of this.cfg.specialists)
      this.spec.set(c, trainSoftmax(x, y.map((v) => (v === c ? 1 : 0)), 2, this.cfg.lr, this.cfg.l2, this.cfg.epochs, [1, 3]))
    return this
  }
  proba(texts: string[]): Float64Array[] {
    return textFeatures(texts, this.cfg.dim, this.cfg.bigrams).map((x) => {
      const z = logits(x, this.w, this.k)
      for (const [c, w] of this.spec) {
        const p = Math.min(Math.max(softmaxRow(logits(x, w, 2))[1], 1e-4), 1 - 1e-4)
        z[c] += Math.log(p / (1 - p))
      }
      return softmaxRow(z)
    })
  }
}

export class SensorAgent {
  w!: Float64Array
  mu!: number[]
  sd!: number[]
  cfg: SensorCfg
  constructor(cfg: SensorCfg) {
    this.cfg = cfg
  }
  private norm(x: Mat): Mat {
    return x.map((r) => r.map((v, j) => (j < r.length - 1 ? (v - this.mu[j]) / this.sd[j] : v)))
  }
  fit(items: SensorItem[], y: number[]) {
    const x = sensorFeatures(items)
    const d = x[0].length - 1
    this.mu = Array.from({ length: d }, (_, j) => mean(x.map((r) => r[j])))
    this.sd = Array.from({ length: d }, (_, j) => std(x.map((r) => r[j])) + 1e-6)
    this.w = trainSoftmax(this.norm(x), y, 2, this.cfg.lr, this.cfg.l2, this.cfg.epochs, [1, this.cfg.pos_weight])
    return this
  }
  /** P(anomalia) */
  proba(items: SensorItem[]): number[] {
    return this.norm(sensorFeatures(items)).map((x) => softmaxRow(logits(x, this.w, 2))[1])
  }
}

export function balancedAcc(y: number[], pred: number[]): number {
  const cls = [...new Set(y)]
  return cls.reduce((s, c) => {
    const idx = y.map((v, i) => [v, i]).filter(([v]) => v === c)
    return s + idx.filter(([, i]) => pred[i] === c).length / idx.length
  }, 0) / cls.length
}
