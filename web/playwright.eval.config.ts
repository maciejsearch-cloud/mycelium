import { defineConfig, devices } from '@playwright/test'

// Pomiar czatu na stałym zestawie pytań faktograficznych (benchmarks/chat_facts). Ręcznie:
//   EVAL_URL=https://maciejsearch-cloud.github.io/demo/mycelium/ EVAL_LABEL=live npx playwright test -c playwright.eval.config.ts
export default defineConfig({
  testDir: 'e2e-eval',
  timeout: 30 * 60_000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.EVAL_URL ?? 'http://localhost:4173/', ...devices['Desktop Chrome'] },
})
