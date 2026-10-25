import { expect, test } from '@playwright/test'

test('Dowody (dawna Weryfikacja): surowe dane, porównanie z CI, stałe testy, skrypt do pobrania', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const now = new Date().toISOString()
  const sha = 'a'.repeat(64)
  await page.route('**/rest/v1/**', (route) => {
    const u = new URL(route.request().url())
    const t = u.pathname.split('/').pop()!
    const rows: Record<string, unknown[]> = {
      myc_models: [{ model: 'fashion', version: 3, acc: 0.9, val_acc: 0.89, path: 'fashion/v3-00000000.bin', created_at: now }],
      myc_ci_evals: [{ model: 'fashion', version: 3, acc_stored: 0.9, acc_recomputed: 0.9, diff_pp: 0, eval_n: 2000, eval_sha: sha, eval_sha_ok: true, weights_sha: sha, n_params: 10, ok: true, run_url: 'https://github.com/o/r/actions/runs/1', created_at: now }],
      myc_eval_sets: [{ model: 'fashion', n: 2000, sha, created_at: now }],
      myc_compute_stats: [],
    }
    if (t === 'myc_compute_stats') return route.fulfill({ json: { hourly: [{ t: now, samples: 1234 }] } })
    return route.fulfill({ json: rows[t] ?? [] })
  })
  await page.goto('./#/verify')
  await expect(page.getByRole('heading', { level: 1, name: 'Dowody' })).toBeVisible()
  await expect(page.getByTestId('verify-latest')).toContainText('90.00% ✓')
  await expect(page.getByTestId('verify-evalsets')).toContainText('n=2000')
  await expect(page.getByTestId('verify-raw')).toContainText('myc_models')
  const dl = page.waitForEvent('download')
  await page.getByTestId('dl-models-csv').click()
  expect((await dl).suggestedFilename()).toBe('models.csv')
  const r = await page.request.get('./verify/verify_model.py')
  expect(await r.text()).toContain('def forward')
})
