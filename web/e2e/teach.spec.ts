import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'

/** Odpowiedz na bieżące pytanie niezależnie od rodzaju (tak/nie, domena→intencja, zawężanie słowa). */
async function answerAny(p: Page, last = false) {
  const q = p.getByTestId('question')
  const kind = await q.getAttribute('data-kind')
  if (kind === 'word') return q.getByTestId('word-next').click()
  if (kind === 'intent' || kind === 'user-example') await q.locator('button[data-domain]').first().click()
  const b = q.locator('button[data-answer]')
  return last ? b.last().click() : b.first().click()
}

// Wspólna „baza” w pamięci zamiast Supabase: dwa konteksty przeglądarki = dwa węzły.
type Row = Record<string, unknown>
function mockSupabase() {
  const db: Record<string, Row[]> = { myc_answers: [], myc_user_questions: [], myc_growth: [], myc_node_stats: [], myc_fed: [] }
  let id = 1
  const handler = async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const table = url.pathname.split('/').pop()!
    if (table.startsWith('myc_gold_') || table === 'myc_contrib_stats') return route.fulfill({ json: [] })
    if (req.method() === 'POST') {
      const row = { ...(req.postDataJSON() as Row), id: id++, created_at: new Date().toISOString() }
      row.owner = false
      delete row.owner_key
      if (table === 'myc_answers' && db.myc_answers.some((a) => a.question_id === row.question_id && a.node_id === row.node_id)) return route.fulfill({ status: 201, body: '' })
      ;(db[table] ??= []).push(row)
      return route.fulfill({ status: 201, body: '' })
    }
    const rows = [...(db[table] ?? [])]
    return route.fulfill({ json: url.searchParams.get('order')?.endsWith('.desc') ? rows.reverse() : rows })
  }
  // izolowany pokój grzybni: testy nie widzą prawdziwych węzłów online
  const room = 'myc-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  const attach = async (ctx: BrowserContext) => {
    await ctx.addInitScript((r) => localStorage.setItem('myc-mesh-room', r), room)
    await ctx.route(/supabase\.co\/rest\/v1\//, handler)
  }
  return { db, attach }
}

test('dwa węzły odpowiadają różnie → konsensus i zaufanie; ucz teraz pokazuje przed/po', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const [ca, cb] = [await browser.newContext(), await browser.newContext()]
  await sb.attach(ca)
  await sb.attach(cb)
  const [a, b] = [await ca.newPage(), await cb.newPage()]
  const errs: string[] = []
  for (const p of [a, b]) p.on('pageerror', (e) => errs.push(String(e)))

  await a.goto('./#/teach')
  await expect(a.getByRole('heading', { level: 1, name: 'Ucz AI' })).toBeVisible()
  await expect(a.getByTestId('sync')).toContainText('zsynchronizowano')
  // węzeł A: 3 odpowiedzi klawiaturą/kliknięciem
  const q1 = await a.getByTestId('question').getAttribute('data-qid')
  await answerAny(a)
  await expect(a.getByTestId('question')).not.toHaveAttribute('data-qid', q1!)
  await answerAny(a)
  await a.keyboard.press('s')
  expect(sb.db.myc_answers.length).toBeGreaterThanOrEqual(2)

  // węzeł B: odpowiada na to samo pytanie inaczej (ostatnia opcja)
  await b.goto('./#/teach')
  await expect(b.getByTestId('question')).toHaveAttribute('data-qid', /.+/)
  const bq = await b.getByTestId('question').getAttribute('data-qid')
  await answerAny(b, true)
  await expect.poll(() => sb.db.myc_answers.filter((r) => String(r.question_id).startsWith(bq!)).length).toBeGreaterThanOrEqual(1)

  // tryb nauczyciela: fakt od A
  await a.getByRole('tab', { name: 'Fakt' }).click()
  await a.getByTestId('teach-text').fill('Gołdap leży nad jeziorem Gołdap.')
  await a.getByTestId('teach-save').click()
  expect(sb.db.myc_user_questions).toHaveLength(1)

  // B po odświeżeniu widzi pytanie od nauczyciela A (fakty użytkowników są w kolejce)
  await b.reload()
  await expect(b.getByText('Węzły odpowiadające', { exact: true }).locator('..')).toContainText('2')

  await a.getByTestId('learn-now').click()
  await expect(a.getByTestId('learn-result')).toContainText('Intencje')
  await expect(a.getByTestId('learn-result')).not.toContainText('IQ')
  expect(sb.db.myc_node_stats.length).toBe(1)
  expect(sb.db.myc_growth.some((g) => g.event === 'train')).toBe(true)
  expect(errs).toEqual([])
  await ca.close()
  await cb.close()
})

