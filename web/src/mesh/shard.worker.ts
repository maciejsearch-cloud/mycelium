// Worker węzła: trzyma przydzielone fragmenty modelu i liczy je na żądanie (KV osobno na rozmowę).
import {
  parseLora,
  type Lora,
  EMB_SHARDS,
  LAYER_SHARDS,
  embed,
  sample,
  httpRange,
  jsKernel,
  loadShard,
  MODEL,
  newKV,
  readHeader,
  runLayers,
  topLogits,
  type Header,
  type Kernel,
  type KV,
  type Shard,
  type ShardId,
} from './qwen'
import { tfKernel } from './tfkernel'

let K: Kernel = jsKernel
let kready: Promise<void> | undefined
let hdr: Promise<{ header: Header; base: number }> | undefined
const shards = new Map<ShardId, Shard>()
// adapter LoRA (model językowy grzybni) scalany z wagami przy wczytywaniu – tylko w lokalnym modelu przeglądarki
let lora: Lora | undefined
const kvs = new Map<string, { kv: KV; at: number }>()
const stops = new Set<string>()
// pełny model w tym węźle: tokeny rozmowy już policzone (wspólny początek kolejnej wypowiedzi pomijamy)
const genDone = new Map<string, number[]>()
// lokalny model przeglądarki: surowe zakresy bajtów zapisywane w Cache Storage (kolejne wizyty bez ponownego pobierania ~1 GB)
function cachedRange(url: string, onBytes: (n: number) => void) {
  const net = httpRange(url, onBytes)
  return async (s: number, e: number) => {
    const key = `${url}?range=${s}-${e}`
    const c = await caches.open('myc-local-lm-v1').catch(() => undefined)
    const hit = await c?.match(key).catch(() => undefined)
    if (hit) {
      const b = await hit.arrayBuffer()
      onBytes(b.byteLength)
      return b
    }
    const b = await net(s, e)
    void c?.put(key, new Response(b.slice(0))).catch(() => undefined)
    return b
  }
}
const post = (m: unknown, tr: Transferable[] = []) => (self as unknown as Worker).postMessage(m, tr)

