import { expect, test } from '@playwright/test'

// Rozbiór zdań bez backendu: brak opublikowanego modelu = uczciwy pusty stan w czacie i na karcie Start;
// Weryfikuj → „Rozbiór zdania”: poprawka części zdania słowa → myc_parse_vote z correction [{i, part}].
test('rozbiór: pusty stan w czacie i na Start, poprawka w Weryfikuj', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  const parse = {
    id: 7, sentence: 'Kuba dał Ani książkę.', model_version: 0, conf: 0.93, posterior: 0.5, n_votes: 0, status: 'pending', created_at: new Date().toISOString(),
    toks: [
      { form: 'Kuba', upos: 'PROPN', head: 2, deprel: 'nsubj', part: 'podmiot', q: 'KTO/CO' },
      { form: 'dał', upos: 'VERB', head: 0, deprel: 'root', part: 'orzeczenie' },
      { form: 'Ani', upos: 'PROPN', head: 2, deprel: 'obl', part: 'okolicznik', q: 'GDZIE' },
      { form: 'książkę', upos: 'NOUN', head: 2, deprel: 'obj', part: 'dopełnienie', q: 'KOGO/CO' },
      { form: '.', upos: 'PUNCT', head: 2, deprel: 'punct' },
    ],
  }
  await page.route(/wiktionary\.org|wikidata\.org|wikipedia\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    const body = route.request().postData() ? (JSON.parse(route.request().postData()!) as Record<string, unknown>) : {}
    if (u.pathname.includes('/rpc/')) calls.push({ fn, body })
    if (fn === 'myc_rb_list') return route.fulfill({ json: [] })
    if (fn === 'myc_parses') return route.fulfill({ json: u.search.includes('status=eq.pending') ? [parse] : [] })
    if (fn === 'myc_parse_vote') return route.fulfill({ json: { ok: true, voter: 'person', acc: 0.75, posterior: 0.25, status: 'pending', votes: 1 } })
    if (fn === 'myc_review_whoami') return route.fulfill({ json: { room: null, reviewer: null, weight: null } })
    return route.fulfill({ json: [] })
  })
  await page.goto('./#/chat')
  await page.getByTestId('chat-input').fill('Kuba dał Ani książkę w domu.')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('reply')).toHaveCount(1)
  await page.getByTestId('rozbior').first().locator('summary').click()
  await expect(page.getByTestId('rozbior-empty')).toContainText('Nie ma jeszcze opublikowanego')
  await expect.poll(() => calls.some((c) => c.fn === 'myc_rb_list')).toBe(true)
  expect(calls.some((c) => c.fn === 'myc_parse_log')).toBe(false)

  await page.goto('./#/')
  await expect(page.getByTestId('kpi-rozbior')).toContainText('brak zweryfikowanej wersji')

  await page.goto('./#/weryfikuj')
  const item = page.getByTestId('parse-item').first()
  await expect(item).toContainText('Kuba dał Ani książkę.')
  await item.getByTestId('parse-tok').filter({ hasText: 'Ani' }).click()
  await item.getByRole('button', { name: 'dopełnienie', exact: true }).click()
  await item.getByTestId('parse-fix').click()
  await expect.poll(() => calls.filter((c) => c.fn === 'myc_parse_vote').length).toBe(1)
  const v = calls.find((c) => c.fn === 'myc_parse_vote')!.body
  expect(v).toMatchObject({ p_id: 7, p_vote: 'correct', p_correction: [{ i: 3, part: 'dopełnienie' }] })
  await expect(item).toContainText('głos policzony')
})