test('offline: odpowiedź zapisuje się lokalnie bez błędów', async ({ page }) => {
  await page.route(/supabase\.co/, (r) => r.abort())
  await page.goto('./#/teach')
  await expect(page.getByTestId('sync')).toContainText('offline')
  await answerAny(page)
  const outbox = await page.evaluate(() => JSON.parse(localStorage.getItem('myc.outbox') ?? '[]').filter((o: { table: string }) => o.table === 'myc_answers').length)
  expect(outbox).toBeGreaterThanOrEqual(1)
})

test('wiedza: szeregi czasowe, zaufanie węzłów, ostatnie działanie i kanał aktywności', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const t0 = Date.now() - 3600_000
  const at = (m: number) => new Date(t0 + m * 60_000).toISOString()
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const L = '33333333-3333-4333-8333-333333333333'
  for (const [i, q] of ['k01', 'k02', 'k03', 'k04', 'k05'].entries()) {
    const truthA = ['tak', 'tak', 'nie', 'tak', 'nie'][i]
    sb.db.myc_answers.push({ question_id: q, node_id: A, answer: truthA, kind: 'browser', created_at: at(i * 5) })
    sb.db.myc_answers.push({ question_id: q, node_id: B, answer: truthA, kind: 'browser', created_at: at(i * 5 + 1) })
    sb.db.myc_answers.push({ question_id: q, node_id: L, answer: truthA === 'tak' ? 'nie' : 'tak', kind: 'browser', created_at: at(i * 5 + 2) })
  }
  sb.db.myc_node_stats.push({ node_id: A, kind: 'browser', label: 'x', acc: { intent: 0.7, intent_before: 0.67, sensor: 0.72, sensor_before: 0.71, iq: 96 }, n_answers: 15, created_at: at(30) })
  sb.db.myc_growth.push({ node_id: A, kind: 'browser', event: 'train', detail: { before: 95.5, after: 96 }, iq: 96, created_at: at(31) })
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  await p.goto('./#/knowledge')
  await expect(p.getByRole('heading', { level: 1, name: 'Wiedza' })).toBeVisible()
  await expect(p.getByTestId('nodes-table').locator('tbody tr')).toHaveCount(3)
  // kłamca L ma najniższe zaufanie
  const rows = p.getByTestId('nodes-table').locator('tbody tr')
  await expect(rows.first()).toContainText('trening') // A: ostatnie działanie = trening (najnowsze)
  await expect(p.getByTestId('timechart').first()).toHaveAttribute('data-points', /[1-9]/)
  await expect(p.getByTestId('activity')).toContainText('min temu')
  await expect(p.getByTestId('facts')).toContainText('prawda')
  await ctx.close()
})

test('wzrost: krok wzrostu loguje akcję i decyzję, link zaproszenia dołącza węzeł', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  await p.goto('./?join=1#/growth')
  await expect(p.getByRole('heading', { level: 1, name: 'Wzrost' })).toBeVisible()
  await expect.poll(() => sb.db.myc_growth.find((g) => g.event === 'join')?.detail).toEqual({ via: 'invite' })
  await p.getByTestId('grow-now').click()
  await expect(p.getByTestId('grow-result')).toContainText(/przyjęta|odrzucona/)
  const evs = sb.db.myc_growth.map((g) => g.event)
  expect(evs).toContain('action')
  expect(evs.some((e) => ['accept', 'reject', 'spawn', 'prune'].includes(e as string))).toBe(true)
  await expect(p.getByTestId('invite')).toHaveValue(/\?join=1#\/teach$/)
  await expect(p.getByTestId('activity')).toContainText('wybór celu')
  await ctx.close()
})

