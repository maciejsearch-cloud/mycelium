// Pomiar szybkości czatu na grzybni (ręczny, nie w CI):
//   node scripts/chat-speed.mjs <url> [węzły_przeglądarkowe=0] [fragmenty_na_węzeł=4] [zrzut.png]
// Węzły: N osobnych kontekstów przeglądarki (bez logowania) + jeden klient czatu. Dwa pytania pod rząd
// (drugie korzysta z pamięci K/V rozmowy). Wypisuje JSON z prawdziwymi pomiarami z interfejsu.
import { chromium } from '@playwright/test'

const url = process.argv[2] ?? 'http://localhost:4205/'
const N = Number(process.argv[3] ?? 0)
const CAP = Number(process.argv[4] ?? 4)
const shot = process.argv[5] ?? '/tmp/chat-speed.png'
const Qs = (process.env.QS ?? 'Jaka jest stolica Polski? Odpowiedz jednym zdaniem.|A co to jest fotosynteza? Wyjaśnij w dwóch zdaniach.').split('|')
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] })
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)
for (let i = 0; i < N; i++) {
  const p = await (await browser.newContext()).newPage()
  p.on('pageerror', (e) => log(`node${i} pageerror`, String(e).slice(0, 160)))
  await p.goto(`${url}?shard=${CAP}${process.env.BACKEND ? `&backend=${process.env.BACKEND}` : ''}#/chat`)
}
const c = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage()
c.on('pageerror', (e) => log('client pageerror', String(e).slice(0, 160)))
c.on('console', (m) => m.type() === 'error' && log('client console', m.text().slice(0, 160)))
await c.goto(`${url}#/chat`)
const st = c.getByTestId('mesh-status')
for (;;) {
  if ((await st.getAttribute('data-full')) === '1') break
  if (Date.now() - t0 > 30 * 60_000) throw new Error('timeout ładowania')
  await c.waitForTimeout(5000)
}
log('grzybnia gotowa:', (await st.innerText()).replace(/\s+/g, ' ').slice(0, 120))
if (process.env.WAIT_FULL_NODES) await c.waitForFunction((n) => (globalThis.mycMesh?.view.fullNodes.length ?? 0) >= n, Number(process.env.WAIT_FULL_NODES), { timeout: 120000 })
const res = []
for (const [i, q] of Qs.entries()) {
  await c.getByTestId('chat-input').fill(q)
  await c.getByTestId('chat-send').click()
  const n0 = i
  await c.waitForFunction((n) => { const s = [...document.querySelectorAll('[data-testid=turn-stats]')]; return s.length > n && /tok\/s|niedostępny|unavailable| ms$/.test(s[n].textContent) }, n0, { timeout: Number(process.env.Q_TIMEOUT ?? 900000) }).catch(async (e) => { await c.screenshot({ path: shot.replace('.png', `-stuck${i}.png`), fullPage: true }); throw e })
  const v = await c.evaluate(() => ({ tps: globalThis.mycMesh.view.tps, firstMs: globalThis.mycMesh.view.firstMs, route: globalThis.mycMesh.view.lastRoute?.map((r) => `${r.shard}@${r.node.slice(0, 4)}:${r.link}`).join(' ') }))
  const r = { q, reply: await c.getByTestId('reply').last().innerText(), stats: await c.getByTestId('turn-stats').nth(i).innerText(), ...v }
  log(JSON.stringify(r))
  res.push(r)
}
await c.screenshot({ path: shot, fullPage: true })
console.log('RESULT ' + JSON.stringify({ nodes: N, cap: CAP, fullNodes: await c.evaluate(() => globalThis.mycMesh.view.fullNodes.length), res }))
await browser.close()
