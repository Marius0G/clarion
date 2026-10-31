import { defineConfig, devices } from '@playwright/test'

const appPort = Number(process.env.TEST_APP_PORT || 4186)
const wsPort = Number(process.env.TEST_WS_PORT || 18791)
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  use: { baseURL: `http://localhost:${appPort}`, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `VITE_BACKEND_URL=ws://127.0.0.1:${wsPort}/ws?client=console npm run dev -- --host 127.0.0.1 --port ${appPort} --strictPort`,
    url: `http://localhost:${appPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
