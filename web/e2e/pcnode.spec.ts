import { expect, test } from '@playwright/test'

test('węzeł na PC: pobieranie z sumami SHA-256, uczciwa uwaga SmartScreen, postęp modelu językowego z bazy', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const t0 = new Date(Date.now() - 3600_000).toISOString()
  const t1 = new Date().toISOString()
  const sha = 'b'.repeat(64)
  await page.route('**/node/binaries.json', (r) =>
    r.fulfill({ json: { built: t1, run_url: 'https://github.com/o/r/actions/runs/2', files: [{ os: 'windows', name: 'MyceliumNode.exe', url: 'https://github.com/o/r/releases/download/t/MyceliumNode.exe', sha256: sha, bytes: 250e6 }, { os: 'linux', name: 'MyceliumNode-linux-x64', url: 'https://github.com/o/r/releases/download/t/MyceliumNode-linux-x64', sha256: sha, bytes: 240e6 }] } }),
  )
  await page.route('**/rest/v1/**', (route) => {
    const u = new URL(route.request().url())
    const t = u.pathname.split('/').pop()!
    if (t === 'myc_models' && u.search.includes('model=eq.lm'))
      return route.fulfill({
        json: [
          { model: 'lm', version: 0, acc: 0.332, meta: { ppl: 40.73 }, n_updates: 0, samples: 0, created_at: t0, verifiers: [{ trusted: true }] },
          { model: 'lm', version: 1, acc: 0.3415, meta: { ppl: 33.12, correct: 683, eval_n: 2000, eval_version: 2, rebased: [{ at: t1, prev_acc: 0.336, prev_ppl: 32.77, prev_eval_n: 250 }] }, n_updates: 12, samples: 196608, created_at: t1, verifiers: [{ trusted: true }] },
        ],
      })
    if (t === 'myc_eval_sets') return route.fulfill({ json: [{ n: 2000, sha: 'c'.repeat(64), version: 2 }] })
    if (t === 'myc_results' && u.search.includes('model=eq.lm')) return route.fulfill({ json: [{ model: 'lm', node_id: 'n1', samples: 16384, created_at: t1 }] })
    return route.fulfill({ json: [] })
  })
  await page.goto('./#/node')
  await expect(page.getByTestId('pc-win')).toHaveAttribute('href', /MyceliumNode\.exe$/)
  await expect(page.getByTestId('pc-files')).toContainText(sha)
  await expect(page.getByTestId('smartscreen')).toContainText('nieznany wydawca')
  const lmp = page.getByTestId('lm-progress')
  await expect(lmp).toContainText('v1')
  await expect(lmp).toContainText('33.12')
  await expect(lmp).toContainText('683/2000')
  // zmiana zbioru testowego widoczna: wersja 2, 2000 pytań, poprzedni wynik v1 na 250 pytaniach
  await expect(lmp.getByTestId('lm-evalset')).toContainText('wersja 2 · 2000 pytań')
  await expect(lmp.getByTestId('lm-evalset')).toContainText('33.6% / 32.77 na 250 pyt.')
  await expect(lmp.getByTestId('timechart').first()).toHaveAttribute('data-points', '3')
})
