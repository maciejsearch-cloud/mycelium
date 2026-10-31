// Wątek roboczy do mnożenia macierzy (model w przeglądarce): trzyma swój pas wierszy każdej macierzy i liczy go na WASM.
// Kolejność wiadomości zachowana (kolejka), bo wczytanie jądra jest asynchroniczne.
import { jsKernel, type Kernel } from './qwen'
import { tfKernel } from './tfkernel'

let K: Kernel = jsKernel
const W = new Map<number, unknown>()
let q: Promise<unknown> = Promise.resolve()
const post = (m: unknown, tr: Transferable[] = []) => (self as unknown as Worker).postMessage(m, tr)

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data
  q = q.then(async () => {
    try {
      if (m.t === 'init') {
        K = await tfKernel('wasm').catch(() => jsKernel)
        post({ rid: m.rid, name: K.name })
      } else if (m.t === 'prep') {
        W.set(m.id, K.prep({ rows: m.rows, cols: m.cols, q: m.q, s: m.s }))
      } else if (m.t === 'mm') {
        const y = await K.mm(W.get(m.id), m.x, m.T, m.b)
        const out = y.buffer === m.x.buffer ? y.slice() : y
        post({ rid: m.rid, y: out }, [out.buffer])
      } else if (m.t === 'free') {
        const h = W.get(m.id)
        W.delete(m.id)
        if (h && K.free) K.free(h)
      }
    } catch (e) {
      post({ rid: m.rid, err: String((e as Error).message ?? e) })
    }
  })
}
