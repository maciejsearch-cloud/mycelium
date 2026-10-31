// Model grzybni w tej przeglądarce (bez węzłów): Qwen2.5-0.5B-Instruct (Apache-2.0) z opublikowanym adapterem LoRA
// modelu językowego grzybni (najnowsza wersja z myc_models, SHA-256 sprawdzane) scalonym z wagami przy wczytywaniu.
// Osobny Worker – ta przeglądarka NIE staje się węzłem sieci i nikomu nie liczy. Wagi: zakresy bajtów prosto z
// Hugging Face (int8 po wczytaniu, ok. 0,5 GB RAM), zapisane w Cache Storage – kolejne wizyty bez pobierania.
import { SB_KEY, SB_URL } from '../myc/store'
import { SHARDS } from './qwen'

export const LOCAL_KEY = 'myc.localLM'
export const LOCAL_MB = 990 // bf16 ze wszystkich 12 fragmentów (8 × 3 warstwy + 4 części słownika)

export interface LocalView {
  status: 'off' | 'loading' | 'ready' | 'error'
  loaded: number // bajty
  shards: number
  backend?: string
  version?: number // wersja adaptera LM
  acc?: number
  ppl?: number
  err?: string
  loadMs?: number
  threads?: number // osobne wątki robocze liczące mnożenia macierzy (WASM), 1 = jeden wątek
  warmMs?: number // jednorazowe wstępne policzenie stałego promptu systemowego
}

type Msg = Record<string, unknown>

async function sha256(b: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('')
}

