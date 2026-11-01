import { expect, test } from '@playwright/test'

// SelfModel: bez migawki uczciwy pusty stan; z migawką – twierdzenia z n, kontrola spójności, kalibracja, decyzje,
// relacje (pusty stan). Migawka testowa ma kształt z scripts/selfmodel_run.py (liczby tylko na potrzeby testu UI).
test('SelfModel: pusty stan bez migawki', async ({ page }) => {
  await page.route('**/rest/v1/**', (r) => r.fulfill({ json: [], headers: { 'content-range': '*/0' } }))
  await page.goto('./#/verify')
  await expect(page.getByTestId('selfmodel-empty')).toBeVisible()
})

test('SelfModel: migawka z twierdzeniami i kontrolą', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'raz wystarczy')
  const at = new Date().toISOString()
  const snapshot = {
    at,
    claims: [
      { id: 'poziom:lm/logika', kind: 'poziom', domain: 'lm/logika', text_pl: 'Moja pewność w domenie „logika” jest niska: trafiam 22,5% (9/40).', text_en: 'low', n: 40, source: 'samouk-probe' },
      { id: 'precyzja:czysta/klasa-3', kind: 'precyzja', domain: 'czysta/klasa-3', text_pl: 'Gdy w zadaniach „klasa 3” odpowiadam, mam rację w 100% (22/22).', text_en: 'x', n: 36, source: 'szkolne_v1' },
    ],
    checks: [{ claim_id: 'pewnosc-surowa:lm/logika', verdict: 'niezgodne', detail_pl: 'surowa pewność 48% vs trafność 22%', detail_en: 'x', n: 40 }],
    decisions: [{ id: 'plan-3', at, choice: { matematyka: 5 }, reason: 'duży błąd', outcome_pl: null, outcome_en: null }],
    calibration: {
      params: { T: 2.8, n_fit: 1000, fit_source: 'lm-eval-2000 (parzyste pytania)' },
      lm_definicje: { ece_raw: 0.122, ece_cal: 0.031, conf_raw: 0.485, conf_cal: 0.335, n_held_out: 1000, correct: 714, n: 2000, reliability_raw: [{ lo: 0.3, n: 10, conf: 0.35, acc: 0.3 }] },
      domains: { 'lm/logika': { ece_raw: 0.387, ece_cal: 0.191, n_held_out: 20, correct: 6, params: { T: 10 } } },
    },
    relations: null,
  }
  await page.route('**/rest/v1/**', (route) => {
    const t = new URL(route.request().url()).pathname.split('/').pop()!
    if (t === 'myc_self_model') return route.fulfill({ json: [{ id: 1, at, snapshot }] })
    return route.fulfill({ json: [], headers: { 'content-range': '*/0' } })
  })
  await page.goto('./#/verify')
  const sm = page.getByTestId('selfmodel')
  await expect(sm.getByTestId('selfmodel-claims')).toContainText('jest niska')
  await expect(sm.getByTestId('selfmodel-checks')).toContainText('niezgodne 1')
  await expect(sm.getByTestId('selfmodel-calibration')).toContainText('0.122 → 0.031')
  await expect(sm.getByTestId('selfmodel-domains')).toContainText('6/20')
  await expect(sm.getByTestId('selfmodel-decisions')).toContainText('skutek jeszcze nie zmierzony')
  await expect(sm.getByTestId('selfmodel-relations')).toContainText('jeszcze nie istnieje')
  // zakładka czystej grzybni: tylko jej domeny, bez modelu językowego
  await page.goto('./#/czysta')
  const cz = page.getByTestId('selfmodel')
  await expect(cz.getByTestId('selfmodel-claims')).toContainText('klasa 3')
  await expect(cz.getByTestId('selfmodel-claims')).not.toContainText('logika')
  await expect(cz.getByTestId('selfmodel-calibration')).toHaveCount(0)
})
