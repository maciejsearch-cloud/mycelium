// Jądro „pula wątków”: każda macierz dzielona wierszami na N wątków roboczych (mm.worker.ts), mnożenia liczone równolegle.
// Działa bez izolacji COOP/COEP (GitHub Pages), bo nie potrzebuje SharedArrayBuffer – wektor wejściowy jest mały i kopiowany.
import type { Kernel, Q8 } from './qwen'

type H = { id: number; rows: number; cols: number; parts: { w: number; r0: number; n: number }[] }

export async function poolKernel(n: number): Promise<Kernel> {
  const ws = Array.from({ length: n }, () => new Worker(new URL('./mm.worker.ts', import.meta.url), { type: 'module' }))
  const wait = new Map<number, (m: { y?: Float32Array; err?: string; name?: string }) => void>()
  let rid = 0
  let nid = 0
  for (const w of ws)
    w.onmessage = (e) => {
      const cb = wait.get(e.data.rid)
      wait.delete(e.data.rid)
      cb?.(e.data)
    }
  const call = (w: Worker, m: Record<string, unknown>, tr: Transferable[] = []) =>
    new Promise<{ y?: Float32Array; err?: string; name?: string }>((res) => {
      const r = ++rid
      wait.set(r, res)
      w.postMessage({ ...m, rid: r }, tr)
    })
  const names = await Promise.all(ws.map((w) => call(w, { t: 'init' })))
  return {
    name: `${names[0].name ?? 'wasm'}×${n}`,
    prep(w: Q8): H {
      const id = ++nid
      const per = Math.ceil(w.rows / n)
      const parts: H['parts'] = []
      ws.forEach((wk, i) => {
        const r0 = i * per
        const k = Math.min(per, w.rows - r0)
        if (k <= 0) return
        const q = w.q.slice(r0 * w.cols, (r0 + k) * w.cols)
        const s = w.s.slice(r0, r0 + k)
        wk.postMessage({ t: 'prep', id, rows: k, cols: w.cols, q, s }, [q.buffer, s.buffer])
        parts.push({ w: i, r0, n: k })
      })
      return { id, rows: w.rows, cols: w.cols, parts }
    },
    async mm(h, x, T, b) {
      const H = h as H
      const ys = await Promise.all(
        H.parts.map((p) => call(ws[p.w], { t: 'mm', id: H.id, x, T, b: b ? b.subarray(p.r0, p.r0 + p.n) : undefined })),
      )
      const out = new Float32Array(T * H.rows)
      ys.forEach((r, i) => {
        if (r.err || !r.y) throw new Error(r.err ?? 'mm')
        const p = H.parts[i]
        for (let t = 0; t < T; t++) out.set(r.y.subarray(t * p.n, (t + 1) * p.n), t * H.rows + p.r0)
      })
      return out
    },
    free(h) {
      const H = h as H
      for (const p of H.parts) ws[p.w].postMessage({ t: 'free', id: H.id })
    },
  }
}
