import { defineConfig, devices } from '@playwright/test'

// e2e na zbudowanej wersji (vite preview) w trybie nagranym – bez backendu.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:4187/' },
  webServer: { command: 'npx vite preview --port 4187 --strictPort', url: 'http://localhost:4187/', reuseExistingServer: !process.env.CI },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
