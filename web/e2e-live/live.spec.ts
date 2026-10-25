import { expect, test, type Page } from '@playwright/test'

// Strażnik nie zapisuje nic do wspólnej bazy: każdy zapis REST do Supabase jest przechwytywany
// i potwierdzany lokalnie, więc w tabelach myc_* nie zostają wiersze testowe. Odczyty idą na żywo.
async function guard(page: Page): Promise<string[]> {
  await page.route(/supabase\.co\/rest\/v1\//, (r) =>
    r.request().method() === 'GET' || r.request().method() === 'HEAD' ? r.continue() : r.fulfill({ status: 201, json: [] }),
  )
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // przejściowe błędy sieci (np. zerwany WebSocket) nie są awarią strony
  page.on('console', (m) => m.type() === 'error' && !/net::ERR|Failed to load resource|WebSocket/i.test(m.text()) && errors.push(m.text()))
  return errors
}

test('strona ładuje się bez logowania, wykresy mają dane albo pusty stan', async ({ page }) => {
  const errors = await guard(page)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Przegląd', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Benchmark (ai-bench, nagrany)')).toBeVisible()
  // bez wymyślonej skali „IQ”; KPI mają linię źródła
  await expect(page.getByText(/\bIQ\b/)).toHaveCount(0)
  await expect(page.getByTestId('kpi-lm').getByTestId('src')).toContainText('myc_models')
  const charts = page.getByTestId('timechart')
  await expect.poll(async () => (await charts.count()) + (await page.getByTestId('empty').count())).toBeGreaterThan(0)
  for (const c of await charts.all()) expect(Number(await c.getAttribute('data-points'))).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('czat zawsze odpowiada', async ({ page }) => {
  const errors = await guard(page)
  await page.goto('./#/chat')
  await page.getByTestId('chat-input').fill('Co to jest wombat?')
  await page.getByTestId('chat-send').click()
  // koniec odpowiedzi = przycisk znów aktywny; odpowiedź nie może być pusta ani komunikatem „myśli…”
  await expect(page.getByTestId('chat-send')).toBeEnabled({ timeout: 75_000 })
  const reply = page.getByTestId('reply').last()
  await expect(reply).toHaveText(/\S{3,}/)
  await expect(reply).not.toContainText('grzybnia myśli')
  console.log(`odpowiedź: ${(await reply.innerText()).slice(0, 120)}`)
  expect(errors).toEqual([])
})