test('rozmowa w trybie lekkim: zawsze odpowiada – fakty, powitanie, pomoc, kalkulator, czytanie tekstu, „nie wiem” + nauka', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  sb.db.myc_answers.push({ question_id: 'k07', node_id: '11111111-1111-4111-8111-111111111111', answer: 'tak', created_at: new Date().toISOString() })
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  await p.goto('./#/chat')
  await expect(p.getByRole('heading', { level: 1, name: 'Rozmowa' })).toBeVisible()
  const say = async (t: string) => {
    const n = await p.getByTestId('reply').count()
    await p.getByTestId('chat-input').fill(t)
    await p.getByTestId('chat-send').click()
    await expect(p.getByTestId('reply')).toHaveCount(n + 1)
    return p.getByTestId('reply').last()
  }
  await say('Czy Ryga jest stolicą Łotwy?')
  await expect(p.getByTestId('lite-label').last()).toBeVisible()
  await expect(p.getByTestId('used-facts').last()).toContainText('Ryga', { useInnerText: false })
  await expect(await say('Cześć!')).toContainText('Jestem Mycelium AI')
  await expect(await say('Mam na imię Ola')).toContainText('Ola')
  await expect(await say('pomóż mi')).toContainText('potrafię')
  await expect(await say('ile to 15% z 240?')).toContainText('36')
  await expect(await say('Grzybnia to sieć strzępek grzyba. Rozkłada martwe drewno i liście. Strzępki wymieniają składniki z korzeniami drzew. Dzięki temu las jest zdrowszy i drzewa rosną szybciej.')).toContainText('Przeczytałem')
  await expect(await say('Jaki jest kurs bitcoina?')).toContainText('Nie wiem')
  await expect(await say('Nie wiem, sprawdź na giełdzie')).toContainText('Zapiszę')
  await p.getByTestId('chat-save').last().click()
  await expect.poll(() => sb.db.myc_user_questions.filter((q) => q.kind === 'qa').length).toBe(1)
  await ctx.close()
})

test('rozmowa: próg trafności – „co to jest X” bierze definicję z Wikisłownika, poniżej progu „nie wiem, naucz mnie”', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  // fakt o grzybni ma głos – wcześniej wracał na każde pytanie „co to jest …”
  sb.db.myc_answers.push({ question_id: 'k08', node_id: '11111111-1111-4111-8111-111111111111', answer: 'tak', created_at: new Date().toISOString() })
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  await ctx.route(/en\.wiktionary\.org\/w\/api\.php/, (route) => {
    const w = new URL(route.request().url()).searchParams.get('titles')
    return route.fulfill({ json: { query: { pages: [w === 'jeż' ? { title: w } : { title: w, missing: true }] } } })
  })
  await ctx.route(/en\.wiktionary\.org\/api\/rest_v1\/page\/definition\//, (route) => {
    const w = decodeURIComponent(route.request().url().split('/').pop()!)
    if (w === 'jeż') return route.fulfill({ json: { pl: [{ partOfSpeech: 'Noun', language: 'Polish', definitions: [{ definition: 'hedgehog' }] }] } })
    return route.fulfill({ status: 404, json: {} })
  })
  // polski Wikisłownik (API parse zwraca 200 z polem error, gdy strony brak)
  await ctx.route(/pl\.wiktionary\.org\/w\/api\.php/, (route) => {
    const w = new URL(route.request().url()).searchParams.get('page')
    if (w !== 'jeż') return route.fulfill({ json: { error: { code: 'missingtitle' } } })
    const wikitext = "== jeż ({{język polski}}) ==\n{{znaczenia}}\n''rzeczownik, rodzaj męskozwierzęcy''\n: (1.1) {{zool}} [[owadożerny]] [[ssak]] pokryty [[igła]]mi\n{{odmiana}}\n"
    return route.fulfill({ json: { parse: { title: w, wikitext } } })
  })
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('./#/chat')
  const say = async (t: string) => {
    const n = await p.getByTestId('reply').count()
    await p.getByTestId('chat-input').fill(t)
    await p.getByTestId('chat-send').click()
    await expect(p.getByTestId('reply')).toHaveCount(n + 1)
    return p.getByTestId('reply').last()
  }
  const jez = await say('Co to jest jeż?')
  await expect(jez).toContainText('Wikisłownik')
  await expect(jez).toContainText('Jeż to owadożerny ssak pokryty igłami.')
  await expect(jez).not.toContainText('Grzybnia')
  await expect(p.getByTestId('used-facts').last()).not.toContainText('Grzybnia', { useInnerText: false })
  await expect(await say('Co to jest zyrafogryf?')).toContainText('Nie wiem, naucz mnie')
  // pytanie, które tylko jednym słowem ociera się o fakt, nie dostaje tego faktu
  await expect(await say('Jaki jest kurs grzybni na giełdzie w Tokio?')).toContainText('Nie wiem, naucz mnie')
  // trafne pytanie dalej dostaje fakt
  await say('Czym jest grzybnia?')
  await expect(p.getByTestId('used-facts').last()).toContainText('podziemna', { useInnerText: false })
  expect(errs).toEqual([])
  await ctx.close()
})

