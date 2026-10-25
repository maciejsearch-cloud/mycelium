import { expect, test } from '@playwright/test'

// Ucz AI → podział zadań na typy: chipy z liczbami, zadania matematyczne/analityczne/wzrokowe z queue.json
// (bez odpowiedzi – są tylko w myc_gold), trafność według typu, brak przewijania w poziomie na telefonie.
const PX = Buffer.from(new Uint8Array(784).map((_, i) => (i * 7) % 256)).toString('base64')
const QUEUE = {
  generated_at: '2026-10-25T03:00:00+0200',
  source: 'test',
  types: {
    matematyczne: { n: 1, model: { name: 'lm v2', n: 120, correct: 42, acc: 0.35, baseline: 0.27 } },
    analityczne: { n: 1, model: { name: 'lm v2', n: 72, correct: 20, acc: 0.2778, baseline: 0.29 } },
    wzrokowe: { n: 1, model: { name: 'model obrazów', n: 100, correct: 61, acc: 0.61, baseline: 0.1 } },
  },
  items: [
    { id: 'm0000000a', type: 'matematyczne', kind: 'ułamki', level: 2, q: 'Ile to jest 1/2 + 1/3?', options: [{ v: 'a', label: '2/5' }, { v: 'b', label: '5/6' }, { v: 'c', label: '1/6' }, { v: 'd', label: '2/6' }, { v: 'zle', label: 'pytanie jest złe' }], model: { margin: 0.1 }, model_acc: 0.25 },
    { id: 'a0000000a', type: 'analityczne', kind: 'tabela: pierwiastki', level: 1, q: 'Tabela (Wikidata):\npierwiastek | liczba atomowa\nwodór | 1\nhel | 2\nlit | 3\nbor | 5\nKtóry pierwiastek z tabeli ma największą liczbę atomową?', options: [{ v: 'a', label: 'hel' }, { v: 'b', label: 'bor' }, { v: 'c', label: 'lit' }, { v: 'd', label: 'wodór' }], model_acc: 0.4, sources: ['https://www.wikidata.org/wiki/Q556'] },
    { id: 'v0000000a', type: 'wzrokowe', kind: 'Fashion-MNIST', level: 1, q: 'Co jest na obrazku?', px: PX, options: [{ v: 'a', label: 'koszulka' }, { v: 'b', label: 'spodnie' }], model: { pmax: 0.42 } },
  ],
}

test('Ucz AI: typy zadań z liczbami, matematyczne, analityczne (tabela), wzrokowe (obraz), trafność per typ', async ({ page }) => {
  const posts: Record<string, unknown>[] = []
  await page.route(/supabase\.co\/rest\/v1\//, async (r) => {
    if (r.request().method() === 'POST' && r.request().url().includes('myc_answers')) posts.push(r.request().postDataJSON() as Record<string, unknown>)
    return r.request().method() === 'POST' ? r.fulfill({ status: 201, body: '' }) : r.fulfill({ json: [] })
  })
  await page.route(/data\/zadania\/queue\.json/, (r) => r.fulfill({ json: QUEUE }))
  await page.goto('./#/teach')
  const chips = page.getByTestId('task-types')
  await expect(chips).toBeVisible()
  await expect(page.getByTestId('type-count-matematyczne')).toHaveText('1', { timeout: 20_000 })
  await expect(page.getByTestId('type-count-analityczne')).toHaveText('1')
  const q = page.getByTestId('question')

  await chips.locator('[data-type="matematyczne"]').click()
  await expect(q).toHaveAttribute('data-qid', 'm0000000a')
  await expect(page.getByTestId('why')).toContainText('sprawdzane programem (ułamki, poziom 2)')
  await expect(page.getByTestId('why')).toContainText('lm v2 rozwiązuje 25.0% takich')
  await q.locator('button[data-answer="b"]').click()
  await expect.poll(() => posts.some((p) => p.question_id === 'm0000000a' && p.answer === 'b')).toBe(true)
  await expect(page.getByTestId('queue-empty')).toContainText('Brak czekających zadań typu „matematyczne”')

  await chips.locator('[data-type="analityczne"]').click()
  await expect(q).toHaveAttribute('data-qid', 'a0000000a')
  await expect(page.getByTestId('zad-table')).toContainText('bor')
  await expect(page.getByTestId('zad-sources')).toContainText('Q556')

  await chips.locator('[data-type="wzrokowe"]').click()
  await expect(q).toHaveAttribute('data-type', 'wzrokowe', { timeout: 20_000 })

  await expect(page.getByTestId('type-stats')).toContainText('Matematyczne')
  await expect(page.locator('[data-type-stat="matematyczne"]')).toContainText('35.0%')
  await expect(page.locator('[data-type-stat="matematyczne"]')).toContainText('n=120')
  await expect(page.locator('[data-type-stat="matematyczne"]')).toContainText('brak odpowiedzi')
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(over).toBeLessThanOrEqual(0)
})
