import { expect, test, type Browser, type Page } from '@playwright/test'

// Czat globalny + rola Developer + kręgi na prawdziwej bazie, w izolowanym pokoju 'e2e' (sprzątane po teście).
// MYC_E2E_KEY=… SHOTS=… npx playwright test -c playwright.account.config.ts e2e-account/gchat.spec.ts
const SB = 'https://agortpieeygmcttjwjfx.supabase.co/rest/v1'
const H = { apikey: 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P', 'Content-Type': 'application/json' }
const KEY = process.env.MYC_E2E_KEY ?? ''
const SHOTS = process.env.SHOTS ?? 'test-results'
const rpc = (fn: string) => fetch(`${SB}/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify({ p_key: KEY }) }).then((r) => r.json())

test.skip(!KEY, 'potrzebny klucz testowy MYC_E2E_KEY (pokój e2e)')
test.afterAll(async () => {
  await rpc('myc_gchat_e2e_cleanup')
  await rpc('myc_circle_e2e_cleanup')
  await rpc('myc_acct_e2e_cleanup')
})

async function person(browser: Browser, handle: string, ownerKey?: string): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript((k) => {
    localStorage.setItem('myc.accountRoom', 'e2e')
    if (k) localStorage.setItem('myc.owner', JSON.stringify(k))
  }, ownerKey ?? '')
  await page.goto('./#/konto')
  await page.getByTestId('handle-input').fill(handle)
  await page.getByTestId('create-account').click()
  await expect(page.getByTestId('account-handle')).toHaveText(handle, { timeout: 30_000 })
  return page
}

test('czat globalny na żywo, Developer z klucza, kręgi', async ({ browser }, info) => {
  const tag = `${info.project.name.slice(0, 3)}${Date.now() % 100000}`
  const mob = info.project.name === 'mobile'
  // A = urządzenie z kluczem właściciela zapisanym w Weryfikuj → Developer automatycznie
  const a = await person(browser, `kris${tag}`, KEY)
  const b = await person(browser, `gosc${tag}`)
  await a.goto('./#/czat')
  await b.goto('./#/czat')
  await expect(a.getByText('Panel Developera')).toBeVisible({ timeout: 30_000 })
  await expect(b.getByTestId('gchat-stats')).toContainText('na żywo', { timeout: 30_000 })
  await expect(a.getByTestId('gchat-stats')).toContainText('na żywo', { timeout: 30_000 })

  await a.getByTestId('gchat-input').fill('Hej wszystkim! nwm czy to już działa? xD')
  await expect(a.getByTestId('gchat-intent')).toContainText('pytanie')
  await a.getByTestId('gchat-send').click()
  // B widzi wiadomość na żywo (bez odświeżania), z odznaką Developer
  const msgA = b.getByTestId('gchat-msg').filter({ hasText: 'czy to już działa' })
  await expect(msgA).toBeVisible({ timeout: 20_000 })
  await expect(msgA.getByTestId('badge-dev')).toBeVisible()

  await b.getByTestId('gchat-input').fill('kurwa, suuuper 😀')
  await b.getByTestId('gchat-send').click()
  const msgB = a.getByTestId('gchat-msg').filter({ hasText: 'suuuper' })
  await expect(msgB).toBeVisible({ timeout: 20_000 })
  await expect(msgB).toContainText('wulgarne') // tylko etykieta – treść bez zmian
  // Developer przypina – B widzi przypięcie na żywo
  await a.getByTestId('gchat-msg').filter({ hasText: 'czy to już działa' }).getByRole('button', { name: 'akcje' }).click()
  await a.getByRole('button', { name: 'przypnij' }).click()
  await expect(b.getByTestId('gchat-pinned')).toContainText('czy to już działa', { timeout: 20_000 })
  await a.getByTestId('gchat-modlog-btn').click()
  await expect(a.getByTestId('gchat-modlog')).toContainText('pin')
  await a.getByTestId('gchat-stats').evaluate((e) => window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 110 }))
  await a.screenshot({ path: `${SHOTS}/global-chat-${mob ? 'mobile' : 'desktop'}.png`, fullPage: !mob })

  // Kręgi: A zakłada, B dołącza kodem, kanał kręgu
  await a.goto('./#/konto')
  await a.getByTestId('circle-name').fill(`Krag ${tag}`)
  await a.getByTestId('circle-create').click()
  const code = (await a.getByTestId('circle-invite').locator('.font-mono').textContent({ timeout: 30_000 }))!.trim()
  expect(code).toMatch(/^KRG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  await b.goto('./#/konto')
  await b.getByTestId('circle-code').fill(code)
  await b.getByRole('button', { name: 'Dołącz', exact: true }).click()
  await expect(b.getByTestId('circle-member')).toHaveCount(2, { timeout: 30_000 })
  await expect(b.getByTestId('my-trust')).toContainText('%')
  await b.getByTestId('circles').evaluate((e) => window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 120 }))
  await b.screenshot({ path: `${SHOTS}/global-chat-circles-${mob ? 'mobile' : 'desktop'}.png`, fullPage: !mob })

  await b.goto('./#/czat')
  await b.getByRole('tab', { name: new RegExp(`Krag ${tag}`) }).click()
  await b.getByTestId('gchat-input').fill('tylko dla kręgu')
  await b.getByTestId('gchat-send').click()
  await expect(b.getByTestId('gchat-msg').filter({ hasText: 'tylko dla kręgu' })).toBeVisible({ timeout: 20_000 })
  // osoba spoza kręgu (anon) nie widzi wiadomości kręgu przez REST
  const leak = await fetch(`${SB}/myc_gchat?select=id&room=eq.e2e&body=eq.${encodeURIComponent('tylko dla kręgu')}`, { headers: H }).then((r) => r.json())
  expect(leak).toEqual([])
  await a.goto('./#/czat')
  await a.getByRole('tab', { name: new RegExp(`Krag ${tag}`) }).click()
  await expect(a.getByTestId('gchat-msg').filter({ hasText: 'tylko dla kręgu' })).toBeVisible({ timeout: 20_000 })
  if (mob) await a.screenshot({ path: `${SHOTS}/global-chat-circle-channel-mobile.png` })
})
