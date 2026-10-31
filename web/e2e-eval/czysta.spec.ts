// Pomiar zakładki „Czysta grzybnia” w prawdziwej przeglądarce (ten sam kod, model rozbioru i wiedza co na stronie).
// Pytania podaje scripts/czysta_eval.py (CZYSTA_ITEMS = JSON {items:[{id,q}]}); wynik → CZYSTA_OUT. Nauka wyłączona
// (myc.train = 0), więc pomiar nic nie zapisuje w Weryfikuj.
import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

test('czysta grzybnia eval', async ({ page }) => {
  const items = (JSON.parse(readFileSync(process.env.CZYSTA_ITEMS!, 'utf8')) as { items: { id: string; q: string }[] }).items
  await page.addInitScript(() => localStorage.setItem('myc.train', '0'))
  await page.goto('./#/czysta')
  await expect(page.getByTestId('czysta-ask')).toBeEnabled({ timeout: 120_000 })
  await expect(page.getByTestId('czysta-stats')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(3000) // konsensus Ucz AI w przeglądarce (mózg) – po wczytaniu odpowiedzi
  const model = (await page.getByTestId('czysta-model').textContent()) ?? ''
  const rows = []
  let n = 0
  for (const it of items) {
    await page.getByTestId('czysta-input').fill(it.q)
    await page.getByTestId('czysta-ask').click()
    n++
    const res = page.locator(`[data-testid=czysta-result][data-n="${n}"]`)
    await res.waitFor({ timeout: 30_000 })
    const answer = (await res.getByTestId('czysta-answer').textContent())?.trim() ?? ''
    const source = await res.getAttribute('data-source')
    const trace = await res.getByTestId('czysta-trace').locator('li').allTextContents()
    rows.push({ id: it.id, answer: source === 'brak' ? null : answer, source, trace })
  }
  writeFileSync(process.env.CZYSTA_OUT!, JSON.stringify({ model, at: new Date().toISOString(), results: rows }))
})
