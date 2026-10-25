// Sprawdzenie wag z węzła nasiennego (PyTorch) w TF.js: ta sama budowa warstw co engine.worker.ts (buildArch),
// trafność na walidacji i stałym teście z public/data/ml. Użycie: node scripts/verify-seed.mjs <model> <wagi.bin>
import * as tf from '@tensorflow/tfjs-core'
import * as tfl from '@tensorflow/tfjs-layers'
import '@tensorflow/tfjs-backend-cpu'
import { readFileSync } from 'node:fs'

const [m, file] = process.argv.slice(2)
const meta = JSON.parse(readFileSync('public/data/ml/meta.json', 'utf8'))[m]
await tf.setBackend('cpu')
const L = tfl.layers
const first = (o, i) => (i === 0 ? { ...o, inputShape: meta.shape ?? [meta.dim] } : o)
const mdl = tfl.sequential({
  layers: meta.arch.layers.map((l, i) => {
    const act = l.relu ? 'relu' : undefined
    if (l.t === 'conv') return L.conv2d(first({ filters: l.f, kernelSize: 3, padding: l.same ? 'same' : 'valid', activation: act }, i))
    if (l.t === 'pool') return L.maxPooling2d({ poolSize: 2 })
    if (l.t === 'flatten') return L.flatten()
    if (l.t === 'drop') return L.dropout({ rate: l.r })
    if (l.t === 'bn') return L.batchNormalization({ epsilon: 1e-3, momentum: 0.99 })
    return L.dense(first({ units: l.u, activation: act }, i))
  }),
})
const buf = readFileSync(file)
const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
let o = 0
mdl.setWeights(mdl.getWeights().map((w) => tf.tensor(flat.subarray(o, (o += w.size)), w.shape)))
if (o !== flat.length) throw new Error(`rozmiar ${flat.length} ≠ ${o}`)
// FLOP-y przejścia w przód (jak fwdFlops w engine.worker.ts)
let F = 0
for (const l of mdl.layers) {
  const c = l.getClassName()
  const k = l.getWeights()[0]?.shape
  if (c === 'Conv2D') F += l.outputShape[1] * l.outputShape[2] * l.outputShape[3] * k[0] * k[1] * k[2] * 2
  else if (c === 'Dense') F += k[0] * k[1] * 2
}
function acc(part) {
  const u = readFileSync(`public/data/ml/${m}/${part}.bin`)
  const rec = meta.dim + 1
  const n = Math.floor(u.length / rec)
  let hit = 0
  for (let i = 0; i < n; i += 256) {
    const s = Math.min(256, n - i)
    const X = new Float32Array(s * meta.dim)
    for (let r = 0; r < s; r++)
      for (let j = 0; j < meta.dim; j++) {
        const v = u[(i + r) * rec + j]
        X[r * meta.dim + j] = meta.format === 'dense-u8' ? v / 255 : ((v << 24) >> 24) / 127
      }
    const p = tf.tidy(() => tf.argMax(mdl.apply(tf.tensor(X, [s, ...(meta.shape ?? [meta.dim])]), { training: false }), -1)).dataSync()
    for (let r = 0; r < s; r++) if (p[r] === u[(i + r) * rec + meta.dim]) hit++
  }
  return hit / n
}
console.log(JSON.stringify({ model: m, arch: meta.arch.id, params: flat.length, flops: F, val: +acc('val').toFixed(4), test: +acc('test').toFixed(4) }))
