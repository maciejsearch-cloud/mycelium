import { defineConfig, devices } from '@playwright/test'

// Anonimowe konto na prawdziwej bazie, w izolowanym pokoju 'e2e' (konta i użytkownicy auth sprzątani po teście).
// MYC_E2E_KEY=… [LIVE_URL=…] npx playwright test -c playwright.account.config.ts
export default defineConfig({
  testDir: 'e2e-account',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.LIVE_URL ?? 'http://localhost:4188/' },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } },
  ],
  webServer: process.env.LIVE_URL ? undefined : { command: 'npx vite preview --port 4188 --strictPort', url: 'http://localhost:4188/', reuseExistingServer: true },
})
