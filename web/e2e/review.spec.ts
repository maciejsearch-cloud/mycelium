import { expect, test } from '@playwright/test'

// Zakładka Weryfikuj bez backendu: odpowiedzi RPC podstawione w teście (UI + kształt zapisu).
test('Weryfikuj: tryb właściciela, sprzeczny strzępek, poprawka trafia do RPC z kluczem', async ({ page }) => {
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  let resolved = false
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    const body = route.request().postData() ? (JSON.parse(route.request().postData()!) as Record<string, unknown>) : {}
    if (u.pathname.includes('/rpc/')) calls.push({ fn, body })
    if (fn === 'myc_review_whoami') return route.fulfill({ json: body.p_key === 'klucz-testowy' ? { room: 'main', reviewer: 'owner', weight: 1 } : { room: null, reviewer: null, weight: null } })
    if (fn === 'myc_frags' && u.search.includes('status=eq.conflict') && !resolved)
      return route.fulfill({
        json: [
          { id: 11, layer: 0, subj: 'Warszawa', rel: 'populacja', obj: '1862402', source: 'wikidata', source_ref: 'Q270', trust: 0.9, status: 'conflict', n_support: 2 },
          { id: 12, layer: 0, subj: 'Warszawa', rel: 'populacja', obj: '3700000', source: 'chat', trust: 0.4, status: 'conflict', n_support: 1 },
        ],
      })
    if (fn === 'myc_review_submit') resolved = true
    if (fn === 'myc_review_submit') return route.fulfill({ json: { id: 1, room: 'main', reviewer: 'owner', weight: 1 } })
    return route.fulfill({ json: [] })
  })
  await page.goto('./#/weryfikuj')
  await expect(page.getByTestId('review-mode')).toContainText('Tylko podgląd')
  await expect(page.getByTestId('btn-approve')).toBeDisabled()
  await page.getByTestId('owner-key').fill('klucz-testowy')
  await page.getByTestId('owner-key-save').click()
  await expect(page.getByTestId('review-mode')).toContainText('Właściciel')
  const item = page.getByTestId('review-item')
  await expect(item).toHaveAttribute('data-type', 'fragment')
  await expect(item).toContainText('Warszawa – liczba ludności – ?')
  await expect(page.getByTestId('review-evidence')).toContainText('sprzeczny z #12')
  await page.getByTestId('btn-correct').click()
  await page.getByTestId('correct-input').fill('1863056')
  await page.getByTestId('correct-save').click()
  await expect(page.getByTestId('undo-bar')).toContainText('poprawione')
  const s = calls.find((c) => c.fn === 'myc_review_submit')!
  expect(s.body.p_key).toBe('klucz-testowy')
  expect(s.body.p_item).toMatchObject({ type: 'fragment', ref: '11', verdict: 'correct', truth: '1863056', ai: '1862402' })
  // rodzeństwo w sprzeczności znika razem z rozstrzygniętą pozycją
  await expect(page.locator('[data-testid=review-item][data-type=fragment]')).toHaveCount(0)
  // dalej w kolejce prawdziwe błędy modelu intencji na zbiorze testowym CLINC150
  await expect(item).toHaveAttribute('data-type', 'model')
})

