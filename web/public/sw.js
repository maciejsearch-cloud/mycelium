// Service worker Mycelium AI: instalacja jako aplikacja i praca offline (powłoka strony).
// Strategia: sieć najpierw (zawsze świeża wersja), pamięć podręczna tylko gdy brak sieci. Dane (Supabase) nie są cache'owane.
const CACHE = 'myc-shell-v2'
self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './favicon.svg', './icon.svg', './icon-192.png', './manifest.webmanifest'])).catch(() => undefined))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== location.origin) return
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && (e.request.mode === 'navigate' || /\/assets\//.test(u.pathname))) {
          const c = r.clone()
          caches.open(CACHE).then((x) => x.put(e.request, c)).catch(() => undefined)
        }
        return r
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('./'))),
  )
})
