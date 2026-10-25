// Grzybnia jako jeden model językowy: węzły trzymają fragmenty Qwen2.5-0.5B, klient składa trasę
// przez wszystkie fragmenty (z zapasowymi węzłami) i generuje tekst token po tokenie.
// Koordynacja bez serwera: każdy węzeł widzi obecność innych i deterministycznie wybiera brakujące fragmenty.
import { ids } from '../myc/store'
import { Net, type Msg, type Presence } from './net'
import { EMB_SHARDS, LAYER_SHARDS, MODEL, SHARDS, sample, type ShardId } from './qwen'

export const MESH_NODE_KEY = 'myc.meshNode'
export interface ShardHolder {
  node: string
  state: 'loading' | 'ready'
  backend?: string
  link: 'rtc' | 'relay' | 'none'
  self?: boolean
}
export interface MeshView {
  connected: boolean
  nodes: number
  /** fragmenty → węzły, które je mają */
  shards: Record<ShardId, ShardHolder[]>
  ready: number
  total: number
  full: boolean
  minNodes: number
  local?: { shards: Record<string, { state: 'loading' | 'ready' | 'error'; loaded: number; bytes?: number; ms?: number; err?: string }>; backend?: string; cap: number }
  lastRoute?: { shard: ShardId; node: string; ms: number; link: string }[]
  tps?: number
  /** czas do pierwszego tokenu ostatniej odpowiedzi (ms) */
  firstMs?: number
  served: number
  /** węzły z całym modelem (odpowiadają same, bez przechodzenia przez inne węzły) */
  fullNodes: { node: string; kind?: string; label?: string; backend?: string; self?: boolean; link: string }[]
}

const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

class Mesh {
  net?: Net
  view: MeshView = { connected: false, nodes: 0, shards: {}, ready: 0, total: SHARDS.length, full: false, minNodes: Math.ceil(SHARDS.length / 4), served: 0, fullNodes: [] }
  private subs = new Set<() => void>()
  private worker?: Worker
  private wready?: Promise<string>
  private pending = new Map<string, (m: Msg) => void>()
  private cap = 0
  private timer?: ReturnType<typeof setInterval>
  private rid = 0
  // identyfikator żądania unikalny między przeładowaniami: id węzła klienta jest trwałe (localStorage), a węzły pamiętają
  // stan odpowiedzi „gen” pod kluczem nadawca:rid przez 10 min – licznik od 1 po przeładowaniu odtwarzał STARĄ odpowiedź
  private ridBase = crypto.randomUUID().slice(0, 8)
  private nextRid = () => `${this.ridBase}-${++this.rid}`
  version = 0

  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.version
  private emit() {
    this.recompute()
    this.version++
    for (const f of this.subs) f()
  }

  /** Dołącz do grzybni (jako klient; z cap > 0 także jako węzeł z fragmentami). */
  async connect() {
    if (this.net) return this.net.ready
    const st: Presence = { node: ids.node, role: 'client', shards: {}, cap: 0, at: Date.now() }
    let room: string | undefined
    try {
      room = localStorage.getItem('myc-mesh-room') || undefined // tylko testy: izolacja od prawdziwych węzłów
    } catch {
      room = undefined
    }
    this.net = new Net(ids.node, st, room)
    this.net.watch(() => {
      this.emit()
      this.rebalance()
    })
    this.net.on((from, m, bin) => this.onMsg(from, m, bin))
    await this.net.ready
    this.view.connected = true
    this.emit()
  }

