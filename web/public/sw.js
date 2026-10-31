// Service worker Mycelium AI: instalacja jako aplikacja i praca offline (powłoka strony).
// Strategia: sieć najpierw (zawsze świeża wersja), pamięć podręczna tylko gdy brak sieci. Dane (Supabase) nie są cache'owane.
const CACHE = 'myc-shell-v3'
// Izolacja (COOP/COEP) dla modelu w przeglądarce: GitHub Pages nie ustawia tych nagłówków, więc dokłada je ten SW –
// tylko gdy użytkownik sam włączył model grzybni (znacznik w Cache Storage 'myc-coi'). Wtedy WASM liczy na wszystkich
// rdzeniach (SharedArrayBuffer). Inne wizyty są bez zmian. 'credentialless' nie blokuje obrazków/API z innych domen.
const COI = 'myc-coi'
const coiOn = () => caches.open(COI).then((c) => c.match('on')).then((r) => !!r).catch(() => false)
function isolate(r) {
  if (!r || r.status === 0 || r.type === 'opaque') return r
  const h = new Headers(r.headers)
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  h.set('Cross-Origin-Embedder-Policy', 'credentialless')
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h })
}
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
  // dokument i skrypty wątków roboczych (worker bez COEP nie dostałby SharedArrayBuffer)
  const nav = (e.request.mode === 'navigate' || e.request.destination === 'worker') && !u.searchParams.has('embed')
  e.respondWith(
    (nav ? coiOn() : Promise.resolve(false)).then((iso) =>
    fetch(e.request)
      .then((r) => {
        if (r.ok && (e.request.mode === 'navigate' || /\/assets\//.test(u.pathname))) {
          const c = r.clone()
          caches.open(CACHE).then((x) => x.put(e.request, c)).catch(() => undefined)
        }
        return r
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('./')))
      .then((r) => (iso ? isolate(r) : r)),
    ),
  )
})
