import { expect, test, type Browser, type Page } from '@playwright/test'

const SB = 'https://agortpieeygmcttjwjfx.supabase.co/rest/v1'
const H = { apikey: 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P', 'Content-Type': 'application/json' }
const KEY = process.env.MYC_E2E_KEY ?? ''
const SHOTS = process.env.SHOTS ?? 'test-results'
const cleanup = () => fetch(`${SB}/rpc/myc_acct_e2e_cleanup`, { method: 'POST', headers: H, body: JSON.stringify({ p_key: KEY }) }).then((r) => r.json())

test.skip(!KEY, 'potrzebny klucz testowy MYC_E2E_KEY (pokój e2e)')
test.afterAll(async () => {
  const r = await cleanup()
  expect(r.accounts).toBeGreaterThanOrEqual(0)
})

async function open(browser: Browser, url: string): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('myc.accountRoom', 'e2e')
    ;(window as unknown as { __csp: string[] }).__csp = []
    addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  await page.goto(url)
  return page
}
const csp = (p: Page) => p.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

test('anonimowe konto: zakładanie, kod odzyskiwania, polecenie, portfel, odzyskanie', async ({ browser }, info) => {
  const tag = `${info.project.name.slice(0, 3)}${Date.now() % 100000}`
  // 1) bez logowania: formularz
  const a = await open(browser, './#/konto')
  await expect(a.getByTestId('create-account')).toBeVisible({ timeout: 30_000 })
  if (info.project.name === 'mobile') await a.screenshot({ path: `${SHOTS}/account-login.png` })
  await a.getByTestId('handle-input').fill(`e2e_a${tag}`)
  await a.getByTestId('create-account').click()
  await expect(a.getByTestId('account-handle')).toHaveText(`e2e_a${tag}`, { timeout: 30_000 })
  const code = (await a.getByTestId('ref-code').textContent())!.trim()
  expect(code).toMatch(/^[0-9a-f]{8}$/)
  // kod odzyskiwania pokazany raz
  await a.getByTestId('new-recovery').click()
  const rc = (await a.getByTestId('recovery-code').textContent({ timeout: 20_000 }))!.trim()
  expect(rc).toMatch(/^MYC-/)
  expect(await a.evaluate((c) => Object.values(localStorage).some((v) => v.includes(c)), rc)).toBe(false)
  if (info.project.name === 'mobile') {
    await a.screenshot({ path: `${SHOTS}/account-recovery.png` })
    await a.evaluate(() => scrollTo(0, 0))
    await a.screenshot({ path: `${SHOTS}/account-panel.png` })
  }
  // portfel: odrzuca coś, co nie jest adresem; przyjmuje adres publiczny
  await a.getByTestId('wallet-input').fill('abandon abandon abandon abandon abandon abandon')
  await expect(a.getByText(/nie wygląda na publiczny adres|does not look like/)).toBeVisible()
  await a.getByTestId('wallet-input').fill('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')
  await a.getByRole('button', { name: /Zapisz adres|Save address/ }).click()
  await expect(a.getByRole('button', { name: /Zapisz adres|Save address/ })).toBeDisabled({ timeout: 20_000 })

  // 2) znajomy z linku polecającego
  const b = await open(browser, `./?join=1&ref=${code}#/konto`)
  await b.getByTestId('handle-input').fill(`e2e_b${tag}`)
  await b.getByTestId('create-account').click()
  await expect(b.getByText(`e2e_a${tag}`)).toBeVisible({ timeout: 30_000 }) // „Poleca Cię: …”
  // drugie polecenie niemożliwe (pole znika)
  await expect(b.getByTestId('friend-code')).toHaveCount(0)

  await a.reload()
  await expect(a.getByTestId('referral-card')).toContainText(/Polecone: 1|Referred: 1/, { timeout: 30_000 })
  if (info.project.name === 'mobile') await a.getByTestId('referral-card').screenshot({ path: `${SHOTS}/referral.png` })
  else await a.screenshot({ path: `${SHOTS}/account-desktop.png`, fullPage: true })

  // 3) inne urządzenie: logowanie kodem odzyskiwania
  const c = await open(browser, './#/konto')
  await c.getByTestId('recover-input').fill(rc.toLowerCase())
  await c.getByTestId('recover-account').click()
  await expect(c.getByTestId('account-handle')).toHaveText(`e2e_a${tag}`, { timeout: 30_000 })

  for (const p of [a, b, c]) expect(await csp(p)).toEqual([])
})

test('CSP: strony działają bez naruszeń polityki', async ({ browser }) => {
  const p = await open(browser, './#/overview')
  for (const id of ['overview', 'chat', 'teach', 'weryfikuj', 'tasks', 'node', 'session', 'knowledge', 'taxonomy', 'growth', 'ai', 'verify', 'progress', 'konto', 'portfel', 'eksplorator']) {
    await p.goto(`./#/${id}`)
    await p.waitForTimeout(2500)
  }
  expect(await csp(p)).toEqual([])
})
