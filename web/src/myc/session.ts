// Tryb „Start sesji” (w stylu Pi Network, ale bez kryptowalut): dobrowolny wkład mocy obliczeniowej.
// Sesja (24 h, seria dni) steruje pulą obliczeń: GPU (WebGPU/WebGL) + N workerów WASM pobiera zadania
// z kolejki grzybni (Supabase), trenuje prawdziwe modele i oddaje skompresowane aktualizacje.
import { pool } from '../compute/pool'

export const SESSION_MS = 24 * 3600_000
const day = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })
export function streakOf(days: string[], now = Date.now()): number {
  const set = new Set(days)
  let d = now
  if (!set.has(day(d))) d -= 86400_000
  let n = 0
  while (set.has(day(d))) {
    n++
    d -= 86400_000
  }
  return n
}

interface Saved {
  start: number
  days: string[]
  throttle: number
}
const load = (): Saved => {
  try {
    return { start: 0, days: [], throttle: 0.5, ...JSON.parse(localStorage.getItem('myc.session') ?? '{}') }
  } catch {
    return { start: 0, days: [], throttle: 0.5 }
  }
}

class Session {
  s: Saved = load()
  running = false
  paused = false
  reason = ''
  version = 0
  private subs = new Set<() => void>()
  private battTimer?: ReturnType<typeof setInterval>

  constructor() {
    pool.subscribe(() => this.emit())
  }
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    for (const f of this.subs) f()
  }
  private save() {
    localStorage.setItem('myc.session', JSON.stringify(this.s))
  }

  get active() {
    return this.s.start > 0 && Date.now() - this.s.start < SESSION_MS
  }
  get remaining() {
    return Math.max(0, this.s.start + SESSION_MS - Date.now())
  }
  get streak() {
    return streakOf(this.s.days)
  }

  start() {
    if (!this.active) {
      this.s.start = Date.now()
      const d = day(Date.now())
      if (!this.s.days.includes(d)) this.s.days = [...this.s.days, d].slice(-400)
      this.save()
    }
    this.paused = false
    this.resume()
  }
  /** Limit mocy CPU (10–100%): liczba workerów WASM i cykl pracy. */
  setThrottle(t: number) {
    this.s.throttle = Math.min(1, Math.max(0.1, t))
    this.save()
    pool.setSettings({ cpu: this.s.throttle })
    this.emit()
  }
  setGpu(on: boolean) {
    pool.setSettings({ gpu: on })
  }
  pause(reason = '') {
    this.paused = !reason || reason === 'battery'
    this.reason = reason
    this.running = false
    pool.pause(true)
    this.emit()
  }
  /** Wznów, jeśli sesja trwa, karta jest widoczna i nie wstrzymano ręcznie. */
  resume() {
    if (!this.active || this.paused || document.visibilityState !== 'visible') return
    this.reason = ''
    this.running = true
    if (pool.settings.cpu !== this.s.throttle) pool.setSettings({ cpu: this.s.throttle })
    if (pool.running) pool.pause(false)
    else pool.start()
    this.battTimer ??= setInterval(() => void this.checkBattery(), 60_000)
    void this.checkBattery()
    // zadanie w tle: strzępki wiedzy (ekstrakcja z konsensusu, łączenie podobnych pojęć osadzeniami MiniLM)
    void import('./fragjob').then((m) => m.fragJob.start())
    this.emit()
  }

  private async checkBattery() {
    if (!this.running) return
    try {
      const nav = navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean }> }
      const b = await nav.getBattery?.()
      if (b && !b.charging && b.level < 0.2) this.pause('battery')
    } catch {
      /* brak API baterii */
    }
    if (!this.active && this.running) {
      this.pause('expired')
      pool.stop()
    }
  }
}

export const session = new Session()

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && session.running) session.pause('hidden')
    else if (document.visibilityState === 'visible' && session.reason === 'hidden') session.resume()
  })
}
