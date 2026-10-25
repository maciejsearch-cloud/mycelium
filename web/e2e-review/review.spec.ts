import { expect, test } from '@playwright/test'

const SB = 'https://agortpieeygmcttjwjfx.supabase.co/rest/v1'
const H = { apikey: 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P', 'Content-Type': 'application/json' }
const KEY = process.env.MYC_E2E_KEY ?? ''
const NODE = '00000000-0000-4000-8000-0000000e2e02'
const rpc = async (fn: string, body: unknown) => {
  const r = await fetch(`${SB}/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${t}`)
  return t ? JSON.parse(t) : null
}
const frags = async () => (await (await fetch(`${SB}/myc_frags?room=eq.e2e&select=id,subj,obj,status,source&order=id`, { headers: H })).json()) as { id: number; subj: string; obj: string; status: string; source: string }[]

test.skip(!KEY, 'potrzebny klucz testowy MYC_E2E_KEY (pokój e2e)')

test.beforeAll(async () => {
  await rpc('myc_e2e_cleanup', { p_key: KEY })
  const r = await rpc('myc_frag_add', {
    p_node: NODE,
    p_room: 'e2e',
    p_frags: [
      { layer: 0, subj: 'Testowo', rel: 'populacja', obj: '1000', source: 'wikidata', ref: 'Q0' },
      { layer: 0, subj: 'Testowo', rel: 'populacja', obj: '3700', source: 'chat' },
    ],
  })
  expect(r.conflicts).toBe(2)
})
test.afterAll(async () => {
  const r = await rpc('myc_e2e_cleanup', { p_key: KEY })
  expect(r.frags).toBeGreaterThanOrEqual(2)
  expect(await frags()).toEqual([])
})

test('Weryfikuj na telefonie: zatwierdź → cofnij → popraw, dziennik i pomyłki', async ({ page }) => {
  await page.addInitScript((k) => {
    localStorage.setItem('myc.reviewRoom', 'e2e')
    localStorage.setItem('myc.owner', JSON.stringify(k))
  }, KEY)
  await page.goto('./#/weryfikuj')
  await expect(page.getByTestId('review-mode')).toContainText('Właścicielka', { timeout: 30_000 })
  await expect(page.getByTestId('review-mode')).toContainText('e2e')
  const item = page.getByTestId('review-item')
  await expect(item).toHaveAttribute('data-type', 'fragment', { timeout: 30_000 })
  await expect(item).toContainText('sprzeczne strzępki')
  await expect(page.getByTestId('review-evidence')).toContainText('sprzeczny z')
  const ai = (await page.getByTestId('review-ai').textContent())!.trim()

  // zatwierdź → wartość zweryfikowana, druga odrzucona
  await page.getByTestId('btn-approve').click()
  await expect(page.getByTestId('undo-bar')).toBeVisible()
  await expect.poll(async () => (await frags()).map((f) => `${f.obj}:${f.status}`).sort()).toEqual([`${ai}:verified`, `${ai === '1000' ? '3700' : '1000'}:rejected`].sort())

  // cofnij → oba znów w sprzeczności, pozycja wraca do kolejki
  await page.getByTestId('undo').click()
  await expect.poll(async () => (await frags()).map((f) => f.status)).toEqual(['conflict', 'conflict'])
  await expect(item).toHaveAttribute('data-type', 'fragment')

  // popraw → nowy strzępek właścicielki (zweryfikowany), błędne odrzucone
  await page.getByTestId('btn-correct').click()
  await page.getByTestId('correct-input').fill('1234')
  await page.getByTestId('correct-save').click()
  await expect.poll(async () => (await frags()).map((f) => `${f.obj}:${f.status}:${f.source}`)).toEqual(['1000:rejected:wikidata', '3700:rejected:chat', '1234:verified:owner'])

  // statystyki i dziennik (przed → po)
  await page.getByRole('tab', { name: 'Pomyłki' }).click()
  await expect(page.getByTestId('mistake-row').first()).toContainText('Strzępki wiedzy')
  await expect(page.getByTestId('mistakes')).toContainText('1234')
  await page.getByRole('tab', { name: 'Dziennik' }).click()
  const log = page.getByTestId('review-log')
  await expect(log).toContainText('poprawione')
  await expect(log).toContainText('cofnięte')
  await page.screenshot({ path: process.env.SHOT ?? 'test-results/weryfikuj-e2e.png', fullPage: false })
})

test('bez klucza: tylko podgląd, przyciski wyłączone, zapis odrzucony przez bazę', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('myc.reviewRoom', 'e2e'))
  await page.goto('./#/weryfikuj')
  await expect(page.getByTestId('review-mode')).toContainText('Tylko podgląd', { timeout: 30_000 })
  const r = await fetch(`${SB}/rpc/myc_review_submit`, { method: 'POST', headers: H, body: JSON.stringify({ p_key: 'zly-klucz-123', p_node: NODE, p_contrib: null, p_item: { type: 'fragment', ref: '1', verdict: 'approve' } }) })
  expect([401, 403]).toContain(r.status)
  expect(await r.text()).toContain('brak uprawnień')
})
