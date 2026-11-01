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

// Mówca Grzybnia AI: wpis AI z plakietką, poziom i trafność z bazy, narzędzia oceny widoczne (bez konta – tylko odczyt).
test('czat globalny: wpis Grzybni AI i panel poziomów', async ({ page }) => {
  const msg = { id: 5, room: 'main', circle_id: null, kind: 'ai', handle: 'Grzybnia AI', role: null, body: 'kto ja?', reply_to: null, intent: 'pytanie', tags: [], pinned: false, deleted: false, created_at: new Date().toISOString() }
  await page.route(/supabase\.co\/rest\/v1\//, (r) => {
    const u = r.request().url()
    if (u.includes('/myc_gchat?')) return r.fulfill({ json: [msg] })
    if (u.includes('/rpc/myc_speaker_state'))
      return r.fulfill({ json: { enabled: true, interval_s: 60, level: 0, last_post_at: null, sft: 0, forms_people: 0, votes: 2, opted_out_votes: 0, levels: [0, 1, 2, 3].map((l) => ({ level: l, posts: l ? 0 : 1, rated: l ? 0 : 1, sensible: l ? 0 : 1, acc: l ? null : 1 })) } })
    if (u.includes('/rpc/myc_speaker_summary'))
      return r.fulfill({ json: [{ msg_id: 5, level: 0, how: 'losowe', tokens: ['kto', 'ja?'], sense: 2, nonsense: 0, n: 2, category: 'pytanie', task_type: null, labels: null, fixes: null, answers: null, mine: null }] })
    return r.fulfill({ json: [] })
  })
  const errors = watch(page)
  await page.goto('./#/czat')
  await expect(page.getByTestId('badge-ai')).toBeVisible()
  await expect(page.getByTestId('spk-level')).toContainText('L0')
  await expect(page.getByTestId('spk-levels')).toContainText('100% (1/1)')
  await expect(page.getByTestId('spk-levels')).toContainText('brak ocen')
  await expect(page.getByTestId('spk-score')).toContainText('👍 2')
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

// Rozmówca: odpowiedź grzybni ze źródłem i czasem z bazy, rozbiór wiadomości osoby, panel stanu (bez konta – odczyt).
test('czat globalny: rozmówca – źródło odpowiedzi, rozbiór, panel', async ({ page }) => {
  const at = new Date().toISOString()
  const base = { room: 'main', circle_id: null, role: null, reply_to: null, intent: null, tags: [], pinned: false, deleted: false, created_at: at }
  const msgs = [
    { ...base, id: 10, kind: 'user', handle: 'Ola', body: 'Grzybnio, ale się dziś nudzę' },
    { ...base, id: 11, kind: 'ai', handle: 'Grzybnia AI', body: 'Dlaczego się nudzisz? Nie masz nic do roboty?', reply_to: 10 },
  ]
  const parse = {
    v: 1, model: 'rb-lfg-70793f8d.bin', addressed: true, toOther: null, pred: 'nudzić', person: 1, mood: 'ind', tense: 'pres', neg: false, subj: null, obj: null, phrase: null,
    qtype: null, question: false, content: ['nudzić'], polarity: -1, emotions: ['smutek'], acts: ['stan'], why: ['stan: nudzić'], conf: 0.9,
    toks: [{ f: 'nudzę', l: 'nudzić', u: 'VERB', d: 'root', h: 0, x: 'Person=1' }],
  }
  await page.route(/supabase\.co\/rest\/v1\//, (r) => {
    const u = r.request().url()
    if (u.includes('/myc_gchat?')) return r.fulfill({ json: msgs })
    if (u.includes('/rpc/myc_rozmowa_meta'))
      return r.fulfill({ json: { replies: { 11: { source: 'reguła', rule: 'stan.dopytanie', cite: null, to: 10, addressed: true, latency_ms: 2400, up: 1, down: 0, mine: null } }, parsed: [10] } })
    if (u.includes('/rpc/myc_rozmowa_parse')) return r.fulfill({ json: parse })
    if (u.includes('/rpc/myc_rozmowa_state'))
      return r.fulfill({ json: { enabled: true, heartbeat_at: at, online: true, worker_version: 'rozmowa-worker-1', interject_every_n: 3, interject_min_s: 90, invite_quiet_min: 45, replies: 1, median_latency_ms: 2400, mem: 1, pairs: 0, pending_decisions: 0 } })
    return r.fulfill({ json: [] })
  })
  const errors = watch(page)
  await page.goto('./#/czat')
  await expect(page.getByTestId('rozmowa-source')).toContainText('reguła · stan.dopytanie · 2,4 s')
  await expect(page.getByTestId('rozmowa-online')).toContainText('słucha czatu')
  await page.getByTestId('rozbior-open').click()
  await expect(page.getByTestId('rozbior-sheet')).toContainText('nudzić')
  await expect(page.getByTestId('rozbior-sheet')).toContainText('teraźniejszy')
  await expect(page.getByTestId('rozbior-sheet')).toContainText('CC BY 4.0')
  expect(errors).toEqual([])
})

// Weryfikuj: bez uprawnień Developera nie ma przycisku ukrywania; ukryte klucze znikają z kolejki.
test('Weryfikuj: ukrywanie tylko dla Developera', async ({ page }) => {
  await page.route(/supabase\.co\/rest\/v1\//, (r) => {
    const u = r.request().url()
    if (u.includes('/rpc/myc_review_hidden_list')) return r.fulfill({ status: 403, json: { message: 'myc: tylko Developer' } })
    if (u.includes('/rpc/myc_review_hidden_keys')) return r.fulfill({ json: [] })
    return r.fulfill({ json: [] })
  })
  await page.goto('./#/weryfikuj')
  await expect(page.getByTestId('review-numbers')).toBeVisible()
  await expect(page.getByTestId('review-hide')).toHaveCount(0)
  await expect(page.getByTestId('review-hidden')).toHaveCount(0)
})
