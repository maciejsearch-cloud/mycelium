// Ręczny test grzybni-modelu (nie w CI – pobiera ~1 GB z Hugging Face):
//   node scripts/mesh-check.mjs <url> [węzły=3] [fragmenty_na_węzeł=4] [pytanie]
// Uruchamia N niezależnych przeglądarek (bez logowania) jako węzły z fragmentami i jedną jako klienta czatu.
import { chromium } from '@playwright/test'

const url = process.argv[2] ?? 'http://localhost:4198/'
const N = Number(process.argv[3] ?? 3)
const CAP = Number(process.argv[4] ?? 4)
const Q = process.argv[5] ?? 'Jak działa grzybnia w lesie? Odpowiedz w dwóch zdaniach.'
const shot = process.argv[6] ?? '/tmp/mesh-chat.png'
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] })
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)
const nodes = []
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  p.on('pageerror', (e) => log(`node${i} pageerror`, String(e).slice(0, 200)))
  p.on('console', (m) => m.type() === 'error' && log(`node${i} console`, m.text().slice(0, 200)))
  await p.goto(`${url}?shard=${CAP}${process.env.BACKEND ? `&backend=${process.env.BACKEND}` : ''}#/chat`)
  nodes.push(p)
}
const cctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
const c = await cctx.newPage()
c.on('pageerror', (e) => log('client pageerror', String(e).slice(0, 200)))
c.on('console', (m) => ['error', 'warning'].includes(m.type()) && log('client console', m.text().slice(0, 200)))
await c.goto(`${url}#/chat`)
const st = c.getByTestId('mesh-status')
for (;;) {
  const r = await st.getAttribute('data-ready')
  log('fragmenty gotowe', r, '/ 12', await st.innerText().then((t) => t.replace(/\s+/g, ' ').slice(0, 160)))
  for (const [i, p] of nodes.entries())
    log(`  node${i}`, await p.evaluate(() => { const m = globalThis.mycMesh; return m ? JSON.stringify({ c: m.view.connected, pres: m.net?.presence.size, local: Object.fromEntries(Object.entries(m.view.local?.shards ?? {}).map(([k, v]) => [k, v.state + ':' + Math.round(v.loaded / 1e6) + (v.err ? ':' + v.err : '')])), be: m.view.local?.backend }) : 'brak' }).catch((e) => String(e).slice(0, 80)))
  if ((await st.getAttribute('data-full')) === '1') break
  if (Date.now() - t0 > 30 * 60_000) throw new Error('timeout ładowania')
  await c.waitForTimeout(15000)
}
await c.getByTestId('chat-input').fill(Q)
await c.getByTestId('chat-send').click()
await c.getByTestId('turn-stats').last().filter({ hasText: /tok\/s|niedostępny|unavailable/ }).waitFor({ timeout: 15 * 60_000 })
log('odpowiedź:', await c.getByTestId('reply').last().innerText())
log('statystyki:', await c.getByTestId('turn-stats').last().innerText())
log('trasa:', await c.getByTestId('mesh-route').innerText().catch(() => '-'))
await c.screenshot({ path: shot, fullPage: true })
if (process.env.FAILOVER) {
  // awaria: zamknij pierwszy węzeł, zapytaj znowu
  await nodes[0].context().close()
  log('zamknięto węzeł 0')
  await c.waitForTimeout(8000)
  await c.getByTestId('chat-input').fill('Co to jest fotosynteza? Jedno zdanie.')
  await c.getByTestId('chat-send').click()
  await c.getByTestId('turn-stats').last().filter({ hasText: /tok\/s|niedostępny|unavailable/ }).waitFor({ timeout: 15 * 60_000 })
  log('po awarii:', await c.getByTestId('reply').last().innerText(), '|', await c.getByTestId('turn-stats').last().innerText())
}
await browser.close()
