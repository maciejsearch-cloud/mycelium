import { expect, test } from '@playwright/test'

// Nauka z czatu (bez backendu: RPC podstawione): reakcja „pierdolisz” → odpowiedź rozumiejąca intencję i znaczenie
// (Wikisłownik, rejestr jako etykieta), nieznane słowo → prośba o wyjaśnienie → oczekujące znaczenie (RPC),
// głos właścicielki w Weryfikuj → zatwierdzone → czat go używa.
test('czat: reakcja, wyjaśnienie → głosowanie → zatwierdzone znaczenie w odpowiedzi', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  let approved = false
  const row = { id: 7, word: 'ziomal', meaning: 'kumpel, przyjaciel', register: 'potoczne', example: 'co to jest ziomal?', posterior: 0.5, n_votes: 0, n_true: 0, decided_by: null, created_at: new Date().toISOString() }
  await page.route(/wiktionary\.org|wikidata\.org|wikipedia\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    const body = route.request().postData() ? (JSON.parse(route.request().postData()!) as Record<string, unknown>) : {}
    if (u.pathname.includes('/rpc/')) calls.push({ fn, body })
    if (fn === 'myc_meaning_add') return route.fulfill({ json: { id: 7, status: 'pending' } })
    if (fn === 'myc_meaning_vote') {
      approved = body.p_key === 'klucz-testowy' && body.p_vote === true
      return route.fulfill({ json: { ok: true, voter: 'owner', status: approved ? 'approved' : 'pending', posterior: 1, votes: 1 } })
    }
    if (fn === 'myc_review_whoami') return route.fulfill({ json: body.p_key === 'klucz-testowy' ? { room: 'main', reviewer: 'owner', weight: 1 } : { room: null, reviewer: null, weight: null } })
    if (fn === 'myc_meanings') {
      if (u.search.includes('status=eq.pending')) return route.fulfill({ json: approved ? [] : [{ ...row, status: 'pending' }] })
      if (u.search.includes('word=eq.ziomal')) return route.fulfill({ json: approved ? [{ ...row, status: 'approved', posterior: 1, n_votes: 1, decided_by: 'owner' }] : [] })
    }
    return route.fulfill({ json: [] })
  })
  const say = async (t: string) => {
    const n = await page.getByTestId('reply').count()
    await page.getByTestId('chat-input').fill(t)
    await page.getByTestId('chat-send').click()
    await expect(page.getByTestId('reply')).toHaveCount(n + 1)
    const last = page.getByTestId('reply').last()
    await expect(last).not.toHaveText('')
    return last
  }
  await page.goto('./#/chat')
  // 1. reakcja: niezgoda, znaczenie z Wikisłownika (wulgarne – tylko etykieta), bez zmyślonej definicji
  const r1 = await say('Pierdolisz')
  await expect(r1).toContainText('uważasz, że moja odpowiedź to bzdura')
  await expect(r1).toContainText('wulgarne')
  await expect(r1).toContainText('zmyślać')
  await expect(page.getByTestId('turn-stats').last()).toContainText('reaction')
  // 2. nieznane słowo → prośba o wyjaśnienie
  const r2 = await say('co to jest ziomal?')
  await expect(r2).toContainText('co znaczy „ziomal”')
  // 3. wyjaśnienie → oczekujące znaczenie (RPC), czat go jeszcze nie używa
  const r3 = await say('ziomal to potocznie kumpel, przyjaciel')
  await expect(r3).toContainText('trafia do głosowania')
  await expect(page.getByTestId('meaning-pending')).toContainText('czeka na głosowanie')
  const add = calls.find((c) => c.fn === 'myc_meaning_add')!
  expect(add.body).toMatchObject({ p_word: 'ziomal', p_meaning: 'kumpel, przyjaciel', p_register: 'potoczne', p_room: 'main' })
  // 4. Weryfikuj: głos właścicielki = złota etykieta → zatwierdzone
  await page.goto('./#/weryfikuj')
  await page.getByTestId('owner-key').fill('klucz-testowy')
  await page.getByTestId('owner-key-save').click()
  const item = page.locator('[data-testid=meaning-item][data-word=ziomal]')
  await expect(item).toContainText('kumpel, przyjaciel')
  await expect(item).toContainText('potoczne')
  await item.getByTestId('meaning-true').click()
  await expect(item.getByTestId('meaning-msg')).toContainText('zatwierdzone')
  expect(calls.find((c) => c.fn === 'myc_meaning_vote')!.body).toMatchObject({ p_key: 'klucz-testowy', p_id: 7, p_vote: true })
  // 5. czat używa zatwierdzonego znaczenia (ze źródłem: głosowanie)
  await page.goto('./#/chat')
  const r5 = await say('co to jest ziomal?')
  await expect(r5).toContainText('kumpel, przyjaciel')
  await expect(r5).toContainText('zatwierdzono w głosowaniu')
})
