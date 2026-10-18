import { defineConfig, devices } from '@playwright/test';

// Two servers on ports nothing else uses (a dev host on 8788 must never be picked up by mistake):
// the mock host (protocol, media, /debug/state) on 8790 and `vite preview` of a fresh build on
// 4190, which proxies /api, /media, /debug and /ws to the mock exactly like `vite dev`.
declare const process: { env: Record<string, string | undefined> };
const CI = !!process.env.CI;
const MOCK_PORT = '8790';
const PREVIEW_PORT = '4190';
// The bundled Chromium decodes H.264/AAC on Windows; if a platform's build does not, run on the
// installed Google Chrome with WOCHIT_E2E_CHANNEL=chrome.
const channel = process.env.WOCHIT_E2E_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(channel ? { channel } : {}),
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
      },
    },
  ],
  webServer: [
    {
      command: `node dev/mock-host.mjs --port ${MOCK_PORT} --pin 123456`,
      url: `http://127.0.0.1:${MOCK_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node dev/e2e-preview.mjs',
      url: `http://127.0.0.1:${PREVIEW_PORT}/`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { WOCHIT_HOST_PORT: MOCK_PORT, WOCHIT_PREVIEW_PORT: PREVIEW_PORT },
    },
  ],
});
