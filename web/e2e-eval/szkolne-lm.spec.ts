// Testy szkolne (benchmarks/szkolne) w czacie z modelem grzybni liczonym w tej przeglądarce (bez węzłów: EVAL_ROOM).
// Pytania podaje scripts/szkolne_eval.py --lm (SZK_ITEMS = {items:[{id,q}]}); wynik → SZK_OUT. Bez zapisu rozmów i nauki.
// Każde pytanie w świeżej rozmowie (przejście na inną zakładkę i z powrotem czyści historię, model zostaje wczytany).
import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

test('szkolne: LM grzybni w przeglądarce', async ({ page }) => {
  const items = (JSON.parse(readFileSync(process.env.SZK_ITEMS!, 'utf8')) as { items: { id: string; q: string }[] }).items
  if (process.env.EVAL_ROOM) await page.addInitScript((r) => localStorage.setItem('myc-mesh-room', r), process.env.EVAL_ROOM)
  await page.addInitScript(() => (localStorage.setItem('myc.chatlog', '0'), localStorage.setItem('myc.train', '0')))
  await page.goto('./#/chat')
  const t0 = Date.now()
  await page.getByTestId('local-start').click()
  await expect(page.getByTestId('local-lm')).toHaveAttribute('data-status', 'ready', { timeout: 25 * 60_000 })
  const loadMs = Date.now() - t0
  await page.waitForFunction(() => /prompt \d/.test(document.querySelector('[data-testid=local-ready]')?.textContent ?? ''), null, { timeout: 5 * 60_000 }).catch(() => undefined)
  const chip = (await page.getByTestId('local-ready').textContent().catch(() => '')) ?? ''
  const meshFull = await page.getByTestId('mesh-status').getAttribute('data-full')
  const rows = []
  for (const it of items) {
    await page.goto('./#/czysta')
    await page.goto('./#/chat')
    await expect(page.getByTestId('local-lm')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
    await page.getByTestId('chat-input').fill(it.q)
    const t1 = Date.now()
    await page.getByTestId('chat-send').click()
    await page.getByTestId('reply').first().waitFor({ timeout: 60_000 })
    await page.waitForFunction(() => !document.querySelector('[data-testid=chat-send]')?.hasAttribute('disabled'), null, { timeout: 10 * 60_000 })
    const turn = page.locator('[data-testid=reply]').last().locator('xpath=..')
    const text = ((await page.getByTestId('reply').last().textContent()) ?? '').trim()
    const path = await turn.getByTestId('answer-path').getAttribute('data-path').catch(() => null)
    const local = (await turn.getByTestId('local-label').count()) > 0
    rows.push({ id: it.id, answer: text || null, source: local ? 'lm-przeglądarka' : `czat:${path ?? 'reguły'}`, local, ms: Date.now() - t1 })
    console.log(`${it.id} · ${local ? 'LM' : 'bez LM'} · ${text.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  writeFileSync(process.env.SZK_OUT!, JSON.stringify({ model: chip, meta: { loadMs, meshFull, viewport: page.viewportSize() }, at: new Date().toISOString(), results: rows }))
})
