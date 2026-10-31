import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  // pusta wspólna baza (CI bez sieci do Supabase): strona ma pokazać stany puste
  await page.route(/supabase\.co\/rest\/v1\//, (r) => r.fulfill({ json: [] }))
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  ;(page as unknown as { errors: string[] }).errors = errors
})

test.afterEach(async ({ page }) => {
  expect((page as unknown as { errors: string[] }).errors).toEqual([])
})

test('przegląd: KPI i szeregi czasowe tylko z prawdziwych pomiarów', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Przegląd', exact: true })).toBeVisible()
  await expect(page.getByTestId('source').first()).toContainText('tryb nagrany')
  await expect(page.getByText('Benchmark (ai-bench, nagrany)')).toBeVisible()
  // jeden nagrany przebieg ai-bench → wyniki zadań zamiast wykresu z 1 punktem; trafność w przeglądarce: pusta baza → pusty stan
  await expect(page.getByTestId('bench-scores')).toContainText('tylko jeden nagrany przebieg')
  await expect(page.getByTestId('empty').first()).toContainText('brak danych jeszcze')
  // bez sztucznej skali „IQ”; każda liczba ma linię źródła
  await expect(page.getByText(/\bIQ\b/)).toHaveCount(0)
  await expect(page.getByTestId('kpi-bench').getByTestId('src')).toContainText('snapshot.json')
  await expect(page.getByTestId('kpi-browser-acc')).toContainText('n=')
  // jednoznaczna nazwa: Start liczy węzły z wynikiem obliczeń, strona Węzeł – z dowolną aktywnością
  await expect(page.getByTestId('kpi-nodes')).toContainText('Węzły liczące (24 h)')
  // żadnych zabawkowych/syntetycznych sekcji
  for (const gone of ['Benchmarki', 'Ewolucja', 'Krzywe uczenia', 'Grzybnia i agenci']) await expect(page.getByRole('button', { name: gone })).toHaveCount(0)
})

test('nawigacja po wszystkich sekcjach bez błędów', async ({ page }, info) => {
  await page.goto('./')
  const mobile = info.project.name === 'mobile'
  for (const [label, heading, tab] of [
    ['Ucz AI', 'Ucz AI', 'ucz'],
    ['Prawdziwe AI', 'Prawdziwe AI', 'wiecej'],
    ['Postępy projektu', 'Postępy projektu', 'wiecej'],
  ]) {
    if (mobile) {
      // telefon: dolny pasek (5 grup + „Więcej”), potem podzakładka albo arkusz „Więcej”
      await page.getByTestId(`tab-${tab}`).click()
      const where = tab === 'wiecej' ? page.getByTestId('more-sheet') : page.getByTestId('subtabs')
      await where.getByRole('button', { name: label }).click()
    } else await page.getByRole('button', { name: label }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
  await expect(page.getByTestId('phases')).toContainText('Faza 3')
})

test('nawigacja: stare adresy #/… działają, dolny pasek na telefonie, Konto w rogu', async ({ page }, info) => {
  for (const [hash, heading] of [
    ['tasks', 'Zadania'],
    ['session', 'Sesja'],
    ['verify', 'Dowody'],
    ['knowledge', 'Wiedza'],
    ['konto', 'Konto'],
  ]) {
    await page.goto(`./#/${hash}`)
    await page.reload() // pełne wejście z adresu (jak link), nie tylko zmiana # w tej samej karcie
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
  }
  if (info.project.name !== 'mobile') return
  // żadna strona nie rozpycha się w poziomie (inaczej telefon pomniejsza widok i dolny pasek ucieka)
  for (const hash of ['verify', 'weryfikuj', 'knowledge', 'ai', 'taxonomy', 'overview']) {
    await page.goto(`./#/${hash}`)
    await page.reload()
    await page.waitForTimeout(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && innerWidth <= 450)).toBe(true)
  }
  const bar = page.getByTestId('bottom-bar')
  await expect(bar.getByRole('button')).toHaveCount(6)
  for (const l of ['Start', 'Rozmowa', 'Ucz', 'Weryfikuj', 'Węzeł', 'Więcej']) await expect(bar).toContainText(l)
  await page.goto('./#/chat')
  await expect(page.getByTestId('tab-rozmowa')).toHaveAttribute('aria-current', 'page')
  await page.getByTestId('subtabs').getByRole('button', { name: 'Kręgi' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Kręgi' })).toBeVisible()
  await page.getByTestId('tab-wezel').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Zostań węzłem' })).toBeVisible()
  await page.getByTestId('account-icon').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Konto' })).toBeVisible()
  // „Weryfikacja” to teraz „Dowody” – nie myli się z „Weryfikuj”
  await page.getByTestId('tab-wiecej').click()
  await expect(page.getByTestId('more-sheet')).toContainText('Dowody')
  await expect(page.getByTestId('more-sheet')).not.toContainText('Weryfikacja')
})

test('budżet wydajności: JS na starcie < 900 KB (bez kompresji), LCP < 2.5 s', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'mierzone raz')
  let bytes = 0
  page.on('response', async (r) => {
    if (r.url().endsWith('.js')) bytes += Number((await r.headerValue('content-length')) ?? (await r.body()).length)
  })
  await page.goto('./')
  await expect(page.getByText('Benchmark (ai-bench, nagrany)')).toBeVisible()
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((res) => {
        new PerformanceObserver((l) => {
          const e = l.getEntries()
          res(e[e.length - 1].startTime)
        }).observe({ type: 'largest-contentful-paint', buffered: true })
        setTimeout(() => res(-1), 3000)
      }),
  )
  console.log(`JS: ${(bytes / 1024).toFixed(0)} KB, LCP: ${lcp.toFixed(0)} ms`)
  expect(bytes).toBeLessThan(900 * 1024) // nieskompresowane (vite preview nie gzipuje)
  expect(lcp).toBeLessThan(2500)
})

test('prawdziwe AI: tabela agentów, federacja i przełącznik PL/EN', async ({ page }, info) => {
  await page.goto('./#/ai')
  await expect(page.getByRole('heading', { level: 1, name: 'Prawdziwe AI' })).toBeVisible()
  await expect(page.getByTestId('ai-table')).toContainText('UCI HAR')
  await expect(page.getByText('Uczenie federacyjne · har')).toBeVisible()
  await page.getByRole('button', { name: 'en', exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Real AI' })).toBeVisible()
  if (info.project.name === 'mobile') await expect(page.getByTestId('bottom-bar')).toContainText('Teach')
  else await expect(page.getByRole('button', { name: 'Teach the AI' })).toBeVisible()
  await expect(page.getByTestId('fed-table').first()).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Real AI' })).toBeVisible()
})

test('motyw: ciemny domyślnie, przełącznik jasny zapamiętany po odświeżeniu', async ({ page }) => {
  await page.goto('./')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTestId('theme-toggle').filter({ visible: true }).first().click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('heading', { name: 'Przegląd', exact: true })).toBeVisible()
})
