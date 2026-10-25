// Koordynator obliczeń w wątku głównym: pula Web Workerów (GPU + N× WASM), kolejka zadań w Supabase
// (dzierżawa + limit czasu), publikacja rund, agregacja i wersjonowanie modelu globalnego.
import { SB_KEY, SB_URL, ids } from '../myc/store'
import { DEFAULT_HP, MODELS, ROUND_TRAIN, archOf, type Backend, type BackendInfo, type DataMeta, type Hyper, type JobMsg, type JobOut, type ModelId } from './specs'

export interface ModelRow {
  model: ModelId
  version: number
  path: string
  acc: number | null
  val_acc: number | null
  n_updates: number
  n_rejected: number
  samples: number
  flops: number
  meta: { arch?: string; hp?: Hyper; flops?: number; params?: number; algo?: string; server_lr?: number; rejected?: { id: number; why: string }[]; agg_ms?: number }
  created_at: string
}
export interface BenchRow extends BackendInfo {
  sps: number
  gflops: number
}
interface Slot {
  w: Worker
  role: 'gpu' | 'cpu'
  info?: BackendInfo
  busy: boolean
  booting?: boolean
  dead?: boolean
  job?: string
  rid: number
  pending: Map<number, [(v: unknown) => void, (e: Error) => void]>
}
export interface LogRow {
  at: string
  what: string
  backend?: Backend
  ok: boolean
}

