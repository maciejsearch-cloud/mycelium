import { expect, test } from '@playwright/test'

const watch = (page: import('@playwright/test').Page) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !/WebSocket|realtime|ERR_|Failed to load resource/i.test(m.text()) && errors.push(m.text()))
  return errors
}

// Czat globalny bez backendu: uczciwy pusty stan, czytanie bez konta, zaproszenie do założenia konta.
test('czat globalny: pusty stan i logowanie', async ({ page }) => {
  await page.route(/supabase\.co\/rest\/v1\//, (r) => r.fulfill({ json: [] }))
  const errors = watch(page)
  await page.goto('./#/czat')
  await expect(page.getByRole('heading', { level: 1, name: 'Czat globalny' })).toBeVisible()
  await expect(page.getByTestId('gchat-empty')).toContainText('Jeszcze nikt tu nie napisał')
  await expect(page.getByTestId('gchat-login')).toContainText('anonimowe konto')
  expect(errors).toEqual([])
})

test('Weryfikuj: kandydat wzorca języka z czatu i głos', async ({ page }) => {
  const votes: unknown[] = []
  await page.route(/supabase\.co\/rest\/v1\//, (r) => {
    const u = r.request().url()
    if (u.includes('/myc_lang_patterns?'))
      return r.fulfill({ json: [{ id: 7, kind: 'skrót', pattern: 'nwm', label: 'skrót czatu', example: 'nwm co z tym', n_seen: 4, n_authors: 2, posterior: 0.5, n_votes: 0 }] })
    if (u.includes('/rpc/myc_lang_vote')) {
      votes.push(r.request().postDataJSON())
      return r.fulfill({ json: { ok: true, voter: 'person', posterior: 0.7, status: 'pending', votes: 1 } })
    }
    return r.fulfill({ json: [] })
  })
  const errors = watch(page)
  await page.goto('./#/weryfikuj')
  await expect(page.getByTestId('pattern-item')).toContainText('nwm')
  await page.getByTestId('pattern-item').getByRole('button', { name: 'Prawda' }).click()
  await expect(page.getByTestId('pattern-item')).toContainText('głos policzony')
  expect(votes[0]).toMatchObject({ p_id: 7, p_vote: true, p_key: null })
  expect(errors).toEqual([])
})
