// Stały pomiar czatu: % poprawnych odpowiedzi ze źródłem / „nie wiem” / błędnych (benchmarks/chat_facts/chat_facts_v1.json).
// Każde pytanie w świeżej karcie (bez kontekstu poprzedniego). Zgoda na zapis rozmów wyłączona – nic nie trafia do myc_chats.
import { test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { score, type Item } from './score'

const here = dirname(fileURLToPath(import.meta.url))
// EVAL_SET=chat_personal_v1 – pytania osobiste (poprawne: uczciwe „nie znam Cię”, bez źródła z Wikipedii)
const SET = resolve(here, `../../benchmarks/chat_facts/${process.env.EVAL_SET ?? 'chat_facts_v1'}.json`)

test('chat facts eval', async ({ page, baseURL }) => {
  const raw = readFileSync(SET)
  const set = JSON.parse(raw.toString()) as { name: string; items: Item[] }
  const only = process.env.EVAL_ONLY?.split(',')
  const items = only ? set.items.filter((i) => only.includes(i.id)) : set.items
  const rows = []
  for (const it of items) {
    await page.goto('about:blank')
    await page.goto('./#/chat')
    await page.evaluate(() => (localStorage.setItem('myc.chatlog', '0'), localStorage.setItem('myc.train', '0')))
    const input = page.getByTestId('chat-input')
    await input.fill(it.q)
    await page.getByTestId('chat-send').click()
    const reply = page.getByTestId('reply').last()
    await reply.waitFor({ timeout: 60_000 })
    await page.getByTestId('chat-send').waitFor({ state: 'visible' })
    // odpowiedź, która nie skończy się w 60 s, oceniamy w stanie, w jakim jest (zwykle pusta → „wrong”)
    const done = await page
      .waitForFunction(() => !document.querySelector('[data-testid=chat-send]')?.hasAttribute('disabled'), null, { timeout: 60_000 })
      .then(() => true, () => false)
    await page.waitForTimeout(300)
    const text = (await reply.textContent()) ?? ''
    const turn = page.locator('[data-testid=reply]').last().locator('xpath=..')
    const sources = (await turn.locator('[data-testid=used-facts] li').allTextContents()).map((s) => s.trim())
    const links = await turn.locator('a[href^="http"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
    const stats = `${(await turn.getByTestId('turn-stats').textContent()) ?? ''}${done ? '' : ' · TIMEOUT 60 s'}`
    const r = score(it, text, sources, links)
    rows.push({ id: it.id, q: it.q, verdict: r, text, sources, links, stats })
    console.log(`${it.id} ${r.padEnd(14)} ${text.replace(/\s+/g, ' ').slice(0, 110)}`)
  }
  const n = rows.length
  const count = (v: string) => rows.filter((r) => r.verdict === v).length
  const summary = {
    set: set.name,
    set_sha256: createHash('sha256').update(raw).digest('hex'),
    url: baseURL,
    label: process.env.EVAL_LABEL ?? 'local',
    at: new Date().toISOString(),
    n,
    correct_with_source: count('correct_source'),
    correct_no_source: count('correct_nosrc'),
    dont_know: count('dont_know'),
    wrong: count('wrong'),
    ...(set.items.some((i) => i.honest) ? { honest: count('honest') } : {}),
  }
  console.log(JSON.stringify(summary))
  const out = resolve(here, `../../results/chat_facts/${summary.at.slice(0, 16).replace(/[:T]/g, '')}-${set.name === 'chat_facts_v1' ? '' : `${set.name}-`}${summary.label}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ summary, rows }, null, 1))
})
