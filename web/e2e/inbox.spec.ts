import { expect, test } from '@playwright/test'

// Weryfikuj = jedna skrzynka: chipy stanu (czeka/sporne/zatwierdzone), rodzaju i pewności AI zawężają
// wszystkie źródła naraz – kolejkę (sprzeczne strzępki), odpowiedzi czatu i znaczenia z czatu.
test('Weryfikuj: jedna skrzynka z chipami stanu, rodzaju i pewności AI', async ({ page }) => {
  const now = new Date().toISOString()
  const ans = (id: number, conf: number, n_votes: number, n_confirm: number, status = 'pending') => ({
    id, question: `Pytanie testowe ${id}?`, answer: `Odpowiedź ${id}`, sources: [], conf, topic: null, category: null, intent: 'pytanie', has_source: false, register: 'neutralne', act: 'lite', mode: 'lite', status,
    posterior: 0.5, n_votes, n_confirm, n_corrections: 0, decided_by: null, correction: null, correction_source: null, created_at: now,
  })
  await page.route(/supabase\.co\/rest\/v1\//, (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    if (fn === 'myc_review_whoami') return route.fulfill({ json: { room: null, reviewer: null, weight: null } })
    if (fn === 'myc_chat_answers' && u.search.includes('status=eq.pending')) return route.fulfill({ json: [ans(1, 0.3, 2, 1), ans(2, 0.9, 0, 0)] })
    if (fn === 'myc_chat_answers' && u.search.includes('status=eq.confirmed')) return route.fulfill({ json: [ans(3, 0.7, 3, 3, 'confirmed')] })
    if (fn === 'myc_meanings' && u.search.includes('status=eq.pending'))
      return route.fulfill({ json: [{ id: 7, word: 'sztos', meaning: 'coś świetnego', register: 'slang', example: null, status: 'pending', posterior: 0.5, n_votes: 0, n_true: 0, decided_by: null, created_at: now }] })
    if (fn === 'myc_frags' && u.search.includes('status=eq.conflict'))
      return route.fulfill({
        json: [
          { id: 11, layer: 0, subj: 'Warszawa', rel: 'populacja', obj: '1862402', source: 'wikidata', source_ref: 'Q270', trust: 0.9, status: 'conflict', n_support: 2 },
          { id: 12, layer: 0, subj: 'Warszawa', rel: 'populacja', obj: '3700000', source: 'chat', trust: 0.4, status: 'conflict', n_support: 1 },
        ],
      })
    return route.fulfill({ json: [] })
  })
  await page.goto('./#/weryfikuj')
  const f = page.getByTestId('inbox-filters')
  await expect(f).toBeVisible()
  await expect(page.getByTestId('state-czeka')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('answer-item')).toHaveCount(2)
  await expect(page.getByTestId('meaning-item')).toHaveCount(1)
  await expect(page.getByTestId('type-czat')).toContainText('2')
  await expect(page.getByTestId('type-znaczenia')).toContainText('1')

  // sporne: odpowiedź, z którą ktoś się nie zgodził, i sprzeczne strzępki; znaczenie bez głosów znika
  await page.getByTestId('state-sporne').click()
  await expect(page.getByTestId('answer-item')).toHaveCount(1)
  await expect(page.getByTestId('meaning-item')).toHaveCount(0)
  await expect(page.locator('[data-testid=review-item][data-type=fragment]')).toBeVisible()
  await expect(page.getByTestId('inbox-note')).toContainText('Sporne')

  // pewność AI ≥80%: tylko odpowiedź czatu z conf 0.9 (w stanie „czeka”)
  await page.getByTestId('state-czeka').click()
  await page.getByTestId('conf-high').click()
  await expect(page.getByTestId('answer-item')).toHaveCount(1)
  await expect(page.getByTestId('answer-item')).toContainText('Pytanie testowe 2?')
  await expect(page.getByTestId('meaning-votes')).toHaveCount(0)
  await expect(page.getByTestId('inbox-note')).toContainText('nie mają pewności AI')

  // rodzaj: tylko odpowiedzi czatu
  await page.getByTestId('conf-all').click()
  await page.getByTestId('type-czat').click()
  await expect(page.getByTestId('review-item')).toHaveCount(0)
  await expect(page.getByTestId('meaning-item')).toBeHidden()

  // zatwierdzone: potwierdzone odpowiedzi czatu
  await page.getByTestId('state-zatwierdzone').click()
  await expect(page.getByTestId('answer-item').filter({ hasText: 'Pytanie testowe 3?' })).toBeVisible()
  await expect(page.getByTestId('review-item')).toHaveCount(0)
})