class LocalLM {
  view: LocalView = { status: 'off', loaded: 0, shards: 0 }
  private ver = 0
  private subs = new Set<() => void>()
  private w?: Worker
  private wait = new Map<string, (m: Msg) => void>()
  private toks = new Map<string, (ids: number[]) => void>()
  private loading?: Promise<void>
  subscribe = (f: () => void) => (this.subs.add(f), () => void this.subs.delete(f))
  getVersion = () => this.ver
  private emit() {
    this.ver++
    this.view = { ...this.view }
    for (const f of this.subs) f()
  }
  get auto() {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LOCAL_KEY) === '1'
  }
  private once(t: string) {
    return new Promise<Msg>((res) => this.wait.set(t, res))
  }
  private onMsg(m: Msg) {
    if (m.t === 'tok') return this.toks.get(m.rid as string)?.(m.ids as number[])
    if (m.t === 'progress') {
      this.view.loaded = this.base + (m.loaded as number)
      return this.emit()
    }
    const k = m.t === 'res' ? `res:${m.rid}` : m.t === 'error' ? (m.rid ? `res:${m.rid}` : `loaded`) : (m.t as string)
    const cb = this.wait.get(k)
    this.wait.delete(k)
    cb?.(m)
  }
  private base = 0

  /** Wczytaj (raz na kartę). remember = wczytuj automatycznie przy kolejnych wizytach. */
  start(remember = true) {
    if (remember) localStorage.setItem(LOCAL_KEY, '1')
    this.loading ??= this.load().catch((e) => {
      this.view.status = 'error'
      this.view.err = String((e as Error).message ?? e).slice(0, 120)
      this.loading = undefined
      this.w?.terminate()
      this.w = undefined
      this.emit()
    })
    return this.loading
  }
  forget() {
    localStorage.removeItem(LOCAL_KEY)
    this.w?.terminate()
    this.w = undefined
    this.loading = undefined
    this.view = { status: 'off', loaded: 0, shards: 0 }
    void caches?.delete('myc-local-lm-v1').catch(() => undefined)
    this.emit()
  }

  private async load() {
    const t0 = performance.now()
    this.base = 0
    this.view = { status: 'loading', loaded: 0, shards: 0 }
    this.emit()
    // najnowsza opublikowana (zweryfikowana) wersja adaptera – ta sama, której używają węzły w czacie
    const r = await fetch(`${SB_URL}/rest/v1/myc_models?model=eq.lm&order=version.desc&limit=1&select=version,path,acc,meta`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    })
    const cur = (
      (await r.json()) as {
        version: number
        path: string
        acc: number
        meta: { ppl?: number }
      }[]
    )[0]
    let lora: ArrayBuffer | undefined
    if (cur && /^lm\/v\d+-[0-9a-f]{8}\.bin$/.test(cur.path)) {
      lora = await (await fetch(`${SB_URL}/storage/v1/object/public/myc-models/${cur.path}`)).arrayBuffer()
      if (!cur.path.endsWith(`-${(await sha256(lora)).slice(0, 8)}.bin`)) throw new Error('adapter: SHA-256 się nie zgadza')
      Object.assign(this.view, {
        version: cur.version,
        acc: cur.acc,
        ppl: cur.meta?.ppl,
      })
    }
    const w = new Worker(new URL('./shard.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.w = w
    w.onmessage = (e) => this.onMsg(e.data as Msg)
    const init = this.once('init')
    w.postMessage({
      t: 'init',
      backend: new URLSearchParams(location.search).get('backend') ?? 'auto',
      // bez WebGPU: mnożenia macierzy dzielone wierszami na kilka wątków roboczych (GitHub Pages nie pozwala na wątki WASM)
      pool: Math.max(1, Math.min(6, Number(new URLSearchParams(location.search).get('threads')) || (navigator.hardwareConcurrency || 2) - 1)),
    })
    const ini = await init
    this.view.backend = ini.backend as string
    this.view.threads = ini.threads as number
    const lo = this.once('lora')
    w.postMessage({ t: 'lora', buf: lora }, lora ? [lora] : [])
    await lo
    for (const id of SHARDS) {
      const done = this.once('loaded')
      w.postMessage({ t: 'load', id, cache: true })
      const m = await done
      if (m.err) throw new Error(`${id}: ${m.err}`)
      this.base += m.bytes as number
      this.view.loaded = this.base
      this.view.shards++
      this.emit()
    }
    this.view.loadMs = performance.now() - t0
    this.view.status = 'ready'
    this.emit()
  }

  /** Wstępnie policz stały początek rozmowy (prompt systemowy) – pierwsza odpowiedź liczy już tylko pytanie. */
  async warm(ids: number[], conv: string) {
    if (this.view.status !== 'ready' || !this.w || this.view.warmMs !== undefined) return
    const t0 = performance.now()
    this.view.warmMs = 0
    await this.generate(ids, { conv, maxNew: 1, temp: 0, onToken: () => undefined, prefillOnly: true }).catch(() => undefined)
    this.view.warmMs = performance.now() - t0
    this.emit()
  }

  // jedno generowanie naraz (wstępne liczenie promptu i pytanie dzielą tę samą pamięć K/V rozmowy)
  private queue: Promise<unknown> = Promise.resolve()
  generate(...a: Parameters<LocalLM['gen1']>): ReturnType<LocalLM['gen1']> {
    const run = this.queue.then(() => this.gen1(...a))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async gen1(
    ids: number[],
    o: {
      conv: string
      maxNew: number
      temp: number
      onToken: (id: number) => void
      prefillOnly?: boolean
    },
  ) {
    if (this.view.status !== 'ready' || !this.w) throw new Error('local-not-ready')
    const rid = crypto.randomUUID()
    const t0 = performance.now()
    const out: number[] = []
    this.toks.set(rid, (xs) => xs.forEach((x) => (out.push(x), o.onToken(x))))
    const res = this.once(`res:${rid}`)
    this.w.postMessage({
      t: 'gen',
      rid,
      conv: o.conv,
      ids,
      maxNew: o.maxNew,
      temp: o.temp,
      prefillOnly: o.prefillOnly,
    })
    const m = await res
    this.toks.delete(rid)
    if (m.err) throw new Error(String(m.err))
    return {
      tokens: out,
      tps: m.tps as number,
      firstMs: m.firstMs as number,
      reused: m.reused as number,
      totalMs: performance.now() - t0,
    }
  }
}

export const localLM = new LocalLM()
