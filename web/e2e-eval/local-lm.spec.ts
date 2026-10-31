// Pomiar modelu grzybni w przeglądarce (bez węzłów): wczytanie, a potem odpowiedzi na stałe pytania rozmowy.
// Ręcznie: EVAL_URL=… EVAL_LABEL=live npx playwright test -c playwright.eval.config.ts local-lm
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const QS = ['Cześć! Jak się masz?', 'Napisz jedno zdanie o lesie.', 'Co lubisz robić?', 'Opowiedz mi krótko, czym jest grzybnia.']

test('local LM in browser', async ({ page, baseURL }) => {
  // EVAL_ROOM: osobny pokój sieci (bez prawdziwych węzłów), żeby czat liczył w przeglądarce bez zatrzymywania węzłów
  if (process.env.EVAL_ROOM) await page.addInitScript((r) => localStorage.setItem('myc-mesh-room', r), process.env.EVAL_ROOM)
  await page.goto('./#/chat')
  await page.waitForTimeout(1500) // service worker przejmuje stronę (potrzebny do izolacji COOP/COEP)
  await page.evaluate(() => (localStorage.setItem('myc.chatlog', '0'), localStorage.setItem('myc.train', '0')))
  const meshFull = await page.getByTestId('mesh-status').getAttribute('data-full')
  const t0 = Date.now()
  await page.getByTestId('local-start').click()
  await expect(page.getByTestId('local-lm')).toHaveAttribute('data-status', 'ready', { timeout: 25 * 60_000 })
  const loadMs = Date.now() - t0
  await page.waitForFunction(() => {
    // nowsza wersja (z liczbą wątków) wstępnie liczy prompt systemowy – poczekaj na koniec, starsza nie ma tego kroku
    const t = document.querySelector('[data-testid=local-ready]')?.textContent ?? ''
    return /prompt \d/.test(t) || !/wątk|thread/.test(t)
  }, null, { timeout: 5 * 60_000 }).catch(() => undefined)
  const chip = (await page.getByTestId('local-ready').textContent().catch(() => '')) ?? ''
  const isolated = await page.evaluate(() => crossOriginIsolated)
  const rows = []
  for (const q of QS) {
    await page.getByTestId('chat-input').fill(q)
    const t1 = Date.now()
    await page.getByTestId('chat-send').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid=chat-send]')?.hasAttribute('disabled'), null, { timeout: 10 * 60_000 })
    const ms = Date.now() - t1
    const turn = page.locator('[data-testid=reply]').last().locator('xpath=..')
    const text = (await page.getByTestId('reply').last().textContent()) ?? ''
    const stats = (await turn.getByTestId('turn-stats').textContent()) ?? ''
    const path = await turn.getByTestId('answer-path').getAttribute('data-path')
    const local = await turn.getByTestId('local-label').count()
    rows.push({ q, text, stats, ms, path, local: local > 0 })
    console.log(`${ms} ms · ${path} · ${stats} · ${text.replace(/\s+/g, ' ').slice(0, 100)}`)
  }
  const summary = { set: 'local_lm_v1', url: baseURL, label: process.env.EVAL_LABEL ?? 'local', at: new Date().toISOString(), viewport: page.viewportSize(), meshFull, isolated, chip, loadMs, n: rows.length, generated_locally: rows.filter((r) => r.local).length }
  console.log(JSON.stringify(summary))
  const out = resolve(here, `../../results/chat_facts/${summary.at.slice(0, 16).replace(/[:T]/g, '')}-local_lm_v1-${summary.label}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 1))
})