  private recompute() {
    const v = this.view
    const sh: Record<ShardId, ShardHolder[]> = {}
    for (const s of SHARDS) sh[s] = []
    const pres = [...(this.net?.presence.values() ?? [])]
    for (const p of pres) for (const [s, state] of Object.entries(p.shards ?? {})) sh[s]?.push({ node: p.node, state, backend: p.backend, link: this.net!.link(p.node) })
    for (const [s, l] of Object.entries(v.local?.shards ?? {})) if (l.state !== 'error') sh[s]?.push({ node: ids.node, state: l.state, backend: v.local?.backend, link: 'rtc', self: true })
    v.shards = sh
    v.nodes = new Set([...pres.filter((p) => p.cap > 0).map((p) => p.node), ...(this.cap > 0 ? [ids.node] : [])]).size
    v.ready = SHARDS.filter((s) => sh[s].some((h) => h.state === 'ready')).length
    v.full = v.ready === SHARDS.length
    const localFull = SHARDS.every((s) => v.local?.shards[s]?.state === 'ready')
    v.fullNodes = [
      ...(localFull ? [{ node: ids.node, kind: 'browser', backend: v.local?.backend, self: true, link: 'local' }] : []),
      ...pres.filter((p) => p.full && SHARDS.every((s) => p.shards?.[s] === 'ready')).map((p) => ({ node: p.node, kind: p.kind, label: p.label, backend: p.backend, link: p.rtc === false ? 'relay' : this.net!.link(p.node) })),
    ]
  }

