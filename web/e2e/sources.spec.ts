import { expect, test } from '@playwright/test'

// Odpowiedzi ze źródłem (bez backendu: Wikipedia i Supabase podstawione):
// pytanie o fakt → zdanie z Wikipedii + link; brak źródła → „nie wiem, naucz mnie”; pamięć wiedzy (zatwierdzona poprawka)
// odpowiada od razu z pochodzeniem; każda odpowiedź → myc_answer_log bez e-maila; rezygnacja = brak zapisu;
// Weryfikuj: odpowiedź z etykietami, poprawka właścicielki → myc_answer_vote.
test('czat: źródła, „nie wiem”, pamięć wiedzy, zapis do Weryfikuj i poprawka', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  const answerRow = {
    id: 11, question: 'Kto napisał „Pana Tadeusza”?', answer: 'Według Wikipedii (artykuł „Pan Tadeusz”): …', sources: [{ kind: 'wiki', title: 'Wikipedia: Pan Tadeusz (CC BY-SA)', url: 'https://pl.wikipedia.org/wiki/Pan_Tadeusz' }],
    conf: 0.83, topic: 'Dzieło', category: 'Dzieło › Utwór', intent: 'pytanie', has_source: true, register: 'neutralne', act: 'wikipedia', mode: 'lite', status: 'pending',
    posterior: 0.5, n_votes: 0, n_confirm: 0, n_corrections: 0, decided_by: null, correction: null, correction_source: null, created_at: new Date().toISOString(),
  }
  await page.route(/wiktionary\.org|wikidata\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/pl\.wikipedia\.org\/w\/api\.php/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('list') === 'search') {
      const q = u.searchParams.get('srsearch') ?? ''
      return route.fulfill({ json: { query: { search: /Tadeusza/.test(q) ? [{ title: 'Pan Tadeusz' }] : [] } } })
    }
    return route.fulfill({
      json: { query: { pages: [{ title: 'Pan Tadeusz', extract: 'Pan Tadeusz, czyli ostatni zajazd na Litwie – poemat epicki Adama Mickiewicza wydany w dwóch tomach w 1834 w Paryżu. Utwór uznawany jest za epopeję narodową.' }] } },
    })
  })
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    const body = route.request().postData() ? (JSON.parse(route.request().postData()!) as Record<string, unknown>) : {}
    if (u.pathname.includes('/rpc/')) calls.push({ fn, body })
    if (fn === 'myc_answer_log') return route.fulfill({ json: { logged: true, id: 11 } })
    if (fn === 'myc_answer_vote') return route.fulfill({ json: { ok: true, voter: 'owner', status: 'corrected', posterior: 0, votes: 1, frag: 5 } })
    if (fn === 'myc_review_whoami') return route.fulfill({ json: body.p_key === 'klucz-testowy' ? { room: 'main', reviewer: 'owner', weight: 1 } : { room: null, reviewer: null, weight: null } })
    if (fn === 'myc_frags' && u.search.includes('status=eq.verified'))
      return route.fulfill({ json: [{ id: 5, subj: 'Jaki kolor ma grzybnia testowa?', rel: 'odpowiedz', obj: 'fioletowy', source: 'owner', source_ref: 'answer:9 https://pl.wikipedia.org/wiki/Grzybnia', trust: 1, n_support: 1, updated_at: '2026-10-24T20:00:00Z' }] })
    if (fn === 'myc_chat_answers') return route.fulfill({ json: [answerRow] })
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
  await expect(page.getByTestId('knowledge-count')).toContainText('1')
  // 1. źródło: zdanie dosłownie z Wikipedii + link
  const r1 = await say('Kto napisał „Pana Tadeusza”?')
  await expect(r1).toContainText('Według Wikipedii')
  await expect(r1).toContainText('Adama Mickiewicza')
  await expect(page.getByTestId('source-link').last()).toHaveAttribute('href', 'https://pl.wikipedia.org/wiki/Pan_Tadeusz')
  // 2. brak źródła → uczciwe „nie wiem” + nauka (e-mail w pytaniu nie trafia do zapisu)
  const r2 = await say('Kto jest prezydentem Marsa? pisz na kasia@example.com')
  await expect(r2).toContainText('Nie wiem, naucz mnie')
  await expect(page.getByTestId('turn-stats').last()).toContainText('nosource')
  // 3. pamięć wiedzy: zatwierdzona poprawka odpowiada od razu, z pochodzeniem
  const r3 = await say('Jaki kolor ma grzybnia testowa?')
  await expect(r3).toContainText('Z pamięci wiedzy grzybni')
  await expect(r3).toContainText('fioletowy')
  await expect(r3).toContainText('właścicielka')
  await expect.poll(() => calls.filter((c) => c.fn === 'myc_answer_log').length).toBe(3)
  const logs = calls.filter((c) => c.fn === 'myc_answer_log')
  expect(logs[0].body).toMatchObject({ p_intent: 'pytanie', p_act: 'wikipedia', p_mode: 'lite', p_room: 'main' })
  expect((logs[0].body.p_sources as { url?: string }[])[0].url).toBe('https://pl.wikipedia.org/wiki/Pan_Tadeusz')
  expect(String(logs[1].body.p_question)).not.toContain('kasia@example.com')
  expect(String(logs[1].body.p_question)).toContain('[e-mail]')
  // 4. rezygnacja: nic nie jest zapisywane
  await page.getByTestId('train-consent').uncheck()
  await say('Kto jest prezydentem Wenus?')
  await page.waitForTimeout(300)
  expect(calls.filter((c) => c.fn === 'myc_answer_log').length).toBe(3)
  // 5. Weryfikuj: odpowiedź z etykietami, poprawka właścicielki (złota etykieta)
  await page.goto('./#/weryfikuj')
  await page.getByTestId('owner-key').fill('klucz-testowy')
  await page.getByTestId('owner-key-save').click()
  const item = page.getByTestId('answer-item').first()
  await expect(item).toContainText('Kto napisał „Pana Tadeusza”?')
  await expect(item.getByTestId('answer-labels')).toContainText('ma źródło')
  await expect(item.getByTestId('answer-labels')).toContainText('Dzieło')
  await item.getByTestId('answer-correct').click()
  await item.getByTestId('answer-correction').fill('Adam Mickiewicz')
  await item.getByTestId('answer-correction-source').fill('https://pl.wikipedia.org/wiki/Pan_Tadeusz')
  await item.getByTestId('answer-correction-save').click()
  await expect(item.getByTestId('answer-msg')).toContainText('pamięć wiedzy')
  const v = calls.find((c) => c.fn === 'myc_answer_vote')!
  expect(v.body).toMatchObject({ p_id: 11, p_vote: 'correct', p_correction: 'Adam Mickiewicz', p_key: 'klucz-testowy' })
})

