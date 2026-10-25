import { expect, test } from '@playwright/test'

// Ucz AI → „Oczekujące pytania od grzybni”: pytania logiczne z queue.json (dla ludzi + kontrolne), „dlaczego pytam”,
// odpowiedź zapisuje się w myc_answers; liczby zwinięte pod kolejką.
const QUEUE = {
  generated_at: '2026-10-25T00:40:47+0200',
  model: 'lm v1',
  source: 'test',
  human: [
    {
      id: 'l0000000a',
      kind: 'analogia na wyczucie',
      q: '„noc” ma się do „ciemność” tak jak „cisza” do…?',
      why: 'relacja nie jest zapisana w żadnej bazie',
      options: [
        { v: 'a', label: 'spokój' },
        { v: 'b', label: 'hałas' },
        { v: 'zle', label: 'pytanie jest złe' },
      ],
      model: { p: { a: 0.41, b: 0.4, zle: 0.19 }, margin: 0.01 },
    },
  ],
  control: [{ id: 'l0000000b', kind: 'liczebniki', level: 1, q: 'Uzupełnij: 5 … (kot).', options: [{ v: 'a', label: 'koty' }, { v: 'b', label: 'kotów' }], model_acc: 0.14 }],
}

test('Ucz AI: pytania logiczne grzybni z „dlaczego pytam”, kontrolne co 5. odpowiedź, liczby zwinięte', async ({ page }) => {
  const posts: Record<string, unknown>[] = []
  await page.route(/supabase\.co\/rest\/v1\//, async (r) => {
    if (r.request().method() === 'POST' && r.request().url().includes('myc_answers')) posts.push(r.request().postDataJSON() as Record<string, unknown>)
    return r.request().method() === 'POST' ? r.fulfill({ status: 201, body: '' }) : r.fulfill({ json: [] })
  })
  await page.route(/data\/logic\/queue\.json/, (r) => r.fulfill({ json: QUEUE }))
  await page.goto('./#/teach')
  await expect(page.getByRole('heading', { level: 1, name: 'Ucz AI' })).toBeVisible()
  await expect(page.getByText('Oczekujące pytania od grzybni')).toBeVisible()
  await expect(page.getByTestId('teach-numbers')).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('queue-note')).toContainText('Co ok. 5. pytanie')
  // najmniej pewne pierwsze: margines modelu 1 pkt → pytanie logiczne na górze
  const q = page.getByTestId('question')
  await expect(q).toHaveAttribute('data-qid', 'l0000000a', { timeout: 20_000 })
  await expect(page.getByTestId('why')).toContainText('model niepewny: spokój 41.0% vs hałas 40.0%')
  await expect(page.getByTestId('why')).toContainText('głosów dotąd: 0')
  await q.locator('button[data-answer="a"]').click()
  await expect.poll(() => posts.some((p) => p.question_id === 'l0000000a' && p.answer === 'a')).toBe(true)
  // po 4 odpowiedziach tego węzła na górze pytanie kontrolne (odpowiedź zna tylko baza)
  for (let i = 0; i < 3; i++) {
    const id = await q.getAttribute('data-qid')
    const kind = await q.getAttribute('data-kind')
    if (kind === 'word') await q.getByTestId('word-next').click()
    else {
      if (kind === 'intent' || kind === 'user-example') await q.locator('button[data-domain]').first().click()
      await q.locator('button[data-answer]').first().click()
    }
    await expect(q).not.toHaveAttribute('data-qid', id!)
  }
  await expect(q).toHaveAttribute('data-qid', 'l0000000b')
  await expect(page.getByTestId('why')).toContainText('zadanie z generatora (liczebniki, poziom 1)')
  await expect(page.getByTestId('why')).toContainText('model rozwiązuje 14.0% takich')
})
