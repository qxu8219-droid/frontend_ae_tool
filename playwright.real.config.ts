import { defineConfig } from '@playwright/test';

if (!process.env.REAL_BASE_URL || !process.env.REAL_OUTPUT_DIR) throw new Error('Use backend/scripts/validate_frontend.py to own the real runtime');
export default defineConfig({
  testDir: './e2e', testMatch: 'real-replay.spec.ts', workers: 1, retries: 0,
  timeout: 300000, expect: { timeout: 20000 }, reporter: [['list']],
  outputDir: process.env.REAL_OUTPUT_DIR + '/playwright',
  use: { baseURL: process.env.REAL_BASE_URL, actionTimeout: 15000, viewport: { width: 1600, height: 1250 }, deviceScaleFactor: 1,
    serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--disable-gpu', '--disable-accelerated-video-decode',
      '--disable-background-networking', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'] },
  },
});
