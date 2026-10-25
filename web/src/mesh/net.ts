// Sieć grzybni dla modelu: obecność węzłów i sygnalizacja przez Supabase Realtime (darmowe),
// dane (stany ukryte) bezpośrednio między przeglądarkami przez WebRTC DataChannel.
// Gdy połączenie bezpośrednie się nie uda (np. NAT), wiadomości idą przekaźnikiem Realtime.
import { RealtimeClient, type RealtimeChannel } from '@supabase/realtime-js'
import { SB_KEY, SB_URL } from '../myc/store'

export interface Presence {
  node: string
  role: 'node' | 'client'
  shards: Record<string, 'loading' | 'ready'>
  cap: number
  backend?: string
  at: number
  /** węzeł ma wszystkie fragmenty i liczy całą odpowiedź sam (op 'gen') */
  full?: boolean
  /** false: węzeł bez przeglądarki (Python) – tylko przekaźnik, bez prób WebRTC */
  rtc?: boolean
  kind?: 'browser' | 'headless'
  label?: string
}
export interface Msg {
  [k: string]: unknown
}
type Handler = (from: string, m: Msg, bin?: ArrayBuffer) => void

const CHUNK = 48_000
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

function pack(m: Msg, bin?: ArrayBuffer): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(m))
  const out = new Uint8Array(4 + h.length + (bin?.byteLength ?? 0))
  new DataView(out.buffer).setUint32(0, h.length, true)
  out.set(h, 4)
  if (bin) out.set(new Uint8Array(bin), 4 + h.length)
  return out
}
function unpack(u: Uint8Array): [Msg, ArrayBuffer | undefined] {
  const n = new DataView(u.buffer, u.byteOffset).getUint32(0, true)
  const m = JSON.parse(new TextDecoder().decode(u.subarray(4, 4 + n))) as Msg
  const rest = u.subarray(4 + n)
  return [m, rest.length ? rest.slice().buffer : undefined]
}
const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

class Peer {
  pc?: RTCPeerConnection
  dc?: RTCDataChannel
  open = false
  failed = false
  private parts = new Map<number, Uint8Array[]>()
  private seq = 0
  private net: Net
  id: string
  constructor(net: Net, id: string, initiator: boolean, relayOnly = false) {
    this.net = net
    this.id = id
    if (relayOnly) {
      this.failed = true
      return
    }
    this.pc = new RTCPeerConnection({ iceServers: ICE })
    const pc = this.pc
    pc.onicecandidate = (e) => e.candidate && net.signal(id, { ice: e.candidate.toJSON() })
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        this.failed = true
        this.open = false
      }
    }
    if (initiator) {
      this.wire(pc.createDataChannel('m', { ordered: true }))
      void pc
        .createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => net.signal(id, { sdp: pc.localDescription!.toJSON() }))
    } else pc.ondatachannel = (e) => this.wire(e.channel)
    setTimeout(() => {
      if (!this.open) this.failed = true
    }, 7000)
  }
  private wire(dc: RTCDataChannel) {
    this.dc = dc
    dc.binaryType = 'arraybuffer'
    dc.onopen = () => {
      this.open = true
      this.failed = false
    }
    dc.onclose = () => {
      this.open = false
      this.failed = true
    }
    dc.onmessage = (e) => this.recv(new Uint8Array(e.data as ArrayBuffer))
  }
  recv(u: Uint8Array) {
    const dv = new DataView(u.buffer, u.byteOffset)
    const mid = dv.getUint32(0, true)
    const idx = dv.getUint16(4, true)
    const tot = dv.getUint16(6, true)
    // dane od obcego węzła: ograniczamy rozmiar wiadomości (≤ 256 ramek) i liczbę niedokończonych wiadomości
    if (u.length < 8 || tot === 0 || tot > 256 || idx >= tot) return
    if (!this.parts.has(mid) && this.parts.size >= 64) this.parts.delete(this.parts.keys().next().value!)
    const arr = this.parts.get(mid) ?? []
    arr[idx] = u.slice(8)
    this.parts.set(mid, arr)
    if (arr.filter(Boolean).length === tot) {
      this.parts.delete(mid)
      const all = new Uint8Array(arr.reduce((a, b) => a + b.length, 0))
      let o = 0
      for (const p of arr) {
        all.set(p, o)
        o += p.length
      }
      const [m, bin] = unpack(all)
      this.net.deliver(this.id, m, bin)
    }
  }
  async signal(d: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }) {
    if (!this.pc) return
    if (d.sdp) {
      await this.pc.setRemoteDescription(d.sdp)
      if (d.sdp.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        this.net.signal(this.id, { sdp: this.pc.localDescription!.toJSON() })
      }
    } else if (d.ice) await this.pc.addIceCandidate(d.ice).catch(() => undefined)
  }
  frames(m: Msg, bin?: ArrayBuffer): Uint8Array<ArrayBuffer>[] {
    const u = pack(m, bin)
    const tot = Math.max(1, Math.ceil(u.length / CHUNK))
    const mid = ++this.seq
    const out: Uint8Array<ArrayBuffer>[] = []
    for (let i = 0; i < tot; i++) {
      const part = u.subarray(i * CHUNK, (i + 1) * CHUNK)
      const f = new Uint8Array(8 + part.length)
      const dv = new DataView(f.buffer)
      dv.setUint32(0, mid, true)
      dv.setUint16(4, i, true)
      dv.setUint16(6, tot, true)
      f.set(part, 8)
      out.push(f)
    }
    return out
  }
  async send(m: Msg, bin?: ArrayBuffer) {
    const fr = this.frames(m, bin)
    if (this.open && this.dc) {
      for (const f of fr) {
        while (this.dc.bufferedAmount > 1_000_000) await new Promise((r) => setTimeout(r, 5))
        this.dc.send(f)
      }
    } else for (const f of fr) this.net.relay(this.id, b64(f))
  }
}

