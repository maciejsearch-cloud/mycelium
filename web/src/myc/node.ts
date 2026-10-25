// „Zostań węzłem”: zgoda zapamiętana w przeglądarce → sesja wznawia się sama po otwarciu strony,
// Wake Lock trzyma ekran włączony w trakcie pracy, instalacja jako aplikacja (PWA).
import { session } from './session'

const KEY = 'myc.autoNode'
type WakeLockSentinel = { released: boolean; release: () => Promise<void>; addEventListener: (t: 'release', f: () => void) => void }
type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

class NodeMode {
  version = 0
  wake: 'off' | 'on' | 'unsupported' | 'denied' = 'off'
  installable = false
  installed = typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches
  private lock?: WakeLockSentinel
  private bip?: BIPEvent
  private subs = new Set<() => void>()
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    for (const f of this.subs) f()
  }
  get on() {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  }
  /** Włącz tryb węzła (zgoda użytkownika): start sesji + Wake Lock + auto-wznawianie. */
  enable() {
    localStorage.setItem(KEY, '1')
    session.start()
    void this.acquire()
    this.emit()
  }
  disable() {
    localStorage.removeItem(KEY)
    session.pause()
    void this.lock?.release().catch(() => undefined)
    this.lock = undefined
    this.wake = 'off'
    this.emit()
  }
  /** Wywoływane przy starcie aplikacji: wznów, jeśli wcześniej zgodzono się być węzłem. */
  autoResume() {
    if (!this.on) return
    session.start()
    void this.acquire()
  }
  async acquire() {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinel> } }).wakeLock
    if (!wl) {
      this.wake = 'unsupported'
      return this.emit()
    }
    if (!this.on || document.visibilityState !== 'visible' || (this.lock && !this.lock.released)) return
    try {
      this.lock = await wl.request('screen')
      this.wake = 'on'
      this.lock.addEventListener('release', () => {
        this.wake = 'off'
        this.emit()
      })
    } catch {
      this.wake = 'denied'
    }
    this.emit()
  }
  async install() {
    if (!this.bip) return false
    await this.bip.prompt()
    const r = await this.bip.userChoice
    this.bip = undefined
    this.installable = false
    if (r.outcome === 'accepted') this.installed = true
    this.emit()
    return r.outcome === 'accepted'
  }
  /** Rejestracja: service worker (offline + instalacja), przechwycenie monitu instalacji, Wake Lock po powrocie do karty. */
  init(swUrl: string, sw = true) {
    if (typeof window === 'undefined') return
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault()
      this.bip = e as BIPEvent
      this.installable = true
      this.emit()
    })
    addEventListener('appinstalled', () => {
      this.installed = true
      this.installable = false
      this.emit()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.acquire()
    })
    if (sw && 'serviceWorker' in navigator && location.protocol === 'https:') void navigator.serviceWorker.register(swUrl).catch(() => undefined)
    this.autoResume()
  }
}

export const nodeMode = new NodeMode()