test('Wiedza: graf strzępków z pustej bazy pokazuje uczciwy pusty stan', async ({ page }) => {
  await page.route(/supabase\.co\/rest\/v1\//, (r) => r.fulfill({ json: [] }))
  await page.goto('./#/knowledge')
  await expect(page.getByTestId('frag-layer-0')).toHaveText('0')
  await expect(page.getByText('Jeszcze brak strzępków.')).toBeVisible()
})

// Kategorie: wersja taksonomii zbudowana w teście z prawdziwego inputs.json (słownik WordNet) + grupa bez nazwy „~jalapa”
// powtórzona na 3 poziomach – dokładnie przypadek ze zrzutu („~jalapa › ~jalapa › ~jalapa”).
test('Weryfikuj › Kategorie: kandydaci AI z %, ścieżka WordNet, własna kategoria i „to nie jest słowo”', async ({ page }) => {
  test.setTimeout(90_000)
  const fs = await import('node:fs')
  const inp = JSON.parse(fs.readFileSync('public/data/taxo/inputs.json', 'utf8')) as { words: [string, string][]; taxonomy: { id: string; parent: string | null; pl: string; en: string }[]; gold: number[] }
  const T = inp.taxonomy
  const root = (g: number): number => {
    let t = T[g]
    while (t.parent) t = T.find((x) => x.id === t.parent)!
    return T.indexOf(t)
  }
  const nodes: Record<string, unknown>[] = []
  const nodeOf = new Map<number, number>()
  const mk = (p: number, lvl: number, pl: string, en: string, src = 'hyper') => (nodes.push({ id: nodes.length, p, lvl, n: 0, coh: 0.5, top: [], name_pl: pl, name_en: en, cov: src === 'hyper' ? 0.6 : 0.1, src }), nodes.length - 1)
  T.forEach((t, g) => !t.parent && nodeOf.set(g, mk(-1, 0, t.pl, t.en)))
  T.forEach((t, g) => t.parent && nodeOf.set(g, mk(nodeOf.get(root(g))!, 1, t.pl, t.en)))
  const ceik = inp.words.findIndex(([w]) => w === 'ceik')
  const a = mk(nodeOf.get(root(inp.gold[ceik]))!, 1, '~jalapa', '~jalapa', 'medoid')
  const b = mk(a, 2, '~jalapa', '~jalapa', 'medoid')
  const c = mk(b, 3, '~jalapa', '~jalapa', 'medoid')
  const leaf = inp.gold.map((g, i) => (i === ceik ? c : nodeOf.get(g)!))
  leaf.forEach((l, i) => {
    for (let x = l; x >= 0; x = nodes[x].p as number) {
      const n = nodes[x] as { n: number; top: number[] }
      n.n++
      if (n.top.length < 8) n.top.push(i)
    }
  })
  const ver = { version: 1, params: { beta: 4 }, metrics: {}, nodes, leaf, margin: leaf.map((_, i) => (i === ceik ? 0.001 : 0.5)), n_corr: 0 }
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  await page.route(/supabase\.co\/(rest|storage)\/v1\//, async (route) => {
    const u = new URL(route.request().url())
    const fn = u.pathname.split('/').pop()!
    const body = route.request().postData() ? (JSON.parse(route.request().postData()!) as Record<string, unknown>) : {}
    if (u.pathname.includes('/rpc/')) calls.push({ fn, body })
    if (fn === 'myc_review_whoami') return route.fulfill({ json: body.p_key === 'klucz-testowy' ? { room: 'main', reviewer: 'owner', weight: 1 } : { room: null, reviewer: null, weight: null } })
    if (fn === 'myc_tax_list') return route.fulfill({ json: [{ id: 1, version: 1, status: 'published', path: 'taxo/v1-test.json', acc: 0.5, params: { beta: 4 }, metrics: {}, n_corr: 0, created_at: '2026-10-24T00:00:00Z' }] })
    if (u.pathname.endsWith('/myc-models/taxo/v1-test.json')) return route.fulfill({ json: ver })
    if (fn === 'myc_review_submit') return route.fulfill({ json: { id: calls.length, room: 'main', reviewer: 'owner', weight: 1 } })
    return route.fulfill({ json: [] })
  })
  await page.goto('./#/weryfikuj')
  await page.getByTestId('owner-key').fill('klucz-testowy')
  await page.getByTestId('owner-key-save').click()
  await page.getByRole('button', { name: /^Kategorie/ }).click()
  const item = page.getByTestId('review-item')
  await expect(page.getByTestId('review-title')).toContainText('ceik')
  // grupy automatyczne (tu: „~jalapa” i nazwy zgadnięte) nie są pokazywane – „AI mówi” = kategoria seed ze źródłem
  await expect(page.getByTestId('review-ai')).not.toContainText('jalapa')
  await expect(page.getByTestId('review-ai')).not.toContainText('≈')
  await expect(page.getByTestId('review-ai')).toHaveText('istota żywa › zwierzęta › bezkręgowce › stawonogi › owady · seed (źródło: WordNet/Wikidata)')
  // kandydaci modelu z pewnością w % i ścieżka słownikowa
  await expect(page.getByTestId('cand-model').getByTestId('cand').first()).toContainText('%', { timeout: 30_000 })
  const n = await page.getByTestId('cand-model').getByTestId('cand').count()
  expect(n).toBeGreaterThanOrEqual(2)
  expect(n).toBeLessThanOrEqual(5)
  await expect(page.getByTestId('cand-model')).not.toContainText('≈')
  await expect(page.getByTestId('cand-wordnet')).toContainText('stawonogi › owady')
  await page.getByTestId('cand-peek').first().click()
  await expect(page.getByTestId('cand-members')).toContainText(',')
  // własna kategoria: podpowiedzi PL i EN, rodzic, nowa nazwa
  await page.getByTestId('cat-search').fill('butterfly')
  await expect(page.getByTestId('cat-hit').first()).toContainText('motyl')
  await page.getByTestId('cat-search').fill('owad')
  await page.getByTestId('cat-hit').filter({ hasText: 'Owad' }).first().locator('xpath=..').getByTestId('cat-as-parent').click()
  await page.getByTestId('new-cat-name').fill('rusałki')
  await page.getByTestId('new-cat-use').click()
  await expect(page.getByTestId('picked')).toContainText('owady › rusałki')
  await page.getByTestId('correct-save').click()
  await expect(page.getByTestId('undo-bar')).toContainText('poprawione')
  const s = calls.find((x) => x.fn === 'myc_review_submit')!
  expect(s.body.p_item).toMatchObject({ type: 'category', ref: `tw:${ceik}`, verdict: 'correct' })
  expect(String((s.body.p_item as { truth: string }).truth)).toMatch(/^own:rusałki\|s:\d+$/)
  // następne słowo: „to nie jest słowo / błąd w słowniku” → odrzucenie z truth=notword
  // (najpierw grupy do nazwania – pomijamy je przyciskiem „Pomiń”)
  await expect(item).toHaveAttribute('data-type', 'category')
  for (let k = 0; k < 15 && !(await page.getByTestId('btn-notword').isVisible()); k++) {
    await page.getByTestId('btn-skip').click()
    await expect(page.getByTestId('btn-skip')).toBeEnabled()
  }
  await page.getByTestId('btn-notword').click()
  await expect(page.getByTestId('undo-bar')).toContainText('odrzucone')
  const s2 = calls.filter((x) => x.fn === 'myc_review_submit').pop()!
  expect(s2.body.p_item).toMatchObject({ type: 'category', verdict: 'reject', truth: 'notword' })
})

test('Taksonomia: kategorie i fakty startowe (seed) z liczbami ze źródeł i stroną licencji', async ({ page }) => {
  await page.route(/supabase\.co\/rest\/v1\//, (r) => r.fulfill({ json: [] }))
  await page.goto('./#/taxonomy')
  const card = page.getByTestId('seed-card')
  await expect(card).toBeVisible()
  expect(Number(await page.getByTestId('seed-cats').innerText())).toBeGreaterThan(100)
  expect(Number(await page.getByTestId('seed-mapped').innerText())).toBeGreaterThan(5000)
  expect(Number(await page.getByTestId('seed-facts').innerText())).toBeGreaterThan(3000)
  await expect(page.getByTestId('attribution')).toContainText('CC0 1.0')
  await expect(page.getByTestId('attribution')).toContainText('CC BY-SA 4.0')
  await expect(page.getByTestId('attribution')).toContainText('plWordNet')
})