test('słowniki: zawężanie kategorii słowa, domena→intencja, klasyfikuj słowo, słownik w rozmowie', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('./#/teach')
  const q = p.getByTestId('question')
  await expect(q).toHaveAttribute('data-qid', /.+/)
  // przewiń do pytania o słowo
  for (let i = 0; i < 200 && (await q.getAttribute('data-kind')) !== 'word'; i++) await p.keyboard.press('s')
  await expect(q).toHaveAttribute('data-kind', 'word')
  const wq = (await q.getAttribute('data-qid'))!
  await q.locator('button[data-cat="animal"]').click()
  await q.getByTestId('word-next').click()
  await expect(q.locator('button[data-cat="mammal"]')).toBeVisible() // zawężenie: podkategorie zwierząt
  await q.locator('button[data-cat="mammal"]').click()
  await q.getByTestId('word-next').click()
  await expect(q.locator('button[data-cat="dog"]')).toBeVisible()
  await q.getByTestId('word-next').click() // żadna z psów/kotów…
  await expect(q).not.toHaveAttribute('data-qid', wq)
  const mine = sb.db.myc_answers.filter((r) => String(r.question_id).startsWith(wq))
  expect(mine.every((r) => /^w(?:[0-9]{5}|[a-z][0-9]{4})c[0-9]{3}$/.test(String(r.question_id)))).toBe(true)
  expect(mine.filter((r) => r.answer === 'tak')).toHaveLength(2)
  expect(mine.length).toBeGreaterThan(9 + 4)
  // domena → intencja
  for (let i = 0; i < 300 && (await q.getAttribute('data-kind')) !== 'intent'; i++) await p.keyboard.press('s')
  await expect(q).toHaveAttribute('data-kind', 'intent')
  await expect(q.locator('button[data-answer]')).toHaveCount(0)
  await q.locator('button[data-domain="utility"]').click()
  await expect(q.locator('button[data-answer="weather"]')).toBeVisible()
  // klasyfikuj słowo
  await p.getByTestId('word-input').fill('hedgehog')
  await expect(p.getByTestId('word-pred')).toContainText('Zwierzę')
  // jeż/hedgehog to ssak (owadożerny), nie gryzoń (poprawka błędu WordNetu: sens „porcupine”)
  await expect(p.getByTestId('word-pred')).toContainText(/w słowniku: Zwierzę › Ssak(?! › Gryzoń)/)
  await p.getByTestId('word-correct').click()
  expect(sb.db.myc_user_questions.at(-1)).toMatchObject({ kind: 'word', text: 'hedgehog' })
  // słownik w rozmowie
  await p.goto('./#/chat')
  await p.getByTestId('chat-input').fill('Co to jest wombat?')
  await p.getByTestId('chat-send').click()
  await expect(p.getByTestId('used-facts').last()).toContainText('słownik')
  expect(errs).toEqual([])
  await ctx.close()
})

