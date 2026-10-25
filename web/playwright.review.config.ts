import { defineConfig, devices } from '@playwright/test'

// Przepływ „Weryfikuj” na prawdziwej bazie, w izolowanym pokoju 'e2e' (klucz testowy, wiersze sprzątane po teście).
// MYC_E2E_KEY=… LIVE_URL=… npx playwright test -c playwright.review.config.ts
export default defineConfig({
  testDir: 'e2e-review',
  timeout: 120_000,
  retries: 0,
  use: { baseURL: process.env.LIVE_URL ?? 'http://localhost:4187/', ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
  webServer: process.env.LIVE_URL ? undefined : { command: 'npx vite preview --port 4187 --strictPort', url: 'http://localhost:4187/', reuseExistingServer: true },
})