export class Net {
  me: string
  ch: RealtimeChannel
  rt: RealtimeClient
  peers = new Map<string, Peer>()
  presence = new Map<string, Presence>()
  ready: Promise<void>
  private handlers = new Set<Handler>()
  private onPresence = new Set<() => void>()
  state: Presence
  constructor(me: string, state: Presence, room = 'myc-mesh-qwen05-v1') {
    this.me = me
    this.state = state
    const ws = SB_URL.replace(/^http/, 'ws') + '/realtime/v1'
    this.rt = new RealtimeClient(ws, { params: { apikey: SB_KEY, eventsPerSecond: 50 } })
    this.ch = this.rt.channel(room, { config: { broadcast: { self: false, ack: false } } })
    // obecność przez bicie serca (broadcast co 5 s, wygasa po 20 s) – prostsze i stabilniejsze niż presence
    this.ch.on('broadcast', { event: 'hb' }, ({ payload }) => {
      const p = payload as Presence & { hello?: boolean }
      if (p.node === me) return
      const isNew = !this.presence.has(p.node)
      this.presence.set(p.node, { ...p, at: Date.now() })
      if (p.hello || isNew) this.beat()
      if (isNew || JSON.stringify(p.shards) !== JSON.stringify(this.seen.get(p.node))) {
        this.seen.set(p.node, p.shards)
        for (const f of this.onPresence) f()
      }
    })
    this.ch.on('broadcast', { event: 'bye' }, ({ payload }) => {
      if (this.presence.delete(payload.node)) for (const f of this.onPresence) f()
    })
    this.ch.on('broadcast', { event: 'sig' }, ({ payload }) => {
      if (payload.to !== me) return
      let p = this.peers.get(payload.from)
      if (!p || (payload.d.sdp?.type === 'offer' && p.failed)) {
        p?.pc?.close()
        p = new Peer(this, payload.from, false)
        this.peers.set(payload.from, p)
      }
      void p.signal(payload.d)
    })
    this.ch.on('broadcast', { event: 'relay' }, ({ payload }) => {
      if (payload.to !== me) return
      let p = this.peers.get(payload.from)
      if (!p) {
        p = new Peer(this, payload.from, false, this.presence.get(payload.from)?.rtc === false)
        this.peers.set(payload.from, p)
      }
      p.recv(unb64(payload.f))
    })
    this.hb = setInterval(() => {
      this.beat()
      const now = Date.now()
      let gone = false
      for (const [k, p] of this.presence) if (now - p.at > 20000) gone = this.presence.delete(k) || gone
      if (gone) for (const f of this.onPresence) f()
    }, 5000)
    addEventListener('pagehide', () => this.tx('bye', { node: me }))
    this.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('realtime timeout')), 15000)
      this.ch.subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          clearTimeout(t)
          this.beat(true)
          res()
        }
      })
    })
  }
  /** wysyłka: przez WebSocket, gdy kanał dołączony; inaczej jawnie przez REST (bez ostrzeżeń o niejawnym przełączeniu) */
  private tx(event: string, payload: Record<string, unknown>) {
    if (this.ch.state === 'joined') void this.ch.send({ type: 'broadcast', event, payload })
    else void this.ch.httpSend(event, payload).catch(() => undefined)
  }
  private hb: ReturnType<typeof setInterval>
  private seen = new Map<string, unknown>()
  private lastBeat = 0
  beat(hello = false) {
    // nie częściej niż co 1 s (limity Realtime)
    if (!hello && Date.now() - this.lastBeat < 1000) return
    this.lastBeat = Date.now()
    this.tx('hb', { ...this.state, at: Date.now(), hello })
  }
  update(p: Partial<Presence>) {
    Object.assign(this.state, p, { at: Date.now() })
    void this.ready.then(() => {
      this.lastBeat = 0
      this.beat()
    })
  }
  watch(f: () => void) {
    this.onPresence.add(f)
    return () => this.onPresence.delete(f)
  }
  on(h: Handler) {
    this.handlers.add(h)
    return () => this.handlers.delete(h)
  }
  deliver(from: string, m: Msg, bin?: ArrayBuffer) {
    for (const h of this.handlers) h(from, m, bin)
  }
  signal(to: string, d: unknown) {
    this.tx('sig', { to, from: this.me, d })
  }
  relay(to: string, f: string) {
    this.tx('relay', { to, from: this.me, f })
  }
  peer(id: string): Peer {
    let p = this.peers.get(id)
    const relayOnly = this.presence.get(id)?.rtc === false
    if (relayOnly && p && !p.pc) return p
    if (!p || (p.failed && !p.open && p.pc?.connectionState !== 'connecting')) {
      p?.pc?.close()
      p = new Peer(this, id, true, relayOnly)
      this.peers.set(id, p)
    }
    return p
  }
  /** Czy ten węzeł jest połączony bezpośrednio (WebRTC), czy przez przekaźnik. */
  link(id: string): 'rtc' | 'relay' | 'none' {
    const p = this.peers.get(id)
    return !p ? 'none' : p.open ? 'rtc' : 'relay'
  }
  async send(to: string, m: Msg, bin?: ArrayBuffer) {
    const p = this.peer(to)
    // daj WebRTC chwilę na zestawienie przy pierwszym kontakcie
    for (let i = 0; i < 40 && !p.open && !p.failed; i++) await new Promise((r) => setTimeout(r, 100))
    await p.send(m, bin)
  }
  close() {
    clearInterval(this.hb)
    for (const p of this.peers.values()) p.pc?.close()
    void this.ch.unsubscribe()
    this.rt.disconnect()
  }
}