function kvFor(shard: ShardId, conv: string, start: number): KV {
  const key = `${shard}|${conv}`
  let e = kvs.get(key)
  if (!e || start === 0) {
    e = { kv: newKV(3), at: Date.now() }
    kvs.set(key, e)
    // najwyżej 6 rozmów na fragment
    const mine = [...kvs.entries()].filter(([k]) => k.startsWith(shard + '|')).sort((a, b) => a[1].at - b[1].at)
    while (mine.length > 6) kvs.delete(mine.shift()![0])
  }
  e.at = Date.now()
  // krótszy wspólny początek (np. zmieniony prompt systemowy): obetnij pamięć K/V i licz od tego miejsca
  if (start < e.kv.len) e.kv.len = start
  if (e.kv.len !== start) throw new Error(`kv:${e.kv.len}`)
  return e.kv
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data
  try {
    if (m.t === 'init') {
      kready ??= tfKernel(m.backend ?? 'auto')
        .then((k) => {
          K = k
        })
        .catch(() => {
          K = jsKernel
        })
      await kready
      const iso = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
      post({ t: 'init', backend: K.name, threads: K.name === 'wasm' && iso ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1 })
    } else if (m.t === 'lora') {
      lora = m.buf ? parseLora(m.buf) : undefined
      post({ t: 'lora', ok: true })
    } else if (m.t === 'load') {
      await kready
      hdr ??= readHeader(httpRange(MODEL.url))
      const { header, base } = await hdr
      let got = 0
      let last = 0
      const t0 = performance.now()
      const onB = (n: number) => {
        got += n
        if (got - last > 2e6) {
          last = got
          post({ t: 'progress', id: m.id, loaded: got })
        }
      }
      const { shard, bytes } = await loadShard(m.cache && typeof caches !== 'undefined' ? cachedRange(MODEL.url, onB) : httpRange(MODEL.url, onB), header, base, m.id, K, lora)
      shards.set(m.id, shard)
      post({ t: 'loaded', id: m.id, bytes, ms: performance.now() - t0 })
    } else if (m.t === 'drop') {
      const s = shards.get(m.id)
      shards.delete(m.id)
      if (s && K.free) {
        if (s.kind === 'E') K.free(s.head)
        else for (const L of s.layers) for (const w of [L.q, L.k, L.v, L.o, L.gate, L.up, L.down]) K.free(w)
      }
      post({ t: 'dropped', id: m.id })
    } else if (m.t === 'stop') {
      stops.add(m.rid)
    } else if (m.t === 'gen') {
      // cała odpowiedź w tym węźle: bez sieci między fragmentami
      const t0 = performance.now()
      const prompt: number[] = m.ids
      const prev = genDone.get(m.conv) ?? []
      let pos = 0
      while (pos < Math.min(prev.length, prompt.length - 1) && prev[pos] === prompt[pos]) pos++
      // pamięć K/V mogła zostać zwolniona (limit rozmów) – wtedy licz od początku
      if (LAYER_SHARDS.some((l) => (kvs.get(`${l}|${m.conv}`)?.kv.len ?? 0) < pos)) pos = 0
      const reused = pos
      let seq = prompt.slice(pos)
      const out: number[] = []
      const done = prompt.slice(0, pos)
      let firstMs = 0
      let t1 = 0
      const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
      for (let step = 0; step < Math.min(400, m.maxNew ?? 160) && !stops.has(m.rid); step++) {
        const T = seq.length
        let h: Float32Array = new Float32Array(T * MODEL.hidden)
        for (const e of EMB_SHARDS) {
          const y = embed(shards.get(e) as Extract<Shard, { kind: 'E' }>, seq)
          for (let i = 0; i < h.length; i++) h[i] += y[i]
        }
        for (const l of LAYER_SHARDS) h = await runLayers(shards.get(l) as Extract<Shard, { kind: 'L' }>, kvFor(l, m.conv, pos), h, T, K)
        if (m.prefillOnly) {
          pos += T
          done.push(...seq)
          firstMs = performance.now() - t0
          break
        }
        const last = h.slice((T - 1) * MODEL.hidden)
        const cands = (await Promise.all(EMB_SHARDS.map((e) => topLogits(shards.get(e) as Extract<Shard, { kind: 'E' }>, last, 40, K)))).flat()
        const nx = sample(cands, [...prompt, ...out].slice(-48), m.temp ?? 0.5, 0.9, rnd)
        pos += T
        done.push(...seq)
        if (step === 0) {
          firstMs = performance.now() - t0
          t1 = performance.now()
        }
        if ((MODEL.eos as readonly number[]).includes(nx)) break
        out.push(nx)
        post({ t: 'tok', rid: m.rid, ids: [nx] })
        seq = [nx]
      }
      stops.delete(m.rid)
      genDone.set(m.conv, done)
      while (genDone.size > 6) genDone.delete(genDone.keys().next().value!)
      const dt = (performance.now() - t1) / 1000
      post({
        t: 'res',
        rid: m.rid,
        n: out.length,
        tps: out.length > 1 && dt > 0 ? (out.length - 1) / dt : 0,
        firstMs,
        reused,
      })
    } else if (m.t === 'run') {
      const s = shards.get(m.shard)
      if (!s) throw new Error('no-shard')
      const t0 = performance.now()
      if (m.op === 'layersN') {
        // kilka kolejnych fragmentów warstw tego węzła jednym wywołaniem (jeden przeskok sieci zamiast kilku)
        let y = new Float32Array(m.x)
        const T = y.length / MODEL.hidden
        for (const id of m.shards as ShardId[]) {
          const sl = shards.get(id)
          if (!sl || sl.kind !== 'L') throw new Error('no-shard')
          y = await runLayers(sl, kvFor(id, m.conv, m.start), y, T, K)
        }
        post({ t: 'res', rid: m.rid, ms: performance.now() - t0, y: y.buffer }, [y.buffer])
      } else if (m.op === 'layers' && s.kind === 'L') {
        const x = new Float32Array(m.x)
        const T = x.length / MODEL.hidden
        const y = await runLayers(s, kvFor(m.shard, m.conv, m.start), x, T, K)
        post({ t: 'res', rid: m.rid, ms: performance.now() - t0, y: y.buffer }, [y.buffer])
      } else if (m.op === 'embed' && s.kind === 'E') {
        const y = embed(s, m.ids)
        post({ t: 'res', rid: m.rid, ms: performance.now() - t0, y: y.buffer }, [y.buffer])
      } else if (m.op === 'logits' && s.kind === 'E') {
        const top = await topLogits(s, new Float32Array(m.x), 40, K)
        post({ t: 'res', rid: m.rid, ms: performance.now() - t0, top })
      } else throw new Error('bad-op')
    }
  } catch (e) {
    post({
      t: m.t === 'run' ? 'res' : 'error',
      rid: m.rid,
      id: m.id,
      err: String((e as Error).message ?? e),
    })
  }
}
