// Qwen2.5-0.5B-Instruct (Apache-2.0) pocięty na fragmenty (shardy) do rozproszonego wnioskowania w grzybni.
// Wagi są pobierane zakresami bajtów (HTTP Range) prosto z oryginalnego pliku safetensors na Hugging Face –
// każdy węzeł pobiera tylko swój fragment (~68–90 MB), kwantyzuje go do int8 (skala na wiersz) i liczy
// swoje warstwy. Kod czysty (bez DOM), działa w Workerze i w Node (testy).

export const MODEL = {
  id: 'Qwen/Qwen2.5-0.5B-Instruct',
  url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/resolve/7ae557604adf67be50417f59c2c2f167def9a775/model.safetensors',
  license: 'Apache-2.0',
  hidden: 896,
  inter: 4864,
  layers: 24,
  heads: 14,
  kvHeads: 2,
  headDim: 64,
  vocab: 151936,
  eps: 1e-6,
  theta: 1e6,
  eos: [151645, 151643],
} as const

export const LAYERS_PER_SHARD = 3
export const EMB_PARTS = 4
export type ShardId = string // 'L0'..'L7' (warstwy), 'E0'..'E3' (osadzenia + głowa LM, część słownika)
export const SHARDS: ShardId[] = [...Array.from({ length: MODEL.layers / LAYERS_PER_SHARD }, (_, i) => `L${i}`), ...Array.from({ length: EMB_PARTS }, (_, i) => `E${i}`)]
export const LAYER_SHARDS = SHARDS.filter((s) => s[0] === 'L')
export const EMB_SHARDS = SHARDS.filter((s) => s[0] === 'E')
export const embRange = (i: number): [number, number] => {
  const per = Math.ceil(MODEL.vocab / EMB_PARTS)
  return [i * per, Math.min(MODEL.vocab, (i + 1) * per)]
}

export interface TensorInfo {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}
export type Header = Record<string, TensorInfo>

/** Pobieranie zakresu bajtów (w przeglądarce i w Node). */
export type RangeFetch = (start: number, endExcl: number) => Promise<ArrayBuffer>