  // ── węzeł ─────────────────────────────────────────────────────────────
  async serve(cap: number) {
    await this.connect()
    this.cap = cap
    localStorage.setItem(MESH_NODE_KEY, String(cap))
    if (!this.worker) {
      this.worker = new Worker(new URL('./shard.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e) => this.onWorker(e.data)
      this.wready = new Promise((res) => {
        const on = (e: MessageEvent) => {
          if (e.data.t === 'init') {
            this.worker!.removeEventListener('message', on)
            res(e.data.backend)
          }
        }
        this.worker!.addEventListener('message', on)
      })
      this.worker.postMessage({ t: 'init', backend: new URLSearchParams(location.search).get('backend') ?? 'auto' })
      const backend = await this.wready
      this.view.local = { shards: {}, backend, cap }
      this.net!.update({ role: 'node', cap, backend })
    } else {
      this.view.local!.cap = cap
      this.net!.update({ cap })
    }
    clearInterval(this.timer)
    this.timer = setInterval(() => this.rebalance(), 15000)
    // krótkie opóźnienie zależne od id węzła: równoczesne węzły nie wybierają tego samego fragmentu
    setTimeout(() => this.rebalance(), 500 + (hash(ids.node) % 2500)) // authentic-ok: rozproszenie startu, nie dane
    this.emit()
  }

  stop() {
    localStorage.removeItem(MESH_NODE_KEY)
    this.cap = 0
    clearInterval(this.timer)
    for (const s of Object.keys(this.view.local?.shards ?? {})) this.worker?.postMessage({ t: 'drop', id: s })
    if (this.view.local) this.view.local.shards = {}
    this.net?.update({ role: 'client', cap: 0, shards: {} })
    this.emit()
  }

  private publishShards() {
    const sh: Record<string, 'loading' | 'ready'> = {}
    for (const [s, l] of Object.entries(this.view.local?.shards ?? {})) if (l.state !== 'error') sh[s] = l.state
    this.net?.update({ shards: sh, full: SHARDS.every((s) => sh[s] === 'ready'), kind: 'browser' })
  }

  private rebalance() {
    if (!this.cap || !this.view.local) return
    this.recompute()
    const mine = Object.entries(this.view.local.shards).filter(([, l]) => l.state !== 'error').map(([s]) => s)
    // jeden fragment naraz (mniej pamięci i szybciej gotowy pierwszy)
    if (Object.values(this.view.local.shards).some((l) => l.state === 'loading')) return
    const holders = (s: ShardId) => this.view.shards[s]?.filter((h) => !h.self).length ?? 0
    const rot = hash(ids.node) % SHARDS.length
    const order = SHARDS.map((_, i) => SHARDS[(i + rot) % SHARDS.length])
    if (mine.length < this.cap) {
      const free = order.filter((s) => !mine.includes(s)).sort((a, b) => holders(a) - holders(b))[0]
      if (free !== undefined && (holders(free) === 0 || mine.length < this.cap)) this.load(free)
      return
    }
    // pełny węzeł: zamień zdublowany fragment (≥1 inna kopia) na brakujący (0 kopii); robi to tylko węzeł o najwyższym id wśród posiadaczy
    const missing = order.find((s) => holders(s) === 0 && !mine.includes(s))
    if (!missing) return
    const spare = mine.find((s) => holders(s) >= 1 && this.view.shards[s].filter((h) => !h.self).every((h) => h.node < ids.node))
    if (spare) {
      this.worker!.postMessage({ t: 'drop', id: spare })
      delete this.view.local.shards[spare]
      this.load(missing)
    }
  }

  private load(s: ShardId) {
    if (!this.view.local || (this.view.local.shards[s] && this.view.local.shards[s].state !== 'error')) return
    this.view.local.shards[s] = { state: 'loading', loaded: 0 }
    this.worker!.postMessage({ t: 'load', id: s })
    this.publishShards()
    this.emit()
  }

  private onWorker(m: Msg) {
    const L = this.view.local
    if (m.t === 'progress' && L?.shards[m.id as string]) L.shards[m.id as string].loaded = m.loaded as number
    if (m.t === 'loaded' && L?.shards[m.id as string]) {
      L.shards[m.id as string] = { state: 'ready', loaded: m.bytes as number, bytes: m.bytes as number, ms: m.ms as number }
      this.publishShards()
      setTimeout(() => this.rebalance(), 300)
    }
    if (m.t === 'error' && m.id && L?.shards[m.id as string]) {
      L.shards[m.id as string] = { state: 'error', loaded: 0, err: String(m.err) }
      this.publishShards()
    }
    if (m.t === 'tok') {
      this.streams.get(m.rid as string)?.(m)
      return
    }
    if (m.t === 'res') {
      this.streams.delete(m.rid as string)
      const cb = this.pending.get(m.rid as string)
      this.pending.delete(m.rid as string)
      cb?.(m)
    }
    this.emit()
  }

  private streams = new Map<string, (m: Msg) => void>()
  private onMsg(from: string, m: Msg, bin?: ArrayBuffer) {
    if (m.k === 'tok' || m.k === 'ack') {
      this.streams.get(`out:${m.rid}`)?.(m)
      return
    }
    if (m.k === 'stop') {
      this.worker?.postMessage({ t: 'stop', rid: `${from}:${m.rid}` })
      return
    }
    if (m.k === 'req' && m.op === 'gen') {
      const rid = `${from}:${m.rid}`
      if (this.streams.has(rid)) return // ponowione żądanie – już liczymy
      void this.net!.send(from, { k: 'ack', rid: m.rid })
      if (!this.worker || !this.view.fullNodes.some((f) => f.self)) {
        void this.net!.send(from, { k: 'res', rid: m.rid, err: 'no-shard' })
        return
      }
      this.streams.set(rid, (t) => void this.net!.send(from, { k: 'tok', rid: m.rid, ids: t.ids }))
      this.pending.set(rid, (r) => {
        this.view.served++
        void this.net!.send(from, { k: 'res', rid: m.rid, err: r.err, done: true, n: r.n, tps: r.tps, firstMs: r.firstMs, reused: r.reused })
      })
      this.worker.postMessage({ t: 'gen', rid, conv: `${from}|${m.conv}`, ids: m.ids, maxNew: m.maxNew, temp: m.temp })
      return
    }
    if (m.k === 'req') {
      // żądanie od klienta → do workera → odpowiedź tą samą drogą
      const rid = `${from}:${m.rid}`
      this.pending.set(rid, (r) => {
        this.view.served++
        const y = r.y as ArrayBuffer | undefined
        void this.net!.send(from, { k: 'res', rid: m.rid, err: r.err, ms: r.ms, top: r.top }, y)
      })
      if (!this.worker || this.view.local?.shards[m.shard as string]?.state !== 'ready') {
        this.pending.get(rid)!({ err: 'no-shard' })
        this.pending.delete(rid)
        return
      }
      this.worker.postMessage({ t: 'run', rid, shard: m.shard, shards: m.shards, op: m.op, conv: m.conv, start: m.start, ids: m.ids, x: bin }, bin ? [bin] : [])
    } else if (m.k === 'res') {
      const cb = this.pending.get(`out:${m.rid}`)
      this.pending.delete(`out:${m.rid}`)
      cb?.({ ...m, y: bin })
    }
  }

  // ── klient ────────────────────────────────────────────────────────────
  private bad = new Map<string, number>()
  private call(node: string, shard: ShardId, op: string, args: Msg, x?: Float32Array, timeout = 60000): Promise<Msg> {
    const rid = this.nextRid()
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(`out:${rid}`)
        rej(new Error(`timeout ${shard}@${node.slice(0, 6)}`))
      }, timeout)
      this.pending.set(`out:${rid}`, (m) => {
        clearTimeout(t)
        if (m.err) rej(new Error(String(m.err)))
        else res(m)
      })
      const buf = x ? x.slice().buffer : undefined
      if (node === ids.node) {
        // lokalny fragment – bez sieci
        this.pending.set(`self:${rid}`, (r) => {
          const cb = this.pending.get(`out:${rid}`)
          this.pending.delete(`out:${rid}`)
          cb?.(r)
        })
        this.worker!.postMessage({ t: 'run', rid: `self:${rid}`, shard, op, ...args, x: buf }, buf ? [buf] : [])
      } else void this.net!.send(node, { k: 'req', rid, shard, op, ...args }, buf)
    })
  }

  /** Wybór węzła dla fragmentu: gotowy, nieoznaczony jako zawodny; najpierw lokalny, potem bezpośredni (WebRTC). */
  private pick(s: ShardId, avoid: Set<string>): string | undefined {
    const hs = (this.view.shards[s] ?? []).filter((h) => h.state === 'ready' && !avoid.has(h.node) && (this.bad.get(h.node) ?? 0) < Date.now())
    hs.sort((a, b) => Number(!!b.self) - Number(!!a.self) || Number(b.link === 'rtc') - Number(a.link === 'rtc') || (hash(a.node + s) % 97) - (hash(b.node + s) % 97))
    return hs[0]?.node
  }

  /**
   * Generuje odpowiedź. tokens – pełna historia tokenów rozmowy (prompt). onToken dostaje nowe identyfikatory.
   * Przy awarii węzła: oznacza go, wybiera zapasowy i liczy rozmowę od początku na nowej trasie.
   */
  /** Cała odpowiedź na jednym węźle z pełnym modelem: prompt jednym przejściem, tokeny strumieniem. */
  private async generateFull(f: MeshView['fullNodes'][number], tokens: number[], conv: string, opts: GenOpts): Promise<GenResult> {
    const rid = this.nextRid()
    const key = f.self ? `self:${rid}` : `out:${rid}`
    const t0 = performance.now()
    let firstMs = 0
    const out: number[] = []
    let lastAt = performance.now()
    let acked = false
    let lastAsk = performance.now()
    const req = { conv, ids: tokens, maxNew: opts.maxNew ?? 160, temp: opts.temp ?? 0.5 }
    const ask = () => void this.net!.send(f.node, { k: 'req', rid, op: 'gen', shard: '*', ...req }).catch(() => undefined)
    return new Promise<GenResult>((res, rej) => {
      const fail = (e: Error) => {
        clearInterval(watch)
        this.streams.delete(key)
        this.pending.delete(key)
        rej(e)
      }
      // przekaźnik może zgubić wiadomość: bez potwierdzenia ponów żądanie, bez postępu dopytaj o stan; 25 s ciszy = węzeł niedostępny
      const watch = setInterval(() => {
        const now = performance.now()
        if (now - lastAt > 25000) fail(new Error(`timeout gen@${f.node.slice(0, 6)}`))
        else if (!f.self && now - lastAt > 2500 && now - lastAsk > 2500) {
          lastAsk = now
          if (acked) void this.net!.send(f.node, { k: 'poll', rid }).catch(() => undefined)
          else ask()
        }
        if (opts.signal?.stop) void (f.self ? this.worker?.postMessage({ t: 'stop', rid: key }) : this.net!.send(f.node, { k: 'stop', rid }))
      }, 500)
      this.streams.set(key, (m) => {
        lastAt = performance.now()
        acked = true
        if (m.k === 'ack') return
        const ids = m.ids as number[]
        // 'all': wiadomość niesie wszystkie dotychczasowe tokeny (odporne na zgubione paczki)
        const fresh = m.all ? ids.slice(out.length) : ids
        if (fresh.length && !out.length) firstMs = performance.now() - t0
        for (const id of fresh) {
          out.push(id)
          opts.onToken(id)
        }
      })
      this.pending.set(key, (m) => {
        clearInterval(watch)
        this.streams.delete(key)
        if (m.err) return rej(new Error(`${String(m.err)}@${f.node.slice(0, 6)}`))
        const route = [{ shard: 'L0-L7+E0-E3', node: f.node, ms: Math.round(performance.now() - t0), link: f.link }]
        // tok/s liczone u klienta (od pierwszego do ostatniego tokenu), węzeł podaje swoje osobno
        const dt = (performance.now() - t0 - firstMs) / 1000
        const tps = out.length > 1 && dt > 0 ? (out.length - 1) / dt : 0
        this.view.lastRoute = route
        this.view.tps = tps
        this.view.firstMs = firstMs
        this.emit()
        res({ tokens: out, tps, route, prefillMs: firstMs, firstMs, retries: 0, mode: 'full', nodeTps: m.tps as number | undefined, reused: m.reused as number | undefined })
      })
      if (f.self) this.worker!.postMessage({ t: 'gen', rid: key, ...req, conv: `self|${conv}` })
      else ask()
    })
  }

  async generate(tokens: number[], opts: GenOpts): Promise<GenResult> {
    const conv = opts.conv ?? crypto.randomUUID()
    // 1) węzeł z całym modelem: najpierw własny, potem bezpośredni (WebRTC), potem bez przeglądarki
    this.recompute()
    // ?mesh=sharded wymusza trasę przez fragmenty (do pomiarów porównawczych)
    const forceSharded = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mesh') === 'sharded'
    const fulls = forceSharded ? [] : this.view.fullNodes.filter((f) => (this.bad.get(f.node) ?? 0) < Date.now())
    fulls.sort((a, b) => Number(!!b.self) - Number(!!a.self) || Number(b.link === 'rtc') - Number(a.link === 'rtc') || (hash(a.node + conv) % 97) - (hash(b.node + conv) % 97))
    for (const f of fulls.slice(0, 2)) {
      let got = 0
      try {
        return await this.generateFull(f, tokens, conv, { ...opts, onToken: (id) => (got++, opts.onToken(id)) })
      } catch (e) {
        this.bad.set(f.node, Date.now() + 60000)
        if (got) throw e
      }
    }
    return this.generateSharded(tokens, opts, conv)
  }

  // ostatnia trasa i liczba tokenów rozmowy już policzonych na jej węzłach (pamięć K/V na węzłach)
  private convDone = new Map<string, { route: string; tokens: number[] }>()

  /** Odpowiedź przez fragmenty na wielu węzłach. Kolejne fragmenty na tym samym węźle idą jednym wywołaniem. */
  private async generateSharded(tokens: number[], opts: GenOpts, conv0: string): Promise<GenResult> {
    const maxNew = opts.maxNew ?? 160
    let retries = 0
    const rnd = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32
    for (;;) {
      this.recompute()
      if (!this.view.full) throw new Error('mesh-incomplete')
      const route = new Map<ShardId, string>()
      for (const s of SHARDS) {
        const n = this.pick(s, new Set())
        if (!n) throw new Error('mesh-incomplete')
        route.set(s, n)
      }
      // trasa: kolejne warstwy u jednego węzła (mniej przeskoków); preferuj węzeł poprzedniego fragmentu
      for (let i = 1; i < LAYER_SHARDS.length; i++) {
        const prev = route.get(LAYER_SHARDS[i - 1])!
        if (this.view.shards[LAYER_SHARDS[i]].some((h) => h.node === prev && h.state === 'ready') && (this.bad.get(prev) ?? 0) < Date.now()) route.set(LAYER_SHARDS[i], prev)
      }
      const groups: { node: string; shards: ShardId[] }[] = []
      for (const s of LAYER_SHARDS) {
        const n = route.get(s)!
        if (groups.length && groups[groups.length - 1].node === n) groups[groups.length - 1].shards.push(s)
        else groups.push({ node: n, shards: [s] })
      }
      const rkey = SHARDS.map((s) => route.get(s)).join(',')
      const prevDone = this.convDone.get(conv0)
      const conv = conv0
      const stats = new Map<ShardId, number>()
      const out: number[] = []
      let firstMs = 0
      try {
        // wspólny początek z poprzednią wypowiedzią na tej samej trasie jest już w pamięci K/V węzłów
        let pos = 0
        if (prevDone && prevDone.route === rkey && retries === 0) {
          while (pos < Math.min(prevDone.tokens.length, tokens.length - 1) && prevDone.tokens[pos] === tokens[pos]) pos++
        }
        let seq = tokens.slice(pos)
        const done = tokens.slice(0, pos)
        let t0 = performance.now()
        let prefillMs = 0
        for (let step = 0; step < maxNew && !opts.signal?.stop; step++) {
          const T = seq.length
          // 1) osadzenia: części słownika równolegle, suma
          const parts = await Promise.all(EMB_SHARDS.map((s) => this.call(route.get(s)!, s, 'embed', { ids: seq, conv, start: pos })))
          let h = new Float32Array(T * MODEL.hidden)
          for (const p of parts) {
            const y = new Float32Array(p.y as ArrayBuffer)
            for (let i = 0; i < h.length; i++) h[i] += y[i]
          }
          // 2) warstwy po kolei, jedno wywołanie na grupę kolejnych fragmentów jednego węzła
          for (const g of groups) {
            const a = performance.now()
            const r = await this.call(g.node, g.shards[0], g.shards.length > 1 ? 'layersN' : 'layers', { conv, start: pos, shards: g.shards }, h)
            h = new Float32Array(r.y as ArrayBuffer)
            for (const s of g.shards) stats.set(s, (stats.get(s) ?? 0) + (performance.now() - a) / g.shards.length)
          }
          // 3) logity: części słownika równolegle, łączenie top-k
          const last = h.slice((T - 1) * MODEL.hidden)
          const tops = await Promise.all(EMB_SHARDS.map((s) => this.call(route.get(s)!, s, 'logits', { conv, start: pos }, last)))
          const cands = tops.flatMap((t) => t.top as [number, number][])
          const nx = sample(cands, [...tokens, ...out].slice(-48), opts.temp ?? 0.5, 0.9, rnd)
          pos += T
          done.push(...seq)
          if (step === 0) {
            prefillMs = performance.now() - t0
            firstMs = prefillMs
            t0 = performance.now()
          }
          if ((MODEL.eos as readonly number[]).includes(nx)) break
          out.push(nx)
          opts.onToken(nx)
          seq = [nx]
        }
        const dt = (performance.now() - t0) / 1000
        const tps = out.length > 1 && dt > 0 ? (out.length - 1) / dt : 0
        const r = SHARDS.map((s) => ({ shard: s, node: route.get(s)!, ms: Math.round(stats.get(s) ?? 0), link: route.get(s) === ids.node ? 'local' : this.net!.link(route.get(s)!) }))
        this.view.lastRoute = r
        this.view.tps = tps
        this.view.firstMs = firstMs
        this.convDone.set(conv, { route: rkey, tokens: done })
        this.emit()
        return { tokens: out, tps, route: r, prefillMs, firstMs, retries, mode: 'sharded' }
      } catch (e) {
        // awaria węzła na trasie: wyklucz go na 60 s i spróbuj innej trasy (od początku rozmowy)
        const msg = String((e as Error).message)
        const node = /@([0-9a-f]{6})/.exec(msg)?.[1]
        for (const n of route.values()) if (node ? n.startsWith(node) : msg.includes('no-shard')) this.bad.set(n, Date.now() + 60000)
        this.convDone.delete(conv0)
        if (out.length || ++retries > 3) throw e
      }
    }
  }
}

export interface GenOpts {
  maxNew?: number
  temp?: number
  conv?: string
  onToken: (id: number) => void
  signal?: { stop: boolean }
}
export interface GenResult {
  tokens: number[]
  tps: number
  route: NonNullable<MeshView['lastRoute']>
  prefillMs: number
  firstMs: number
  retries: number
  mode: 'full' | 'sharded'
  nodeTps?: number
  reused?: number
}

export const mesh = new Mesh()
// podgląd stanu w konsoli (diagnostyka węzłów)
;(globalThis as unknown as { mycMesh?: Mesh }).mycMesh = mesh
