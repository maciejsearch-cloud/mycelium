import { chromium, devices } from '@playwright/test'
const url = process.argv[2], out = process.argv[3], mobile = process.argv[4] === 'm', q = process.argv[5]
const b = await chromium.launch()
const ctx = await b.newContext(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 1000 } })
const p = await ctx.newPage()
await p.addInitScript(() => localStorage.setItem('myc.train', '0'))
p.on('console', (m) => m.type() === 'error' && console.log('console:', m.text().slice(0, 200)))
await p.goto(url + '#/czysta')
await p.getByTestId('czysta-ask').waitFor()
await p.waitForFunction(() => !document.querySelector('[data-testid=czysta-ask]')?.hasAttribute('disabled'), null, { timeout: 120000 })
await p.getByTestId('czysta-stats').waitFor({ timeout: 60000 })
await p.waitForTimeout(2500)
if (q) {
  await p.getByTestId('czysta-input').fill(q)
  await p.getByTestId('czysta-ask').click()
  await p.getByTestId('czysta-result').waitFor()
  console.log('ANSWER:', await p.getByTestId('czysta-answer').textContent(), '|', await p.getByTestId('czysta-source').textContent())
  console.log((await p.getByTestId('czysta-trace').locator('li').allTextContents()).join('\n'))
  await p.getByTestId('czysta-result').scrollIntoViewIfNeeded()
}
await p.screenshot({ path: out, fullPage: process.argv[6] === 'full' })
await b.close()
