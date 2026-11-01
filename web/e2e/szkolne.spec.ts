import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Widok „Testy szkolne” w zakładce Czysta grzybnia: liczby z opublikowanego pomiaru (web/public/data/szkolne/wyniki.json),
// brak pomiaru LM = uczciwy pusty stan, zadania z zamrożonego zestawu z odnośnikiem do źródła; telefon bez poziomego przewijania.
const W = JSON.parse(readFileSync(new URL('../public/data/szkolne/wyniki.json', import.meta.url), 'utf8'))

test('testy szkolne: wyniki według klas i zadania ze źródłem', async ({ page }) => {
  await page.route(/wiktionary\.org|wikidata\.org|wikipedia\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill({ json: [], headers: { 'content-range': '*/0' } }))
  await page.goto('./#/czysta')
  const box = page.getByTestId('szk')
  await expect(box).toBeVisible()
  const before = W.runs.find((r: { label: string }) => r.label === 'przed')
  await expect(page.getByTestId('szk-total')).toContainText(`${before.ok}/${before.n}`)
  const grades = new Set(W.tasks.map((t: { grade: string }) => t.grade))
  await expect(page.getByTestId('szk-grade')).toHaveCount(grades.size)
  if (!W.lm) await expect(page.getByTestId('szk-lm')).toContainText('brak pomiaru')
  const first = W.tasks.find((t: { grade: string }) => t.grade === '1')
  await expect(page.getByTestId('szk-task').first()).toContainText(first.q)
  await expect(page.getByTestId('szk-task').first().getByRole('link')).toHaveAttribute('href', first.src.url)
  await page.getByTestId('szk-tab').filter({ hasText: 'klasa 7' }).click()
  await expect(page.getByTestId('szk-task').first()).toHaveAttribute('data-id', /^szk-7-/)
  // bez opublikowanego modelu rozbioru nie ma czym rozwiązywać – przycisk wyłączony, nic nie udaje odpowiedzi
  await expect(page.getByTestId('szk-solve').first()).toBeDisabled()
  const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(sw).toBeLessThanOrEqual(1)
})