// Pytanie osobiste to nie fakt ze świata: „Ile mam lat?” dostawało film „Znów mam 17 lat” z Wikipedii.
// Teraz: uczciwe „nie znam Cię” bez zapytania do Wikipedii/Wikidata; imię z tej rozmowy jest jedynym kontekstem.
test('czat: pytania osobiste nie idą do Wikipedii', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const wiki: string[] = []
  await page.route(/wiktionary\.org|wikidata\.org/, (r) => (wiki.push(r.request().url()), r.fulfill({ status: 404, body: '' })))
  await page.route(/pl\.wikipedia\.org\/w\/api\.php/, (route) => {
    wiki.push(route.request().url())
    const u = new URL(route.request().url())
    if (u.searchParams.get('list') === 'search') return route.fulfill({ json: { query: { search: [{ title: 'Znów mam 17 lat' }] } } })
    return route.fulfill({ json: { query: { pages: [{ title: 'Znów mam 17 lat', extract: 'Znów mam 17 lat (ang. 17 Again) – amerykański film komediowy z 2009 roku w reżyserii Burra Steersa.' }] } } })
  })
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill({ json: [] }))
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
  const r1 = await say('Ile mam lat?')
  await expect(r1).toContainText('nie znam Cię')
  await expect(r1).not.toContainText('Znów mam 17 lat')
  await say('Mam na imię Ola')
  const r2 = await say('Gdzie mieszkam?')
  await expect(r2).toContainText('nie znam Cię')
  await expect(r2).toContainText('masz na imię Ola')
  const r3 = await say('Ile masz lat?')
  await expect(r3).toContainText('To pytanie o mnie')
  expect(wiki.filter((u) => /mam|lat|mieszkam|masz/i.test(decodeURIComponent(u)))).toEqual([])
})

// Artykuł o samej encji z pytania wygrywa z artykułem, który tylko zawiera jej nazwę: „W jakim mieście jest Wawel?”
// dostawało „Willa Mały Wawel w Krakowie”, „Kto napisał „Lalkę”?” – serial z 1977. Wyciągi skrócone z pl.wikipedia.org.
test('czat: artykuł o encji z pytania, nie poboczny („Wawel”, „Lalka (powieść)”)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const EX: Record<string, string> = {
    Wawel: 'Wawel – wzgórze na Pomoście Krakowskim, w Krakowie w dzielnicy I Stare Miasto, na lewym brzegu Wisły.',
    'Willa Mały Wawel w Krakowie': 'Willa Mały Wawel – zabytkowa willa, znajdująca się w Krakowie, w dzielnicy I przy ul. Podzamcze 10 na Starym Mieście.',
    'Lalka (powieść)': 'Lalka – powieść społeczno-obyczajowa Bolesława Prusa publikowana w odcinkach w latach 1887–1889 w dzienniku „Kurier Codzienny”.',
    'Lalka (serial telewizyjny 1977)': 'Lalka – polski serial telewizyjny z 1977 w reżyserii Ryszarda Bera. Scenariusz napisał Ryszard Ber.',
  }
  await page.route(/wiktionary\.org|wikidata\.org/, (r) => r.fulfill({ status: 404, body: '' }))
  await page.route(/pl\.wikipedia\.org\/w\/api\.php/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('list') === 'search') {
      const q = u.searchParams.get('srsearch') ?? ''
      const t = /Wawel/.test(q) ? ['Willa Mały Wawel w Krakowie'] : /Lalk/.test(q) ? ['Lalka (serial telewizyjny 1977)', 'Lalka (powieść)'] : []
      return route.fulfill({ json: { query: { search: t.map((title) => ({ title })) } } })
    }
    const ts = (u.searchParams.get('titles') ?? '').split('|')
    const redirects = ts.includes('Lalka') ? [{ from: 'Lalka', to: 'Lalka (powieść)' }] : []
    const pages = [...new Set(ts.map((t) => redirects.find((r) => r.from === t)?.to ?? t))].map((title) => (EX[title] ? { title, extract: EX[title] } : { title, missing: true }))
    return route.fulfill({ json: { query: { redirects, pages } } })
  })
  await page.route(/supabase\.co\/rest\/v1\//, (route) => route.fulfill({ json: [] }))
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
  const r1 = await say('W jakim mieście jest Wawel?')
  await expect(r1).toContainText('artykuł „Wawel”')
  await expect(r1).toContainText('w Krakowie')
  const r2 = await say('Kto napisał „Lalkę”?')
  await expect(r2).toContainText('Lalka (powieść)')
  await expect(r2).toContainText('Bolesława Prusa')
})