test('zadania captcha: siatka, kosze, litery, kolejność, obrót, pary → odpowiedzi i statystyki', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('./#/tasks')
  await expect(p.getByRole('heading', { level: 1, name: 'Zadania' })).toBeVisible()
  const t = p.getByTestId('task')
  const n = (re: RegExp) => sb.db.myc_answers.filter((r) => re.test(String(r.question_id))).length
  // siatka
  await t.locator('[data-img]').nth(0).click()
  await t.locator('[data-img]').nth(4).click()
  await t.getByTestId('task-submit').click()
  await expect.poll(() => n(/^cg(?:[0-9]{5}|[a-z][0-9]{4})k[0-9]$/)).toBe(9)
  // kosze: dotknij obrazek, potem kosz
  await p.locator('[data-task="cb"][role="tab"]').click()
  for (let i = 0; i < 4; i++) {
    await t.locator('.border-dashed [data-img]').first().click()
    await t.locator('[data-bin]').nth(i % 4).click()
  }
  await t.getByTestId('task-submit').click()
  await expect.poll(() => n(/^cg/)).toBe(9 + 12)
  // litery
  await p.locator('[data-task="ct"][role="tab"]').click()
  await t.getByTestId('transcribe-input').fill('abcd')
  await t.getByTestId('task-submit').click()
  await expect.poll(() => n(/^ct/)).toBe(4)
  // kolejność
  await p.locator('[data-task="co"][role="tab"]').click()
  await t.locator('[data-up="1"]').click()
  await t.getByTestId('task-submit').click()
  await expect.poll(() => sb.db.myc_answers.find((r) => String(r.question_id).startsWith('co'))?.answer).toBe('bacd')
  // obrót
  await p.locator('[data-task="cr"][role="tab"]').click()
  await t.getByTestId('rot-right').click()
  await t.getByTestId('task-submit').click()
  await expect.poll(() => sb.db.myc_answers.find((r) => String(r.question_id).startsWith('cr'))?.answer).toBe('prawo')
  // pary
  await p.locator('[data-task="cm"][role="tab"]').click()
  const pl = await t.locator('[data-pl]').first().getAttribute('data-pl')
  await t.locator(`[data-pl="${pl}"]`).click()
  await t.locator(`[data-en="${pl}"]`).click()
  await t.getByTestId('task-submit').click()
  await expect.poll(() => n(/^cm/)).toBe(4)
  expect(sb.db.myc_answers.find((r) => r.question_id === pl)?.answer).toBe('tak')
  await expect(p.getByTestId('task-totals')).toContainText('litery: 4')
  await p.getByTestId('learn-vision').click()
  await expect.poll(() => sb.db.myc_node_stats.length).toBe(1)
  expect(errs).toEqual([])
  await ctx.close()
})

test('wizualizacja grzybni: prawdziwe węzły i połączenia, nowy węzeł wyrasta na żywo', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const now = new Date().toISOString()
  for (const q of ['k01', 'k02']) for (const n of [A, B]) sb.db.myc_answers.push({ question_id: q, node_id: n, answer: 'tak', kind: 'browser', created_at: now })
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  await p.goto('./#/overview')
  const viz = p.getByTestId('mycelium-viz')
  await expect(viz.locator(`[data-node="${A}"]`)).toHaveCount(1)
  await expect(viz).toHaveAttribute('data-edges', '1')
  await expect(viz.locator('[data-node="33333333-3333-4333-8333-333333333333"]')).toHaveCount(0)
  // nowy węzeł dołącza (prawdziwy wpis w bazie) → po synchronizacji pojawia się i wyrasta
  sb.db.myc_growth.push({ node_id: '33333333-3333-4333-8333-333333333333', kind: 'python', event: 'join', detail: {}, iq: null, created_at: now })
  await p.evaluate(() => dispatchEvent(new Event('online')))
  await expect(viz.locator('[data-node="33333333-3333-4333-8333-333333333333"].myc-pop')).toHaveCount(1)
  await ctx.close()
})

test('zadania: wolne qa.json nie psuje strony (wyścig wczytywania)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  await ctx.route(/data\/qa\.json/, async (r) => {
    await new Promise((res) => setTimeout(res, 1500))
    await r.continue()
  })
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('./#/tasks')
  await expect(p.getByTestId('task')).toBeVisible()
  await p.waitForTimeout(2000)
  expect(errs).toEqual([])
  await ctx.close()
})

