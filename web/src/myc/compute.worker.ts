// Web Worker trybu „Start sesji”: lokalny trening (FedAvg – klient) na odłamku otwartych danych.
// Nie dotyka danych użytkownika; dostaje tylko globalny model i odłamek Fashion-MNIST/EMNIST.
import { PixelAgent } from './vision'

type Msg = { type: 'round'; k: number; W?: Float32Array; b?: Float32Array; shard: Uint8Array; epochs: number; duty: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data
  if (m.type !== 'round') return
  const t0 = performance.now()
  const n = Math.floor(m.shard.length / 197)
  const X: Float32Array[] = []
  const y: number[] = []
  for (let i = 0; i < n; i++) {
    X.push(Float32Array.from(m.shard.subarray(i * 197, i * 197 + 196), (v) => v / 255))
    y.push(m.shard[i * 197 + 196])
  }
  const a = new PixelAgent(m.k)
  if (m.W && m.b) {
    a.W.set(m.W)
    a.b.set(m.b)
  }
  let busy = 0
  for (let ep = 0; ep < m.epochs; ep++) {
    const s = performance.now()
    a.fit(X, y, 1, 0.5, 1e-3)
    busy += performance.now() - s
    // ograniczenie mocy: przerwa proporcjonalna do pracy (duty = udział czasu pracy)
    if (m.duty < 1) await sleep(((performance.now() - s) * (1 - m.duty)) / m.duty)
  }
  self.postMessage({ type: 'done', W: a.W, b: a.b, n, ms: Math.round(performance.now() - t0), busy: Math.round(busy) })
}
