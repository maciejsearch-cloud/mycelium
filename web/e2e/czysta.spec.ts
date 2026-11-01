import { expect, test } from '@playwright/test'

// Czysta grzybnia bez backendu: brak opublikowanego modelu rozbioru i brak wiedzy od ludzi = uczciwe puste stany;
// opis działania (z kodu) jest zawsze widoczny; na telefonie strona nie przewija się w poziomie.
test('czysta grzybnia: puste stany i opis', async ({ page }) => {
  const rpcs: string[] = []
  await page.route(/wiktionary\.org|wikidata\.org|wikipedia\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    if (u.pathname.includes('/rpc/')) rpcs.push(fn)
    if (fn === 'myc_speaker_state') return route.fulfill({ json: null })
    return route.fulfill({ json: [], headers: { 'content-range': '*/0' } })
  })
  await page.goto('./#/czysta')
  await expect(page.getByRole('heading', { name: 'Czysta grzybnia' })).toBeVisible()
  await expect(page.getByTestId('czysta-model')).toContainText('brak opublikowanego modelu rozbioru')
  await expect(page.getByTestId('czysta-ask')).toBeDisabled()
  await expect(page.getByTestId('czysta-n-facts')).toContainText('0')
  await expect(page.getByText('Nie ma jeszcze żadnej wiedzy zatwierdzonej przez ludzi')).toBeVisible()
  // relacje: puste stany (brak pytań, brak zatwierdzonych zdań) i sprawdzanie budowy zdania przed zapisem
  const rel = page.getByTestId('czysta-rel')
  await expect(rel).toContainText('Brak pytań – mówca i samouk jeszcze niczego nie zaproponowali.')
  await expect(page.getByTestId('czysta-rel-stats')).toContainText('brak zatwierdzonych zdań')
  await page.getByTestId('czysta-rel-input').fill('Niedźwiedź mieszka w gawrze.')
  await expect(page.getByTestId('czysta-rel-check')).toContainText('rozpoznano relację „dom”: niedźwiedź → gawrze')
  await page.getByTestId('czysta-rel-kind-młode').click()
  await expect(page.getByTestId('czysta-rel-check')).toContainText('jeszcze nie ma budowy')
  const ex = page.getByTestId('czysta-explain')
  await expect(ex).toContainText('modus tollens')
  await expect(ex).toContainText('Kwadrat logiczny')
  await expect(ex).toContainText('supabase/myc_answers.sql')
  // żadnego modelu językowego ani Wikipedii w tej zakładce
  expect(rpcs).not.toContain('myc_models')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})