// Kolejka obliczeń w pamięci (tylko test): te same RPC co w Supabase, z filtrami PostgREST eq./in.
function computeBackend() {
  const db: Record<string, Row[]> = { myc_models: [], myc_jobs: [], myc_results: [] }
  const blobs = new Map<string, Buffer>()
  let id = 1
  const match = (r: Row, url: URL) =>
    [...url.searchParams].every(([k, v]) => {
      if (['select', 'order', 'limit'].includes(k)) return true
      if (v.startsWith('eq.')) return String(r[k]) === v.slice(3)
      if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(r[k]))
      return true
    })
  const rest = async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const name = url.pathname.split('/').pop()!
    const a = (req.postDataJSON() ?? {}) as Row
    const now = new Date().toISOString()
    if (url.pathname.includes('/rpc/')) {
      if (name === 'myc_weights_exist') return route.fulfill({ json: blobs.has(a.p_path as string) })
      if (name === 'myc_reserve') {
        const latest = Math.max(-1, ...db.myc_models.filter((m) => m.model === a.p_model).map((m) => m.version as number))
        return route.fulfill({ json: latest === a.p_expected ? { ok: true, version: latest + 1 } : { ok: false, reason: 'stale' } })
      }
      if (name === 'myc_propose') {
        const latest = Math.max(-1, ...db.myc_models.filter((m) => m.model === a.p_model).map((m) => m.version as number))
        if (latest + 1 !== a.p_version) return route.fulfill({ json: { ok: false, reason: 'stale' } })
        if (!(a.p_eval_n as number) || !/^[0-9a-f]{64}$/.test(String(a.p_eval_sha))) return route.fulfill({ json: { ok: false, reason: 'eval set mismatch' } })
        const cur = db.myc_models.find((m) => m.model === a.p_model && m.version === latest)
        if (cur && (a.p_acc as number) < (cur.acc as number)) return route.fulfill({ json: { ok: false, reason: 'regression', cur_acc: cur.acc } })
        db.myc_models.push({ model: a.p_model, version: a.p_version, path: a.p_path, acc: a.p_acc, val_acc: a.p_val, meta: a.p_meta, n_updates: (a.p_accepted as number[]).length, n_rejected: (a.p_rejected as number[]).length, samples: 0, flops: 0, created_at: now })
        for (const r of db.myc_results) if ((a.p_accepted as number[]).includes(r.id as number)) r.status = 'accepted'
        return route.fulfill({ json: { ok: true, version: a.p_version } })
      }
      if (name === 'myc_post_round') {
        if (db.myc_jobs.some((j) => j.model === a.p_model && j.version === a.p_version && j.kind === 'train' && ['open', 'leased'].includes(j.status as string))) return route.fulfill({ json: 0 })
        for (const j of a.p_jobs as Row[]) db.myc_jobs.push({ id: id++, model: a.p_model, version: a.p_version, kind: j.kind, params: j.params, status: 'open' })
        return route.fulfill({ json: (a.p_jobs as Row[]).length })
      }
      if (name === 'myc_claim') {
        const j = db.myc_jobs.find((x) => x.status === 'open')
        if (j) j.status = 'leased'
        return route.fulfill({ json: j ? [j] : [] })
      }
      if (name === 'myc_submit') {
        const j = db.myc_jobs.find((x) => x.id === a.p_job)!
        j.status = 'done'
        db.myc_results.push({ id: id++, job_id: j.id, model: j.model, version: j.version, kind: j.kind, node_id: a.p_node, contributor_id: a.p_contrib, payload: a.p_payload, metrics: a.p_metrics, samples: a.p_samples, flops: a.p_flops, ms: a.p_ms, backend: a.p_backend, status: ['train', 'hparam'].includes(j.kind as string) ? 'pending' : 'info', created_at: now })
        return route.fulfill({ json: id })
      }
      if (name === 'myc_compute_stats') {
        const rs = db.myc_results
        const c = rs.length ? [{ contributor_id: rs[0].contributor_id, jobs: rs.length, samples: rs.reduce((s, r) => s + (r.samples as number), 0), flops: rs.reduce((s, r) => s + (r.flops as number), 0), gpu_flops: 0, cpu_flops: 0, accepted: 0, rejected: 0, last: now }] : []
        return route.fulfill({ json: { contributors: c, hourly: [], backends: {}, queue: { open: 0, leased: 0, done: rs.length } } })
      }
      return route.fulfill({ json: [] })
    }
    if (db[name]) return route.fulfill({ json: db[name].filter((r) => match(r, url)).sort((x, y) => (url.searchParams.get('order')?.includes('desc') ? (y.version as number) - (x.version as number) : 0)) })
    return route.fulfill({ json: [] })
  }
  const storage = async (route: Route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(/.*myc-models\//, '')
    if (req.method() === 'POST') {
      blobs.set(path, req.postDataBuffer()!)
      return route.fulfill({ status: 200, json: { Key: path } })
    }
    const b = blobs.get(path)
    return b ? route.fulfill({ status: 200, body: b, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404, body: '' })
  }
  return {
    db,
    attach: async (ctx: BrowserContext) => {
      await ctx.route(/supabase\.co\/rest\/v1\//, rest)
      await ctx.route(/supabase\.co\/storage\/v1\//, storage)
    },
  }
}

test('sesja: WASM w wątkach roboczych, pomiar, kolejka zadań, wersja modelu, pauza, karta w tle', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  test.setTimeout(180_000)
  const sb = computeBackend()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  const errs: string[] = []
  p.on('pageerror', (e) => errs.push(String(e)))
  await p.goto('./#/session')
  await expect(p.getByRole('heading', { level: 1, name: 'Sesja' })).toBeVisible()
  await expect(p.getByTestId('privacy')).toContainText('NIE zbiera')
  await p.getByTestId('gpu-toggle').uncheck()
  await p.getByTestId('session-btn').click()
  await expect(p.getByTestId('session-status')).toHaveAttribute('data-running', '1')
  await expect(p.getByTestId('backend').first()).toContainText('wasm', { timeout: 30_000 })
  await expect(p.getByTestId('bench')).toContainText('wasm', { timeout: 30_000 })
  // wersja 0 → runda → prawdziwy trening odłamka → wynik z deltą i metrykami
  await expect.poll(() => sb.db.myc_results.filter((r) => r.kind === 'train').length, { timeout: 120_000 }).toBeGreaterThanOrEqual(1)
  const r = sb.db.myc_results.find((x) => x.kind === 'train')!
  expect(String(r.payload).length).toBeGreaterThan(1000)
  expect(r.backend).toBe('wasm')
  expect(r.samples as number).toBeGreaterThan(0)
  expect((r.metrics as { val_acc: number }).val_acc).toBeGreaterThan(0.2)
  expect(sb.db.myc_models.some((m) => m.version === 0)).toBe(true)
  // karta w tle → wstrzymanie
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(p.getByTestId('session-status')).toContainText('karta w tle')
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(p.getByTestId('session-status')).toHaveAttribute('data-running', '1')
  await p.getByTestId('session-btn').click()
  await expect(p.getByTestId('session-status')).toHaveAttribute('data-running', '0')
  await p.getByTestId('throttle').fill('30')
  expect(await p.evaluate(() => JSON.parse(localStorage.getItem('myc.session')!).throttle)).toBeCloseTo(0.3)
  expect(await p.evaluate(() => JSON.parse(localStorage.getItem('myc.compute')!).cpu)).toBeCloseTo(0.3)
  expect(errs).toEqual([])
  await ctx.close()
})

test('rozmowa: liczby z Wikidata – stolica Polski, potem „ile mieszkańców ma to miasto” (bez zgadywania)', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const calls: string[] = []
  await ctx.route(/www\.wikidata\.org\/w\/api\.php/, (route) => {
    const u = new URL(route.request().url()).searchParams
    calls.push(`${u.get('action')}:${u.get('search') ?? u.get('entity') ?? u.get('ids')}`)
    const a = u.get('action')
    if (a === 'wbsearchentities') {
      const s = (u.get('search') ?? '').toLowerCase()
      const hits = s.startsWith('pols') ? [{ id: 'Q36', label: 'Polska', description: 'państwo w Europie' }] : s.startsWith('warsz') ? [{ id: 'Q270', label: 'Warszawa', description: 'stolica Polski' }] : []
      return route.fulfill({ json: { search: hits } })
    }
    if (a === 'wbgetclaims') {
      const e = u.get('entity')
      const pr = u.get('property')!
      const q = (amount: string, time: string, rank = 'normal') => ({ rank, mainsnak: { datavalue: { value: { amount, unit: '1' } } }, qualifiers: { P585: [{ datavalue: { value: { time } } }] } })
      const claims: Record<string, unknown[]> = {}
      if (e === 'Q36' && pr === 'P36') claims.P36 = [{ rank: 'normal', mainsnak: { datavalue: { value: { id: 'Q270' } } } }]
      if (e === 'Q270' && pr === 'P1082') claims.P1082 = [q('+1860281', '+2021-12-31T00:00:00Z'), q('+1862402', '+2024-01-01T00:00:00Z')]
      return route.fulfill({ json: { claims } })
    }
    if (a === 'wbgetentities') return route.fulfill({ json: { entities: { Q270: { labels: { pl: { value: 'Warszawa' } } } } } })
    return route.fulfill({ json: {} })
  })
  const p = await ctx.newPage()
  await p.goto('./#/chat')
  const say = async (t: string) => {
    const n = await p.getByTestId('reply').count()
    await p.getByTestId('chat-input').fill(t)
    await p.getByTestId('chat-send').click()
    await expect(p.getByTestId('reply')).toHaveCount(n + 1)
    return p.getByTestId('reply').last()
  }
  const cap = await say('Jaka jest stolica Polski?')
  await expect(cap).toContainText('Warszawa')
  await expect(cap).toContainText('Wikidata Q36')
  const pop = await say('A ile mieszkańców ma to miasto?')
  await expect(pop).toContainText('1 862 402')
  await expect(pop).toContainText('stan na 2024')
  await expect(pop).toContainText('Wikidata Q270')
  await expect(pop).not.toContainText('3,7')
  expect(calls).toContain('wbgetclaims:Q270')
})

