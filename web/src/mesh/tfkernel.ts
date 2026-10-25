// Jądro mnożenia macierzy na tfjs: WebGPU (karta graficzna) albo WASM SIMD z wątkami (wszystkie rdzenie).
import * as tf from '@tensorflow/tfjs-core'
import '@tensorflow/tfjs-backend-cpu'
import '@tensorflow/tfjs-backend-webgpu'
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url'
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url'
import wasmThreads from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url'
import type { Kernel, Q8 } from './qwen'

export async function tfKernel(prefer: 'auto' | 'wasm' | 'webgpu' = 'auto'): Promise<Kernel> {
  setWasmPaths({ 'tfjs-backend-wasm.wasm': wasmPlain, 'tfjs-backend-wasm-simd.wasm': wasmSimd, 'tfjs-backend-wasm-threaded-simd.wasm': wasmThreads })
  try {
    setThreadsCount(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)))
  } catch {
    /* starsza wersja */
  }
  const order = prefer === 'auto' ? ['webgpu', 'wasm'] : [prefer, 'wasm']
  let ok = ''
  for (const b of order) {
    try {
      if (b === 'webgpu' && !(navigator as unknown as { gpu?: unknown }).gpu) continue
      if (await tf.setBackend(b)) {
        await tf.ready()
        // krótki test poprawności
        const r = await tf.matMul(tf.ones([2, 3]), tf.ones([4, 3]), false, true).data()
        if (r[0] !== 3) throw new Error('zły wynik')
        ok = b
        break
      }
    } catch {
      /* następny backend */
    }
  }
  if (!ok) throw new Error('brak backendu tfjs')
  return {
    name: ok,
    prep(w: Q8) {
      const f = new Float32Array(w.rows * w.cols)
      for (let r = 0; r < w.rows; r++) {
        const s = w.s[r]
        const o = r * w.cols
        for (let c = 0; c < w.cols; c++) f[o + c] = w.q[o + c] * s
      }
      // duże macierze (głowa słownika) w kawałkach ≤ 32 MB – limit bufora WebGPU bywa 128 MB
      const per = Math.max(1, Math.floor((32 << 20) / 4 / w.cols))
      const t: tf.Tensor2D[] = []
      for (let r = 0; r < w.rows; r += per) {
        const n = Math.min(per, w.rows - r)
        t.push(tf.tensor2d(f.subarray(r * w.cols, (r + n) * w.cols), [n, w.cols]))
      }
      return { t, rows: w.rows, cols: w.cols }
    },
    async mm(h, x, T, b) {
      const W = h as { t: tf.Tensor2D[]; rows: number; cols: number }
      const y = tf.tidy(() => {
        const xt = tf.tensor2d(x, [T, W.cols])
        const parts = W.t.map((wt) => tf.matMul(xt, wt, false, true))
        const z = parts.length === 1 ? parts[0] : tf.concat(parts, 1)
        return b ? tf.add(z, tf.tensor1d(b)) : z
      })
      const out = (await y.data()) as Float32Array
      y.dispose()
      return out
    },
    free(h) {
      for (const t of (h as { t: tf.Tensor[] }).t) t.dispose()
    },
  }
}
