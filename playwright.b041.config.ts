import { defineConfig } from '@playwright/test';

for (const key of ['REAL_BASE_URL', 'REAL_API_URL', 'REAL_OUTPUT_DIR', 'B041_OFFLINE_BUNDLE', 'B041_RUNTIME_BUNDLE', 'B041_PROFILE']) {
  if (!process.env[key]) throw new Error(`Missing ${key}; use backend/scripts/validate_b041_frontend.py`);
}

export default defineConfig({
  testDir: './e2e', testMatch: 'b041-real.spec.ts', workers: 1, retries: 0,
  timeout: 420_000, expect: { timeout: 25_000 }, reporter: [['list']],
  outputDir: process.env.REAL_OUTPUT_DIR + '/playwright',
  use: {
    baseURL: process.env.REAL_BASE_URL, actionTimeout: 20_000,
    viewport: { width: 1600, height: 1250 }, deviceScaleFactor: 1,
    serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
      args: ['--disable-gpu', '--disable-accelerated-video-decode', '--disable-background-networking',
        '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