const REST = `${SB_URL}/rest/v1`
const H = { apikey: SB_KEY, 'Content-Type': 'application/json' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** fetch z ponowieniami (wykładniczo: 0,5 s, 1 s, 2 s, 4 s) przy błędzie sieci, 429 i 5xx. */
export async function fetchRetry(url: string, init: RequestInit = {}, tries = 5): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init)
      if (r.status !== 429 && r.status < 500) return r
      if (i >= tries - 1) return r
    } catch (e) {
      if (i >= tries - 1) throw e
    }
    await sleep(500 * 2 ** i)
  }
}
async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetchRetry(REST + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } }, 3)
  const txt = await r.text()
  if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 160)}`)
  return (txt ? JSON.parse(txt) : null) as T
}
type Gate = { ok: boolean; reason?: string; version?: number; cur_acc?: number; latest?: number }
const rpc = <T>(fn: string, args: Record<string, unknown>) => rest<T>(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) })
export const weightUrl = (path: string) => `${SB_URL}/storage/v1/object/public/myc-models/${path}`
const LSK = 'myc.compute'

export class ComputePool {
  slots: Slot[] = []
  running = false
  paused = false
  settings: { cpu: number; gpu: boolean } = { cpu: 0.5, gpu: true, ...JSON.parse(localStorage.getItem(LSK) ?? '{}') }
  bench: BenchRow[] = JSON.parse(localStorage.getItem('myc.bench') ?? '[]')
  local = { jobs: 0, samples: 0, flops: 0, busyMs: 0, gpuFlops: 0, byBackend: {} as Record<string, { samples: number; busy: number; flops: number }> }
  log: LogRow[] = []
  error = ''
  private coordBusy = false
  /** architektura danych tej strony (meta.json) i modele, których ostatnia wersja ma tę samą architekturę */
  private dataArch?: Record<ModelId, string>
  /** liczba odłamków treningowych z meta.json (np. Fashion-MNIST: 60 = cały oficjalny trening) */
  private dataShards?: Record<ModelId, number>
  private compat: ModelId[] = []
  private async refreshCompat() {
    if (!this.dataArch) {
      const md = (await (await fetchRetry(`${import.meta.env.BASE_URL}data/ml/meta.json`)).json()) as Record<ModelId, DataMeta>
      this.dataArch = Object.fromEntries(MODELS.map((m) => [m, archOf(md[m])])) as Record<ModelId, string>
      this.dataShards = Object.fromEntries(MODELS.map((m) => [m, md[m].shards])) as Record<ModelId, number>
    }
    const rows = await rest<ModelRow[]>(`/myc_models?select=model,version,meta&order=version.desc&limit=40`)
    this.compat = MODELS.filter((m) => {
      const cur = rows.find((r) => r.model === m)
      return !cur || archOf(cur.meta) === this.dataArch![m]
    })
  }
  private lastCoord = 0
  private subs = new Set<() => void>()
  version = 0
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.version
  emit() {
    this.version++
    for (const f of this.subs) f()
  }
  private note(what: string, ok = true, backend?: Backend) {
    this.log = [{ at: new Date().toISOString(), what, ok, backend }, ...this.log].slice(0, 40)
    this.emit()
  }

  get cpuWorkers() {
    const hc = navigator.hardwareConcurrency || 2
    return Math.max(1, Math.round(Math.max(1, hc - 1) * this.settings.cpu))
  }
  get duty() {
    // przy 100% pracuje bez przerw; poniżej – cykl pracy (mniej ciepła, mniej wentylatora)
    return this.settings.cpu >= 0.99 ? 1 : 0.85
  }
  setSettings(s: Partial<{ cpu: number; gpu: boolean }>) {
    this.settings = { ...this.settings, ...s }
    localStorage.setItem(LSK, JSON.stringify(this.settings))
    if (this.running) void this.resize()
    this.emit()
  }

  private call<T>(s: Slot, op: string, args: Record<string, unknown> = {}, tr: Transferable[] = []): Promise<T> {
    const rid = ++s.rid
    return new Promise<T>((res, rej) => {
      s.pending.set(rid, [res as (v: unknown) => void, rej])
      s.w.postMessage({ rid, op, ...args }, tr)
    })
  }
  private spawn(role: 'gpu' | 'cpu'): Slot {
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    const s: Slot = { w, role, busy: false, rid: 0, pending: new Map() }
    w.onmessage = (e) => {
      const p = s.pending.get(e.data.rid)
      if (!p) return
      s.pending.delete(e.data.rid)
      if (e.data.ok) p[0](e.data.out)
      else p[1](new Error(e.data.error))
    }
    w.onerror = (e) => {
      for (const [, [, rej]] of s.pending) rej(new Error(e.message || 'worker error'))
      s.pending.clear()
    }
    return s
  }

  private async resize() {
    const wantGpu = this.settings.gpu ? 1 : 0
    const wantCpu = this.cpuWorkers
    // GPU: jeden worker (WebGPU → WebGL); CPU: N workerów WASM (każdy na innym rdzeniu)
    for (const s of this.slots.filter((x) => x.role === 'gpu').slice(wantGpu)) this.kill(s)
    for (const s of this.slots.filter((x) => x.role === 'cpu').slice(wantCpu)) this.kill(s)
    const add: Slot[] = []
    if (!this.slots.some((x) => x.role === 'gpu') && wantGpu) add.push(this.spawn('gpu'))
    for (let i = this.slots.filter((x) => x.role === 'cpu').length; i < wantCpu; i++) add.push(this.spawn('cpu'))
    this.slots.push(...add)
    for (const s of add) void this.boot(s)
    for (const s of this.slots) void this.call(s, 'ctl', { duty: this.duty }).catch(() => {})
    this.emit()
  }
  private kill(s: Slot) {
    // przerwanie ładowania skryptu workera daje „net::ERR_ABORTED” – kończymy go dopiero po starcie
    s.dead = true
    if (!s.booting) s.w.terminate()
    this.slots = this.slots.filter((x) => x !== s)
  }

  private async boot(s: Slot) {
    s.booting = true
    try {
      s.info = await this.call<BackendInfo>(s, 'init', { prefer: s.role === 'gpu' ? ['webgpu', 'webgl'] : ['wasm', 'cpu'] })
      s.booting = false
      if (s.dead) return s.w.terminate()
      await this.call(s, 'ctl', { duty: this.duty, paused: this.paused })
      this.emit()
      if (s.role === 'gpu' || this.slots.filter((x) => x.role === 'cpu')[0] === s) await this.measure(s)
      void this.loop(s)
    } catch (e) {
      this.note(`${s.role}${s.info ? ` ${s.info.backend}` : ''}: ${(e as Error).message.slice(0, 140)}`, false)
      // WebGPU zawiódł w praktyce (np. limity bufora) → ten sam wątek próbuje WebGL
      if (s.role === 'gpu' && s.info?.backend === 'webgpu') {
        try {
          s.info = await this.call<BackendInfo>(s, 'init', { prefer: ['webgl'] })
          this.emit()
          await this.measure(s)
          void this.loop(s)
          return
        } catch (e2) {
          this.note(`gpu webgl: ${(e2 as Error).message.slice(0, 140)}`, false)
        }
      }
      s.booting = false
      this.kill(s)
      this.emit()
    } finally {
      if (s.booting) {
        s.booting = false
        if (s.dead) s.w.terminate()
      }
    }
  }

  /** Pomiar przepustowości (CNN Fashion-MNIST, 3 s): próbki/s i GFLOPS na tym backendzie. */
  async measure(s: Slot) {
    const r = await this.call<BenchRow>(s, 'bench', { model: 'fashion', seconds: 3 })
    this.bench = [r, ...this.bench.filter((b) => b.backend !== r.backend)]
    localStorage.setItem('myc.bench', JSON.stringify(this.bench))
    this.note(`pomiar ${r.backend}: ${r.sps} próbek/s, ${r.gflops} GFLOPS`, true, r.backend)
  }

  start() {
    this.running = true
    this.paused = false
    void this.resize()
    for (const s of this.slots) void this.call(s, 'ctl', { paused: false }).catch(() => {})
  }
  pause(p: boolean) {
    this.paused = p
    for (const s of this.slots) void this.call(s, 'ctl', { paused: p }).catch(() => {})
    this.emit()
  }
  stop() {
    this.running = false
    for (const s of [...this.slots]) this.kill(s)
    this.emit()
  }

  async latest(m: ModelId): Promise<ModelRow | undefined> {
    return (await rest<ModelRow[]>(`/myc_models?model=eq.${m}&order=version.desc&limit=1`))[0]
  }

  private async loop(s: Slot) {
    while (this.running && this.slots.includes(s)) {
      if (this.paused) {
        await sleep(1000)
        continue
      }
      try {
        if (!this.dataArch) await this.refreshCompat()
        const [job] = await rpc<(JobMsg & { status: string })[]>('myc_claim', { p_node: ids.node, p_models: this.compat, p_kinds: ['reeval', 'verify', 'train', 'hparam', 'eval', 'label'] })
        if (!job) {
          await this.coordinate(s)
          await sleep(3000 + (s.rid % 4) * 1000)
          continue
        }
        s.busy = true
        s.job = `${job.kind} ${job.model} v${job.version}`
        this.emit()
        // ponowna ocena kandydata: wagi kandydata (jeszcze nie ma go w myc_models)
        const mrow = job.kind === 'reeval' ? ({ path: String(job.params.path) } as ModelRow) : (await rest<ModelRow[]>(`/myc_models?model=eq.${job.model}&version=eq.${job.version}`))[0]
        if (!mrow) throw new Error('brak wersji modelu')
        let deltaB64: string | undefined
        if (job.kind === 'verify') {
          const [r] = await rest<{ payload: string | null }[]>(`/myc_results?id=eq.${job.params.result}&select=payload`)
          deltaB64 = r?.payload ?? undefined
        }
        const out = await this.call<JobOut>(s, 'job', { job: { ...job, baseUrl: weightUrl(mrow.path), deltaB64 } })
        const rid = await rpc<number>('myc_submit', { p_job: job.id, p_node: ids.node, p_contrib: ids.contributor, p_payload: out.payload ?? null, p_metrics: out.metrics, p_samples: out.samples, p_flops: out.flops, p_ms: out.ms, p_backend: s.info!.backend })
        if (rid === -1) {
          this.note(`${job.kind} ${job.model} v${job.version}: dzierżawa wygasła, wynik pominięty`, false)
          continue
        }
        const b = s.info!.backend
        this.local.jobs++
        this.local.samples += out.samples
        this.local.flops += out.flops
        this.local.busyMs += out.busy
        if (b === 'webgpu' || b === 'webgl') this.local.gpuFlops += out.flops
        const bb = (this.local.byBackend[b] ??= { samples: 0, busy: 0, flops: 0 })
        bb.samples += out.samples
        bb.busy += out.busy
        bb.flops += out.flops
        const acc = out.metrics.val_acc ?? out.metrics.acc
        this.note(`${job.kind} ${job.model} v${job.version}: ${out.samples} próbek, ${(out.busy / 1000).toFixed(1)} s${acc != null ? `, ${(+acc * 100).toFixed(1)}%` : ''}`, true, b)
      } catch (e) {
        this.note(`${s.job ?? 'zadanie'}: ${(e as Error).message.slice(0, 120)}`, false, s.info?.backend)
        await sleep(5000)
      } finally {
        s.busy = false
        s.job = undefined
        this.emit()
      }
    }
  }

  /** Koordynacja (każdy węzeł może ją wykonać; baza pilnuje, by wersja/runda powstała tylko raz). */
  private async coordinate(s: Slot) {
    if (this.coordBusy || Date.now() - this.lastCoord < 8_000) return
    this.coordBusy = true
    this.lastCoord = Date.now()
    try {
      await this.refreshCompat()
      for (const m of this.compat) {
        const cur = await this.latest(m)
        if (!cur) {
          await this.createV0(s, m)
          continue
        }
        // runda trwa, gdy są otwarte zadania treningowe albo oczekujące wyniki; po odrzuceniu przez bramkę – kolejna runda tej wersji
        const [live, pend] = await Promise.all([
          rest<{ id: number }[]>(`/myc_jobs?model=eq.${m}&version=eq.${cur.version}&kind=eq.train&status=in.(open,leased)&select=id&limit=1`),
          rest<{ id: number }[]>(`/myc_results?model=eq.${m}&version=eq.${cur.version}&kind=in.(train,hparam)&status=eq.pending&select=id&limit=1`),
        ])
        if (!live.length && !pend.length) {
          await this.postRound(cur)
          continue
        }
        await this.maybeAggregate(s, cur)
      }
    } catch (e) {
      this.note(`koordynacja: ${(e as Error).message.slice(0, 120)}`, false)
    } finally {
      this.coordBusy = false
    }
  }

  private async upload(m: ModelId, version: number, w: Float32Array): Promise<string> {
    // ścieżka adresowana treścią (FNV-1a wag): duplikat = identyczne wagi, więc można go bezpiecznie użyć
    const u8 = new Uint8Array(w.buffer, w.byteOffset, w.byteLength)
    let h = 2166136261
    for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619)
    const path = `${m}/v${version}-${(h >>> 0).toString(16).padStart(8, '0')}.bin`
    if (await rpc<boolean>('myc_weights_exist', { p_path: path })) return path
    const r = await fetchRetry(`${SB_URL}/storage/v1/object/myc-models/${path}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/octet-stream' }, body: new Blob([u8 as BlobPart]) })
    if (!r.ok) {
      const t = await r.text()
      if (!(r.status === 409 || /duplicate|already exists/i.test(t))) throw new Error(`upload ${r.status} ${t.slice(0, 100)}`)
    }
    return path
  }

  private async createV0(s: Slot, m: ModelId) {
    const res = await rpc<Gate>('myc_reserve', { p_node: ids.node, p_model: m, p_expected: -1 })
    if (!res.ok) return
    const r = await this.call<{ weights: Float32Array; val: number; acc: number; params: number; flops: number; evalN: number; evalSha: string }>(s, 'initModel', { model: m })
    const path = await this.upload(m, 0, r.weights)
    const g = await rpc<Gate>('myc_propose', { p_node: ids.node, p_model: m, p_version: 0, p_path: path, p_acc: r.acc, p_val: r.val, p_eval_n: r.evalN, p_eval_sha: r.evalSha, p_meta: { arch: this.dataArch?.[m] ?? 'v1', hp: DEFAULT_HP[m], flops: r.flops, params: r.params, algo: 'init' }, p_accepted: [], p_rejected: [] })
    if (g.ok) this.note(`${m}: kandydat v0 (losowa inicjalizacja, ${(r.acc * 100).toFixed(1)}%)`)
  }

  private async postRound(cur: ModelRow) {
    const m = cur.model
    // lr/μ dziedziczone ze strojenia (meta wersji), epoki i kompresja z bieżącej konfiguracji
    const hp = { ...DEFAULT_HP[m], lr: cur.meta.hp?.lr ?? DEFAULT_HP[m].lr, mu: cur.meta.hp?.mu ?? DEFAULT_HP[m].mu }
    const F = cur.meta.flops ?? 2e6
    const shards = this.dataShards?.[m] || { fashion: 24, har: 14, intent: 15, words: 11 }[m]
    const R = ROUND_TRAIN[m]
    // kolejna runda tej samej wersji (po odrzuceniu przez bramkę) bierze następne odłamki
    const prev = await rest<{ id: number }[]>(`/myc_jobs?model=eq.${m}&version=eq.${cur.version}&kind=eq.train&select=id`)
    const off = cur.version * R + prev.length + Math.floor(prev.length / R) * 2
    const tp = { ...hp, flops_per_sample: 3 * F }
    const jobs: { kind: string; params: Record<string, unknown> }[] = []
    for (let i = 0; i < R; i++) jobs.push({ kind: 'train', params: { ...tp, shard: (off + i) % shards } })
    // próby hiperparametrów: lr ×0.5 i ×2 na kolejnych odłamkach
    jobs.push({ kind: 'hparam', params: { ...tp, lr: +(hp.lr / 2).toPrecision(3), shard: (off + R) % shards } })
    jobs.push({ kind: 'hparam', params: { ...tp, lr: +(hp.lr * 2).toPrecision(3), shard: (off + R + 1) % shards } })
    jobs.push({ kind: 'eval', params: { flops_per_sample: F } })
    if (m === 'fashion' && cur.version % 5 === 0 && !prev.length) jobs.push({ kind: 'label', params: { flops_per_sample: F } })
    const n = await rpc<number>('myc_post_round', { p_node: ids.node, p_model: m, p_version: cur.version, p_jobs: jobs })
    if (n > 0) this.note(`${m} v${cur.version}: ogłoszono rundę${prev.length ? ' (powtórka po bramce)' : ''} (${n} zadań)`)
  }

  private async maybeAggregate(s: Slot, cur: ModelRow) {
    const m = cur.model
    // najpierw same metadane (bez ładunków ~70 kB–1 MB każdy) – ten odczyt powtarza się przy każdym sprawdzeniu rundy
    const pend = await rest<{ id: number; kind: string; metrics: { val_acc?: number; n?: number; lr?: number }; node_id: string; created_at: string }[]>(
      `/myc_results?model=eq.${m}&version=eq.${cur.version}&kind=in.(train,hparam)&status=eq.pending&payload=not.is.null&select=id,kind,metrics,node_id,created_at&order=id`,
    )
    const train = pend.filter((p) => p.kind === 'train')
    const open = await rest<{ id: number }[]>(`/myc_jobs?model=eq.${m}&version=eq.${cur.version}&kind=eq.train&status=in.(open,leased)&select=id`)
    // czekamy na 75% rundy; przy zawieszonych dzierżawach – najwyżej 2 min od pierwszego wyniku
    const waited = train.length ? Date.now() - Date.parse(train[0].created_at) : 0
    if (train.length < 3 || (open.length > 0 && train.length < Math.ceil(ROUND_TRAIN[m] * 0.75) && waited < 120_000)) return
    const ver = await rest<{ metrics: { result?: number; acc?: number } }[]>(`/myc_results?model=eq.${m}&version=eq.${cur.version}&kind=eq.verify&select=metrics`)
    const vmap = new Map<number, number[]>()
    for (const v of ver) if (v.metrics.result != null && v.metrics.acc != null) vmap.set(v.metrics.result, [...(vmap.get(v.metrics.result) ?? []), v.metrics.acc])
    // aktualizacje z prób hiperparametrów też są prawdziwym treningiem – trafiają do agregacji po tej samej walidacji
    // CAS: tylko jeden węzeł agreguje i publikuje wersję v+1 (bez wyścigu → bez 400/409)
    const res = await rpc<Gate>('myc_reserve', { p_node: ids.node, p_model: m, p_expected: cur.version })
    if (!res.ok) return
    // ładunki dopiero po rezerwacji i stronami (po 8), żeby żadne zapytanie nie niosło całej rundy naraz
    const pay = new Map<number, string>()
    for (let i = 0; i < pend.length; i += 8) {
      const part = await rest<{ id: number; payload: string | null }[]>(`/myc_results?id=in.(${pend.slice(i, i + 8).map((p) => p.id).join(',')})&select=id,payload`)
      for (const r of part) if (r.payload) pay.set(r.id, r.payload)
    }
    const ups = pend.filter((p) => pay.has(p.id)).map((p) => ({ id: p.id, kind: p.kind, payload: pay.get(p.id)!, n: p.metrics.n ?? 1, claimed: p.metrics.val_acc ?? 0, verified: vmap.get(p.id) ?? [] }))
    this.note(`${m} v${cur.version}: agreguję ${ups.length} aktualizacji`)
    const r = await this.call<{ ok: boolean; verdict: { id: number; ok: boolean; why: string; acc: number }[]; val?: number; acc?: number; serverLr?: number; weights?: Float32Array; ms: number; baseVal: number; evalN: number; evalSha: string }>(s, 'aggregate', { model: m, baseUrl: weightUrl(cur.path), ups })
    if (!r.ok || !r.weights) {
      this.note(`${m} v${cur.version}: za mało poprawnych aktualizacji (${r.verdict.filter((v) => v.ok).length})`, false)
      return
    }
    // strojenie: lr z najlepszej próby, jeśli lepsza od średniej treningu o > 0,5 pkt
    const hp = { ...(cur.meta.hp ?? DEFAULT_HP[m]) }
    // ciepły restart: lr nie spada poniżej 1/16 domyślnego (strojenie wybierało ×0,5 runda po rundzie)
    if (hp.lr < DEFAULT_HP[m].lr / 16) hp.lr = +(DEFAULT_HP[m].lr / 4).toPrecision(3)
    const accOf = (k: string) => r.verdict.filter((v) => pend.find((p) => p.id === v.id)?.kind === k && v.ok)
    const tAcc = accOf('train').reduce((a, v) => a + v.acc, 0) / Math.max(1, accOf('train').length)
    const bestH = accOf('hparam').sort((a, b) => b.acc - a.acc)[0]
    if (bestH && bestH.acc > tAcc + 0.005) hp.lr = pend.find((p) => p.id === bestH.id)?.metrics.lr ?? hp.lr
    const path = await this.upload(m, cur.version + 1, r.weights)
    const acc = r.verdict.filter((v) => v.ok).map((v) => v.id)
    const rej = r.verdict.filter((v) => !v.ok)
    const g = await rpc<Gate>('myc_propose', {
      p_node: ids.node, p_model: m, p_version: cur.version + 1, p_path: path, p_acc: r.acc, p_val: r.val, p_eval_n: r.evalN, p_eval_sha: r.evalSha,
      p_meta: { arch: archOf(cur.meta), hp, flops: cur.meta.flops, params: cur.meta.params, algo: hp.mu > 0 ? 'FedProx' : 'FedAvg', server_lr: r.serverLr, rejected: rej.map((v) => ({ id: v.id, why: v.why.slice(0, 80) })).slice(0, 10), agg_ms: Math.round(r.ms) },
      p_accepted: acc, p_rejected: rej.map((v) => v.id),
    })
    if (g.ok) this.note(`${m} v${cur.version + 1}: kandydat ${(r.acc! * 100).toFixed(1)}% na teście (przyjęte ${acc.length}, odrzucone ${rej.length}) – czeka na niezależną ocenę innych węzłów`)
    else if (/regression/.test(g.reason ?? '')) this.note(`${m} v${cur.version + 1}: bramka odrzuciła (${(r.acc! * 100).toFixed(1)}% < ${((g.cur_acc ?? 0) * 100).toFixed(1)}%), nowa runda`, false)
    else this.note(`${m} v${cur.version + 1}: publikacja pominięta (${g.reason})`, false)
  }
}

export const pool = new ComputePool()
