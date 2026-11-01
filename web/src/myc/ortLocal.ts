// onnxruntime-web z własnej strony (BASE/ort/), nie z jsDelivr – CSP nie dopuszcza żadnego CDN ze skryptami.
// transformers.js ustawia przy imporcie adresy CDN; podmieniamy sam prefiks, wariant (.asyncify / zwykły) zostaje.
type Paths = { mjs?: string; wasm?: string }
export function useLocalOrt(env: { backends: { onnx: { wasm?: { wasmPaths?: unknown } } } }): void {
  const w = env.backends.onnx.wasm
  if (!w) return
  const base = new URL(`${import.meta.env.BASE_URL}ort/`, self.location.origin).href
  const p = w.wasmPaths
  const local = (u?: string) => (u ? base + u.split('/').pop() : u)
  if (p && typeof p === 'object') {
    const q = p as Paths
    w.wasmPaths = { mjs: local(q.mjs), wasm: local(q.wasm) }
  } else {
    w.wasmPaths = base
  }
}
