// Zadania captcha: dane (Fashion-MNIST, EMNIST, wydarzenia, pary PL↔EN) i małe modele obrazów
// uczone w przeglądarce (regresja softmax na 14×14 pikseli) – zestaw startowy + etykiety z konsensusu.
export interface PxSet {
  px: string
  y: number[]
}
export interface Captcha {
  version: number
  fashion: { classes_pl: string[]; classes_en: string[]; seed: PxSet; test: PxSet; pool: { id: string; px: string }[]; rotate: { id: string; px: string }[] }
  letters: { seed: PxSet; test: PxSet; pool: { id: string; px: string }[] }
  order: { id: string; items: { pl: string; en: string }[] }[]
  pairs: { id: string; pl: string; en: string }[]
  sources: string[]
}

export const ROT = ['zero', 'prawo', 'dol', 'lewo'] as const
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
export const PERMS: string[] = (() => {
  const out: string[] = []
  const rec = (p: string, rest: string) => (rest ? [...rest].forEach((c, i) => rec(p + c, rest.slice(0, i) + rest.slice(i + 1))) : out.push(p))
  rec('', 'abcd')
  return out
})()
export const imgQid = (id: string, k: number) => `${id}k${k}`

/** Rodzaj zadania z identyfikatora pytania (te same klucze co myc_gold_by_type w bazie). */
export const taskKind = (qid: string) => (qid[0] === 'c' ? qid.slice(0, 2) : qid[0])

export function decode(b64: string): Uint8Array {
  const s = atob(b64)
  const a = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
  return a
}

/** 28×28 → 14×14 (średnia 2×2), jak w scripts/export_captcha.py. */
export function pool14(px: Uint8Array): Uint8Array {
  const o = new Uint8Array(196)
  for (let r = 0; r < 14; r++)
    for (let c = 0; c < 14; c++) o[r * 14 + c] = Math.round((px[2 * r * 28 + 2 * c] + px[2 * r * 28 + 2 * c + 1] + px[(2 * r + 1) * 28 + 2 * c] + px[(2 * r + 1) * 28 + 2 * c + 1]) / 4)
  return o
}

export const rows196 = (set: PxSet): Float32Array[] => {
  const a = decode(set.px)
  return set.y.map((_, i) => Float32Array.from(a.subarray(i * 196, (i + 1) * 196), (v) => v / 255))
}

/** Regresja softmax (196 → k), pełny gradient z L2; deterministyczna. */
export class PixelAgent {
  W: Float32Array
  b: Float32Array
  private k: number
  constructor(k: number) {
    this.k = k
    this.W = new Float32Array(196 * k)
    this.b = new Float32Array(k)
  }
  logits(x: Float32Array): Float32Array {
    const z = Float32Array.from(this.b)
    for (let c = 0; c < this.k; c++) {
      let s = 0
      const o = c * 196
      for (let j = 0; j < 196; j++) s += this.W[o + j] * x[j]
      z[c] += s
    }
    return z
  }
  proba(x: Float32Array): Float32Array {
    const z = this.logits(x)
    const m = Math.max(...z)
    let t = 0
    for (let c = 0; c < this.k; c++) t += z[c] = Math.exp(z[c] - m)
    for (let c = 0; c < this.k; c++) z[c] /= t
    return z
  }
  fit(X: Float32Array[], y: number[], epochs = 60, lr = 0.5, l2 = 1e-3): this {
    const n = X.length
    if (!n) return this
    for (let e = 0; e < epochs; e++) {
      const gW = new Float32Array(this.W.length)
      const gb = new Float32Array(this.k)
      for (let i = 0; i < n; i++) {
        const p = this.proba(X[i])
        p[y[i]] -= 1
        for (let c = 0; c < this.k; c++) {
          if (p[c] === 0) continue
          gb[c] += p[c]
          const o = c * 196
          for (let j = 0; j < 196; j++) gW[o + j] += p[c] * X[i][j]
        }
      }
      for (let j = 0; j < this.W.length; j++) this.W[j] -= lr * (gW[j] / n + l2 * this.W[j])
      for (let c = 0; c < this.k; c++) this.b[c] -= (lr * gb[c]) / n
    }
    return this
  }
  acc(X: Float32Array[], y: number[]): number {
    let h = 0
    X.forEach((x, i) => {
      const p = this.proba(x)
      if (p.indexOf(Math.max(...p)) === y[i]) h++
    })
    return X.length ? h / X.length : 0
  }
}
