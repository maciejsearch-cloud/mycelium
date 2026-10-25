import { defineConfig, devices } from '@playwright/test'

// Strażnik demo na żywo: testy na opublikowanej stronie GitHub Pages (bez logowania, prawdziwa baza).
// Uruchamiany z crona (.github/workflows/live-watch.yml) albo ręcznie: npm run e2e:live
export default defineConfig({
  testDir: 'e2e-live',
  timeout: 90_000,
  retries: 1,
  use: { baseURL: process.env.LIVE_URL ?? 'https://maciejsearch-cloud.github.io/demo/mycelium/' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
})
