import { expect, test, type Browser, type Page } from '@playwright/test'

// Mycelium Wallet na prawdziwej bazie (pokój e2e): dwa konta testowe, klucze w przeglądarce, kran, przelew na pseudonim,
// blok i poświadczenia węzłów (WAIT_FINAL=1: czeka, aż blok z przelewem będzie ostateczny – potrzebne działające węzły).
const SB = 'https://agortpieeygmcttjwjfx.supabase.co/rest/v1'
const H = { apikey: 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P', 'Content-Type': 'application/json' }
const KEY = process.env.MYC_E2E_KEY ?? ''
const SHOTS = process.env.SHOTS ?? 'test-results'
const PFX = process.env.SHOT_PREFIX ?? 'wallet'
const PASS = 'test-haslo-portfela-e2e'

test.skip(!KEY, 'potrzebny klucz testowy MYC_E2E_KEY (pokój e2e)')
test.afterAll(async () => {
  if (process.env.KEEP_ACCOUNTS) return
  const r = await fetch(`${SB}/rpc/myc_acct_e2e_cleanup`, { method: 'POST', headers: H, body: JSON.stringify({ p_key: KEY }) }).then((x) => x.json())
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
const shot = async (p: Page, name: string, mobile: boolean, full = false) => {
  if (mobile) await p.screenshot({ path: `${SHOTS}/${PFX}-${name}.png`, fullPage: full })
}

async function account(browser: Browser, handle: string): Promise<Page> {
  const p = await open(browser, './#/konto')
  await p.getByTestId('handle-input').fill(handle)
  await p.getByTestId('create-account').click()
  await expect(p.getByTestId('account-handle')).toHaveText(handle, { timeout: 30_000 })
  await p.goto('./#/portfel')
  return p
}

test('portfel: klucz w przeglądarce, kran, przelew na pseudonim, blok, eksplorator', async ({ browser }, info) => {
  const mobile = info.project.name === 'mobile'
  const tag = `${info.project.name.slice(0, 1)}${Date.now() % 100000}`
  const ha = `e2e_wa${tag}`
  const hb = `e2e_wb${tag}`

  const a = await account(browser, ha)
  await expect(a.getByTestId('myc-test-banner')).toBeVisible()
  await expect(a.getByTestId('wallet-create')).toBeDisabled({ timeout: 30_000 })
  await shot(a, 'create', mobile)
  await a.getByTestId('wallet-pass').fill(PASS)
  await a.getByTestId('wallet-pass2').fill(PASS)
  await a.getByTestId('wallet-ack').check()
  await a.getByTestId('wallet-create').click()
  await expect(a.getByTestId('wallet-pub')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 60_000 })
  const pubA = (await a.getByTestId('wallet-pub').textContent())!.trim()
  // klucz prywatny nie trafia do localStorage ani do żadnej odpowiedzi; w IndexedDB tylko szyfrogram
  const stored = await a.evaluate(
    () =>
      new Promise<string>((res) => {
        const r = indexedDB.open('myc-wallet', 1)
        r.onsuccess = () => {
          const g = r.result.transaction('keys').objectStore('keys').getAll()
          g.onsuccess = () => res(JSON.stringify(g.result))
        }
      }),
  )
  expect(stored).toContain(pubA)
  expect(stored).not.toMatch(/"seed"|"secret"/)
  await a.getByTestId('wallet-faucet').click()
  await expect(a.getByTestId('wallet-balance')).toContainText(/10[,.]00/, { timeout: 30_000 })
  await expect(a.getByTestId('wallet-faucet')).toBeDisabled()
  await shot(a, 'balance', mobile)

  const b = await account(browser, hb)
  await b.getByTestId('wallet-pass').fill(PASS)
  await b.getByTestId('wallet-pass2').fill(PASS)
  await b.getByTestId('wallet-ack').check()
  await b.getByTestId('wallet-create').click()
  await expect(b.getByTestId('wallet-pub')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 60_000 })
  // kopia zapasowa: kod pokazany na żądanie, nie zapisany w przeglądarce
  await b.getByTestId('wallet-show-backup').click()
  const backup = (await b.getByTestId('wallet-backup').textContent())!.trim()
  expect(backup).toMatch(/^MYCW1-/)
  expect(await b.evaluate((c) => Object.values(localStorage).some((v) => v.includes(c)), backup)).toBe(false)

  // przelew A → @B (2,50) z notatką
  await a.getByTestId('wallet-to').fill('@' + hb)
  await a.getByTestId('wallet-amount').fill('2,50')
  await a.getByTestId('wallet-memo').fill('test e2e pierwszy przelew')
  await a.getByTestId('wallet-send').click()
  await expect(a.getByTestId('wallet-ok')).toContainText(/#\d+/, { timeout: 30_000 })
  await expect(a.getByTestId('wallet-balance')).toContainText(/7[,.]50/, { timeout: 30_000 })
  await shot(a, 'sent', mobile, true)
  await b.reload()
  await expect(b.getByTestId('wallet-balance')).toContainText(/2[,.]50/, { timeout: 30_000 })
  await expect(b.getByTestId('wallet-history')).toContainText(ha)

  // zła kwota (więcej niż saldo) zablokowana w formularzu
  await a.getByTestId('wallet-to').fill('@' + hb)
  await a.getByTestId('wallet-amount').fill('100')
  await expect(a.getByTestId('wallet-send')).toBeDisabled()

  // eksplorator: transakcja czeka na blok albo jest już w bloku
  await a.goto('./#/eksplorator')
  await expect(a.getByTestId('explorer-page')).toBeVisible()
  await a.getByTestId('exp-addr').fill('@' + hb)
  await a.getByTestId('exp-lookup').click()
  await expect(a.getByTestId('exp-addr-view')).toContainText(/2[,.]50/, { timeout: 30_000 })
  if (process.env.WAIT_FINAL) {
    await expect
      .poll(
        async () => {
          await a.reload()
          await a.getByTestId('exp-addr').fill('@' + hb)
          await a.getByTestId('exp-lookup').click()
          await a.waitForTimeout(3000)
          return (await a.getByTestId('exp-addr-view').textContent()) ?? ''
        },
        { timeout: 600_000, intervals: [20_000] },
      )
      .toMatch(/ostateczny|final/)
    await shot(a, 'explorer-final', mobile)
    await a.locator('[data-testid^="block-"]').first().locator('button').first().click()
    await a.waitForTimeout(2500)
    await shot(a, 'block', mobile, true)
  } else await shot(a, 'explorer', mobile)
  for (const p of [a, b]) expect(await csp(p)).toEqual([])
})