export function httpRange(url: string, onBytes?: (n: number) => void): RangeFetch {
  return async (s, e) => {
    for (let i = 0; ; i++) {
      let got = 0
      try {
        const r = await fetch(url, {
          headers: { Range: `bytes=${s}-${e - 1}` },
        })
        if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`)
        if (!r.body || !onBytes) return await r.arrayBuffer()
        const out = new Uint8Array(e - s)
        const rd = r.body.getReader()
        let o = 0
        for (;;) {
          const { done, value } = await rd.read()
          if (done) break
          out.set(value, o)
          o += value.length
          got += value.length
          onBytes(value.length)
        }
        if (o !== e - s) throw new Error(`krótka odpowiedź ${o}/${e - s}`)
        return out.buffer
      } catch (err) {
        if (got) onBytes?.(-got)
        if (i >= 3) throw err
        await new Promise((res) => setTimeout(res, 1000 * 2 ** i))
      }
    }
  }
}

export async function readHeader(get: RangeFetch): Promise<{ header: Header; base: number }> {
  const n = Number(new DataView(await get(0, 8)).getBigUint64(0, true))
  const json = JSON.parse(new TextDecoder().decode(await get(8, 8 + n))) as Record<string, unknown>
  delete json.__metadata__
  return { header: json as Header, base: 8 + n }
}

/** Zakres bajtów fragmentu w pliku (warstwy są w pliku ciągłe). */
export function shardTensors(h: Header, shard: ShardId): string[] {
  if (shard[0] === 'E') return ['model.embed_tokens.weight']
  const i = Number(shard.slice(1))
  const names: string[] = []
  for (let l = i * LAYERS_PER_SHARD; l < (i + 1) * LAYERS_PER_SHARD; l++) names.push(...Object.keys(h).filter((k) => k.startsWith(`model.layers.${l}.`)))
  if (i === LAYER_SHARDS.length - 1) names.push('model.norm.weight')
  return names
}

const bf16 = (u: Uint16Array, i: number, tmp: Uint32Array, f: Float32Array) => {
  tmp[0] = u[i] << 16
  return f[0]
}

/** Macierz int8 z osobną skalą na wiersz: w[r][c] ≈ q[r*cols+c] * s[r]. */
export interface Q8 {
  rows: number
  cols: number
  q: Int8Array
  s: Float32Array
}

export function bf16ToF32(buf: ArrayBuffer, off: number, n: number): Float32Array {
  const u = new Uint16Array(buf, off, n)
  const out = new Float32Array(n)
  const o32 = new Uint32Array(out.buffer)
  for (let i = 0; i < n; i++) o32[i] = u[i] << 16
  return out
}

/** add(r, row): opcjonalna poprawka wiersza przed kwantyzacją (scalenie adaptera LoRA z wagami bazowymi). */
export function quantRows(buf: ArrayBuffer, off: number, rows: number, cols: number, rowStart = 0, add?: (r: number, row: Float32Array) => void): Q8 {
  const u = new Uint16Array(buf, off + rowStart * cols * 2, rows * cols)
  const q = new Int8Array(rows * cols)
  const s = new Float32Array(rows)
  const tmp = new Uint32Array(1)
  const f = new Float32Array(tmp.buffer)
  const row = new Float32Array(cols)
  for (let r = 0; r < rows; r++) {
    let m = 0
    for (let c = 0; c < cols; c++) {
      const v = bf16(u, r * cols + c, tmp, f)
      row[c] = v
    }
    if (add) add(r, row)
    for (let c = 0; c < cols; c++) {
      const v = row[c]
      const a = v < 0 ? -v : v
      if (a > m) m = a
    }
    const sc = m / 127 || 1
    s[r] = sc
    const inv = 1 / sc
    for (let c = 0; c < cols; c++) q[r * cols + c] = Math.round(row[c] * inv)
  }
  return { rows, cols, q, s }
}

/** y[t][r] = Σ_c W[r][c]·x[t][c] (+ b[r]); x: T×cols, y: T×rows. Wiersz wag czytany raz na wszystkie tokeny. */
export function matmul(W: Q8, x: Float32Array, T: number, b?: Float32Array): Float32Array {
  const { rows, cols, q, s } = W
  const y = new Float32Array(T * rows)
  for (let r = 0; r < rows; r++) {
    const o = r * cols
    const sc = s[r]
    const bias = b ? b[r] : 0
    for (let t = 0; t < T; t++) {
      const xo = t * cols
      let a0 = 0,
        a1 = 0,
        a2 = 0,
        a3 = 0
      let c = 0
      for (; c + 3 < cols; c += 4) {
        a0 += q[o + c] * x[xo + c]
        a1 += q[o + c + 1] * x[xo + c + 1]
        a2 += q[o + c + 2] * x[xo + c + 2]
        a3 += q[o + c + 3] * x[xo + c + 3]
      }
      for (; c < cols; c++) a0 += q[o + c] * x[xo + c]
      y[t * rows + r] = (a0 + a1 + a2 + a3) * sc + bias
    }
  }
  return y
}

export function rmsnorm(x: Float32Array, T: number, w: Float32Array, eps = MODEL.eps): Float32Array {
  const d = w.length
  const y = new Float32Array(x.length)
  for (let t = 0; t < T; t++) {
    let ss = 0
    for (let i = 0; i < d; i++) ss += x[t * d + i] * x[t * d + i]
    const inv = 1 / Math.sqrt(ss / d + eps)
    for (let i = 0; i < d; i++) y[t * d + i] = x[t * d + i] * inv * w[i]
  }
  return y
}

/** Jądro mnożenia macierzy: JS (wszędzie) albo tfjs (WebGPU / WASM SIMD + wątki). */
export interface Kernel {
  name: string
  prep(w: Q8): unknown
  mm(h: unknown, x: Float32Array, T: number, b?: Float32Array): Float32Array | Promise<Float32Array>
  free?(h: unknown): void
}
export const jsKernel: Kernel = {
  name: 'js',
  prep: (w) => w,
  mm: (h, x, T, b) => matmul(h as Q8, x, T, b),
}

interface Layer {
  ln1: Float32Array
  ln2: Float32Array
  q: unknown
  k: unknown
  v: unknown
  o: unknown
  qb: Float32Array
  kb: Float32Array
  vb: Float32Array
  gate: unknown
  up: unknown
  down: unknown
}

export interface LayerShard {
  kind: 'L'
  id: ShardId
  layers: Layer[]
  norm?: Float32Array
}
export interface EmbShard {
  kind: 'E'
  id: ShardId
  start: number
  end: number
  E: Q8
  head: unknown
}
export type Shard = LayerShard | EmbShard

/** Pobiera i przygotowuje fragment. Zwraca też liczbę pobranych bajtów. */
// ── adapter LoRA modelu językowego grzybni (src/iot_mycelium/mesh/lm.py: MYCLORA1, rank 4 na qkv i o, fp16) ──
export interface Lora {
  rank: number
  scale: number
  aQkv: Float32Array // L×896×r
  bQkv: Float32Array // L×r×1152
  aO: Float32Array // L×896×r
  bO: Float32Array // L×r×896
  meta: Record<string, unknown>
}
const QKV_OUT = (MODEL.heads + 2 * MODEL.kvHeads) * MODEL.headDim

export function f16ToF32(u: Uint16Array): Float32Array {
  const out = new Float32Array(u.length)
  for (let i = 0; i < u.length; i++) {
    const h = u[i]
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 0x1f
    const f = h & 0x3ff
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024)
  }
  return out
}

export function parseLora(buf: ArrayBuffer): Lora {
  const b = new Uint8Array(buf)
  if (new TextDecoder().decode(b.slice(0, 8)) !== 'MYCLORA1') throw new Error('to nie jest adapter grzybni')
  const n = new DataView(buf).getUint32(8, true)
  const h = JSON.parse(new TextDecoder().decode(b.slice(12, 12 + n))) as {
    rank: number
    alpha: number
    layers: number
  }
  if (h.layers !== MODEL.layers) throw new Error('niezgodny kształt adaptera')
  const r = h.rank
  const L = MODEL.layers
  const sizes = [L * MODEL.hidden * r, L * r * QKV_OUT, L * MODEL.hidden * r, L * r * MODEL.hidden]
  const body = b.slice(12 + n)
  if (body.byteLength !== sizes.reduce((x, y) => x + y, 0) * 2) throw new Error('zły rozmiar adaptera')
  const all = f16ToF32(new Uint16Array(body.buffer))
  const parts: Float32Array[] = []
  let o = 0
  for (const k of sizes) (parts.push(all.subarray(o, o + k)), (o += k))
  return {
    rank: r,
    scale: h.alpha / r,
    aQkv: parts[0],
    bQkv: parts[1],
    aO: parts[2],
    bO: parts[3],
    meta: h,
  }
}

/** Poprawka wiersza wag W[out][in] (układ safetensors) z adaptera: W[o][c] += scale · Σ_k A[l][c][k] · B[l][k][o + off]. */
function loraRow(A: Float32Array, B: Float32Array, l: number, rank: number, outDim: number, off: number, scale: number) {
  const H = MODEL.hidden
  return (r: number, row: Float32Array) => {
    const o = r + off
    for (let k = 0; k < rank; k++) {
      const bk = B[(l * rank + k) * outDim + o] * scale
      if (!bk) continue
      for (let c = 0; c < H; c++) row[c] += A[(l * H + c) * rank + k] * bk
    }
  }
}

export async function loadShard(get: RangeFetch, header: Header, base: number, id: ShardId, K: Kernel = jsKernel, lora?: Lora): Promise<{ shard: Shard; bytes: number }> {
  const names = shardTensors(header, id)
  if (id[0] === 'E') {
    const t = header['model.embed_tokens.weight']
    const [r0, r1] = embRange(Number(id.slice(1)))
    const cols = t.shape[1]
    const s = base + t.data_offsets[0] + r0 * cols * 2
    const buf = await get(s, s + (r1 - r0) * cols * 2)
    const E = quantRows(buf, 0, r1 - r0, cols)
    return {
      shard: { kind: 'E', id, start: r0, end: r1, E, head: K.prep(E) },
      bytes: buf.byteLength,
    }
  }
  // każda warstwa jest w pliku ciągła (nazwy tensorów są posortowane), ale warstwy 2, 10, 11… nie leżą po kolei –
  // więc pobieramy osobny zakres na warstwę (+ norma końcowa), dokładnie tyle bajtów, ile trzeba
  const groups = new Map<string, string[]>()
  for (const n of names) {
    const g = /^model\.layers\.(\d+)\./.exec(n)?.[1] ?? n
    groups.set(g, [...(groups.get(g) ?? []), n])
  }
  const bufs = new Map<string, { buf: ArrayBuffer; lo: number }>()
  let bytes = 0
  for (const ns of groups.values()) {
    const lo = Math.min(...ns.map((n) => header[n].data_offsets[0]))
    const hi = Math.max(...ns.map((n) => header[n].data_offsets[1]))
    const buf = await get(base + lo, base + hi)
    bytes += buf.byteLength
    for (const n of ns) bufs.set(n, { buf, lo })
  }
  const f = (n: string) => {
    const t = header[n]
    const { buf, lo } = bufs.get(n)!
    return bf16ToF32(buf, t.data_offsets[0] - lo, (t.data_offsets[1] - t.data_offsets[0]) / 2)
  }
  const m = (n: string, add?: (r: number, row: Float32Array) => void) => {
    const t = header[n]
    const { buf, lo } = bufs.get(n)!
    return K.prep(quantRows(buf, t.data_offsets[0] - lo, t.shape[0], t.shape[1], 0, add))
  }
  const qd = MODEL.heads * MODEL.headDim
  const kd = MODEL.kvHeads * MODEL.headDim
  const lq = (l: number, off: number) => (lora ? loraRow(lora.aQkv, lora.bQkv, l, lora.rank, QKV_OUT, off, lora.scale) : undefined)
  const lo_ = (l: number) => (lora ? loraRow(lora.aO, lora.bO, l, lora.rank, MODEL.hidden, 0, lora.scale) : undefined)
  const i = Number(id.slice(1))
  const layers: Layer[] = []
  for (let l = i * LAYERS_PER_SHARD; l < (i + 1) * LAYERS_PER_SHARD; l++) {
    const p = `model.layers.${l}.`
    layers.push({
      ln1: f(p + 'input_layernorm.weight'),
      ln2: f(p + 'post_attention_layernorm.weight'),
      q: m(p + 'self_attn.q_proj.weight', lq(l, 0)),
      k: m(p + 'self_attn.k_proj.weight', lq(l, qd)),
      v: m(p + 'self_attn.v_proj.weight', lq(l, qd + kd)),
      o: m(p + 'self_attn.o_proj.weight', lo_(l)),
      qb: f(p + 'self_attn.q_proj.bias'),
      kb: f(p + 'self_attn.k_proj.bias'),
      vb: f(p + 'self_attn.v_proj.bias'),
      gate: m(p + 'mlp.gate_proj.weight'),
      up: m(p + 'mlp.up_proj.weight'),
      down: m(p + 'mlp.down_proj.weight'),
    })
  }
  const norm = header['model.norm.weight'] && names.includes('model.norm.weight') ? f('model.norm.weight') : undefined
  return { shard: { kind: 'L', id, layers, norm }, bytes }
}

/** Pamięć podręczna K/V jednej rozmowy na jednym fragmencie. */
export interface KV {
  k: Float32Array[] // na warstwę: [pos][kvHeads*headDim]
  v: Float32Array[]
  len: number
  cap: number
}
export function newKV(nLayers: number, cap = 256): KV {
  const d = MODEL.kvHeads * MODEL.headDim
  return {
    k: Array.from({ length: nLayers }, () => new Float32Array(cap * d)),
    v: Array.from({ length: nLayers }, () => new Float32Array(cap * d)),
    len: 0,
    cap,
  }
}
function growKV(kv: KV, need: number) {
  if (need <= kv.cap) return
  const d = MODEL.kvHeads * MODEL.headDim
  let cap = kv.cap
  while (cap < need) cap *= 2
  kv.k = kv.k.map((a) => {
    const b = new Float32Array(cap * d)
    b.set(a)
    return b
  })
  kv.v = kv.v.map((a) => {
    const b = new Float32Array(cap * d)
    b.set(a)
    return b
  })
  kv.cap = cap
}

let ropeCache: { cos: Float32Array; sin: Float32Array; n: number } | undefined
function rope(n: number) {
  if (ropeCache && ropeCache.n >= n) return ropeCache
  const hd = MODEL.headDim
  const half = hd / 2
  const N = Math.max(n, 512)
  const cos = new Float32Array(N * half)
  const sin = new Float32Array(N * half)
  for (let p = 0; p < N; p++)
    for (let i = 0; i < half; i++) {
      const a = p / MODEL.theta ** ((2 * i) / hd)
      cos[p * half + i] = Math.cos(a)
      sin[p * half + i] = Math.sin(a)
    }
  ropeCache = { cos, sin, n: N }
  return ropeCache
}
function applyRope(x: Float32Array, T: number, nh: number, pos0: number) {
  const hd = MODEL.headDim
  const half = hd / 2
  const { cos, sin } = rope(pos0 + T)
  for (let t = 0; t < T; t++)
    for (let h = 0; h < nh; h++) {
      const o = (t * nh + h) * hd
      const p = (pos0 + t) * half
      for (let i = 0; i < half; i++) {
        const a = x[o + i]
        const b = x[o + i + half]
        x[o + i] = a * cos[p + i] - b * sin[p + i]
        x[o + i + half] = b * cos[p + i] + a * sin[p + i]
      }
    }
}

/** Przejście T nowych tokenów (pozycje kv.len..kv.len+T-1) przez warstwy fragmentu. Zwraca nowe stany ukryte. */
export async function runLayers(sh: LayerShard, kv: KV, x: Float32Array, T: number, K: Kernel = jsKernel): Promise<Float32Array> {
  const D = MODEL.hidden
  const H = MODEL.heads
  const KH = MODEL.kvHeads
  const hd = MODEL.headDim
  const grp = H / KH
  const pos0 = kv.len
  growKV(kv, pos0 + T)
  let h: Float32Array = x.slice()
  for (let li = 0; li < sh.layers.length; li++) {
    const L = sh.layers[li]
    const n1 = rmsnorm(h, T, L.ln1)
    const [q, k, v] = await Promise.all([K.mm(L.q, n1, T, L.qb), K.mm(L.k, n1, T, L.kb), K.mm(L.v, n1, T, L.vb)])
    applyRope(q, T, H, pos0)
    applyRope(k, T, KH, pos0)
    const kd = KH * hd
    kv.k[li].set(k, pos0 * kd)
    kv.v[li].set(v, pos0 * kd)
    const att = new Float32Array(T * D)
    const scale = 1 / Math.sqrt(hd)
    const sc = new Float32Array(pos0 + T)
    for (let t = 0; t < T; t++) {
      const n = pos0 + t + 1 // przyczynowo
      for (let hh = 0; hh < H; hh++) {
        const g = Math.floor(hh / grp)
        const qo = (t * H + hh) * hd
        let mx = -Infinity
        for (let p = 0; p < n; p++) {
          const ko = p * kd + g * hd
          let s = 0
          for (let i = 0; i < hd; i++) s += q[qo + i] * kv.k[li][ko + i]
          s *= scale
          sc[p] = s
          if (s > mx) mx = s
        }
        let sum = 0
        for (let p = 0; p < n; p++) {
          sc[p] = Math.exp(sc[p] - mx)
          sum += sc[p]
        }
        const ao = (t * H + hh) * hd
        for (let p = 0; p < n; p++) {
          const w = sc[p] / sum
          const vo = p * kd + g * hd
          for (let i = 0; i < hd; i++) att[ao + i] += w * kv.v[li][vo + i]
        }
      }
    }
    const o = await K.mm(L.o, att, T)
    for (let i = 0; i < h.length; i++) h[i] += o[i]
    const n2 = rmsnorm(h, T, L.ln2)
    const [gt, up] = await Promise.all([K.mm(L.gate, n2, T), K.mm(L.up, n2, T)])
    for (let i = 0; i < gt.length; i++) {
      const a = gt[i]
      gt[i] = (a / (1 + Math.exp(-a))) * up[i]
    }
    const dn = await K.mm(L.down, gt, T)
    for (let i = 0; i < h.length; i++) h[i] += dn[i]
  }
  kv.len = pos0 + T
  if (sh.norm) h = rmsnorm(h, T, sh.norm)
  return h
}

/** Osadzenia tokenów z tej części słownika (pozostałe wiersze = 0; klient sumuje odpowiedzi części). */
export function embed(sh: EmbShard, ids: number[]): Float32Array {
  const D = MODEL.hidden
  const out = new Float32Array(ids.length * D)
  ids.forEach((id, t) => {
    if (id < sh.start || id >= sh.end) return
    const r = id - sh.start
    const s = sh.E.s[r]
    for (let i = 0; i < D; i++) out[t * D + i] = sh.E.q[r * D + i] * s
  })
  return out
}

/** Logity tej części słownika dla ostatniego (znormalizowanego) stanu; zwraca k najlepszych [id, logit]. */
export async function topLogits(sh: EmbShard, h: Float32Array, k = 40, K: Kernel = jsKernel): Promise<[number, number][]> {
  const z = await K.mm(sh.head, h, 1)
  const best: [number, number][] = []
  for (let i = 0; i < z.length; i++) {
    if (best.length < k || z[i] > best[best.length - 1][1]) {
      best.push([sh.start + i, z[i]])
      best.sort((a, b) => b[1] - a[1])
      if (best.length > k) best.pop()
    }
  }
  return best
}

/** Wybór tokenu z połączonych top-k wszystkich części: temperatura + top-p, kara za powtórzenia. */
export function sample(cands: [number, number][], recent: number[], temp: number, topP: number, rnd: () => number): number {
  const rec = new Set(recent)
  const c = cands.map(([id, z]) => [id, rec.has(id) ? (z > 0 ? z / 1.1 : z * 1.1) : z] as [number, number]).sort((a, b) => b[1] - a[1])
  if (temp <= 0) return c[0][0]
  const mx = c[0][1]
  const p = c.map(([, z]) => Math.exp((z - mx) / temp))
  const tot = p.reduce((a, b) => a + b, 0)
  let acc = 0
  const keep: number[] = []
  for (let i = 0; i < c.length; i++) {
    keep.push(i)
    acc += p[i] / tot
    if (acc >= topP) break
  }
  const kt = keep.reduce((a, i) => a + p[i], 0)
  let r = rnd() * kt
  for (const i of keep) {
    r -= p[i]
    if (r <= 0) return c[i][0]
  }
  return c[keep[keep.length - 1]][0]
}
