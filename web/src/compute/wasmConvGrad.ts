// Brakujące w TF.js-WASM jądro Conv2DBackpropFilter (gradient filtra splotu) – bez niego CNN nie trenuje na WASM.
// Liczone bezpośrednio na pamięci sterty WASM (NHWC, dowolny krok, padding valid/same).
import { getKernel, registerKernel, type KernelConfig, type TensorInfo } from '@tensorflow/tfjs-core'

interface WasmLike {
  typedArrayFromHeap(t: TensorInfo): Float32Array
  makeOutput(shape: number[], dtype: 'float32'): TensorInfo
}

export function registerWasmConvGrad() {
  if (getKernel('Conv2DBackpropFilter', 'wasm')) return
  const cfg: KernelConfig = {
    kernelName: 'Conv2DBackpropFilter',
    backendName: 'wasm',
    kernelFunc: ({ inputs, backend, attrs }) => {
      const be = backend as unknown as WasmLike
      const { x, dy } = inputs as { x: TensorInfo; dy: TensorInfo }
      const a = attrs as unknown as { strides: number | [number, number]; pad: string | number; filterShape: [number, number, number, number] }
      const [sh, sw] = typeof a.strides === 'number' ? [a.strides, a.strides] : a.strides
      const [KH, KW, CI, CO] = a.filterShape
      const [N, H, W] = x.shape
      const [, OH, OW] = dy.shape
      let pt = 0
      let pl = 0
      if (a.pad === 'same') {
        pt = Math.max(0, ((OH - 1) * sh + KH - H) >> 1)
        pl = Math.max(0, ((OW - 1) * sw + KW - W) >> 1)
      } else if (typeof a.pad === 'number') pt = pl = a.pad
      const X = be.typedArrayFromHeap(x)
      const D = be.typedArrayFromHeap(dy)
      const out = be.makeOutput([KH, KW, CI, CO], 'float32')
      const G = new Float32Array(KH * KW * CI * CO)
      for (let n = 0; n < N; n++)
        for (let oh = 0; oh < OH; oh++)
          for (let ow = 0; ow < OW; ow++) {
            const dOff = ((n * OH + oh) * OW + ow) * CO
            for (let kh = 0; kh < KH; kh++) {
              const ih = oh * sh + kh - pt
              if (ih < 0 || ih >= H) continue
              for (let kw = 0; kw < KW; kw++) {
                const iw = ow * sw + kw - pl
                if (iw < 0 || iw >= W) continue
                const xOff = ((n * H + ih) * W + iw) * CI
                const gBase = (kh * KW + kw) * CI * CO
                for (let ci = 0; ci < CI; ci++) {
                  const xv = X[xOff + ci]
                  if (xv === 0) continue
                  const g = gBase + ci * CO
                  for (let co = 0; co < CO; co++) G[g + co] += xv * D[dOff + co]
                }
              }
            }
          }
      be.typedArrayFromHeap(out).set(G)
      return out
    },
  }
  registerKernel(cfg)
}