test('zostań węzłem: zgoda, auto-wznawianie po odświeżeniu, zaproszenie z QR, polecenia, węzły w czasie, ranking', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  let mine = ''
  // dzień w strefie Amsterdam (jak w aplikacji) – inaczej test pada między 22:00 a 24:00 UTC
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })
  await ctx.route(/rest\/v1\/rpc\/myc_node_daily/, (r) => r.fulfill({ json: [{ day, active: 3, new_nodes: 1, total: 5 }] }))
  await ctx.route(/rest\/v1\/rpc\/myc_referrals/, (r) => r.fulfill({ json: mine ? [{ ref: mine, joins: 2, last: new Date().toISOString() }] : [] }))
  await ctx.route(/rest\/v1\/rpc\/myc_compute_stats/, (r) => r.fulfill({ json: { contributors: [{ contributor_id: '22222222-2222-4222-8222-222222222222', jobs: 4, samples: 12000, flops: 1e9, accepted: 4 }] } }))
  const p = await ctx.newPage()
  await p.goto('./#/node')
  await expect(p.getByRole('heading', { level: 1, name: 'Zostań węzłem' })).toBeVisible()
  await expect(p.getByTestId('qr')).toBeVisible()
  const invite = await p.getByTestId('invite-ref').inputValue()
  mine = /ref=([0-9a-f]{8})/.exec(invite)?.[1] ?? ''
  expect(mine).toHaveLength(8)
  await expect(p.getByTestId('widget-code')).toContainText(`data-ref="${mine}"`)
  await expect(p.getByTestId('one-liner')).toContainText('mycelium-node.pyz --join')
  await expect(p.getByTestId('leaderboard')).toContainText('22222222')
  await p.getByTestId('node-on').click()
  await expect(p.getByTestId('node-state')).toHaveAttribute('data-on', '1')
  // po odświeżeniu: zgoda zapamiętana, sesja wznawia się sama; polecenia policzone
  await p.reload()
  await expect(p.getByTestId('node-state')).toHaveAttribute('data-on', '1')
  await expect(p.getByTestId('node-state')).toContainText('pracuje')
  await expect(p.getByText('Polecone przez Ciebie').locator('..')).toContainText('2')
  await expect(p.getByTestId('kpi-active-today')).toContainText('3')
  await expect(p.getByTestId('kpi-active-today')).toContainText('Węzły z dowolną aktywnością dziś')
  await expect(p.getByTestId('node-defs')).toContainText('węzły liczące (24 h)')
  // sekcje zwijane: ranking otwarty, instrukcje stałego węzła zwinięte do dotknięcia
  await expect(p.getByTestId('sec-time')).toHaveAttribute('open', '')
  await expect(p.getByTestId('one-liner')).toBeHidden()
  await p.getByTestId('sec-install').locator('summary').click()
  await expect(p.getByTestId('one-liner')).toBeVisible()
  await p.getByTestId('node-off').click()
  await expect(p.getByTestId('node-state')).toHaveAttribute('data-on', '0')
  await ctx.close()
})

test('widżet: nic nie działa przed zgodą, po kliknięciu ramka z ref i autostartem', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const sb = mockSupabase()
  const ctx = await browser.newContext()
  await sb.attach(ctx)
  const p = await ctx.newPage()
  await p.goto('./')
  const base = new URL('./', p.url()).href
  await p.route(base + 'partner.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><h1>Strona partnera</h1></body></html>' }))
  await p.goto(base + 'partner.html')
  await p.setContent(`<html><body><h1>Strona partnera</h1><script src="${base}widget.js" data-ref="abcdef12" data-lang="pl"></script></body></html>`)
  await expect(p.locator('[data-mycelium-widget]')).toContainText('Zostań węzłem')
  await expect(p.locator('iframe')).toHaveCount(0)
  await p.getByRole('button', { name: 'Zostań węzłem' }).click()
  const f = p.locator('iframe')
  await expect(f).toHaveAttribute('src', /embed=1&autostart=1&join=1&ref=abcdef12/)
  await expect(p.frameLocator('iframe').getByTestId('node-state')).toHaveAttribute('data-on', '1', { timeout: 20000 })
  await ctx.close()
})
