/** Motyw wyglądu: ciemny domyślnie, jasny na życzenie (zapamiętany w localStorage `myc.theme`). */
export type Theme = 'dark' | 'light'
const KEY = 'myc.theme'
const subs = new Set<() => void>()

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}
export function applyTheme(t: Theme = getTheme()) {
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f3f7f5' : '#03080a')
}
export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* tryb prywatny */
  }
  applyTheme(t)
  subs.forEach((f) => f())
}
export const themeStore = {
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: getTheme,
}
