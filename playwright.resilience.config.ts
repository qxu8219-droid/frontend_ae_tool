import { defineConfig } from '@playwright/test';

for (const key of ['REAL_BASE_URL', 'REAL_API_URL', 'REAL_OUTPUT_DIR', 'B041_OFFLINE_BUNDLE', 'B041_PROFILE']) {
  if (!process.env[key]) throw new Error(`Missing ${key}; launch with backend/scripts/validate_resilience.py`);
}
const mode = process.env.T17_MODE ?? 'matrix';
const seconds = Number(process.env.T17_SOAK_SECONDS ?? 1800);
if (!['matrix', 'soak', 'recording'].includes(mode)) throw new Error('T17_MODE must be matrix, soak or recording');
if (!Number.isFinite(seconds) || seconds < 10) throw new Error('T17_SOAK_SECONDS must be >=10');

export default defineConfig({
  testDir: './e2e', testMatch: mode === 'recording' ? 'resilience-recording.spec.ts' : mode === 'matrix'
    ? ['resilience-real.spec.ts', 'resilience-recording.spec.ts'] : 'resilience-real.spec.ts',
  workers: 1, retries: 0,
  timeout: mode === 'soak' ? (seconds + 360) * 1000 : 900_000,
  expect: { timeout: 25_000 }, reporter: [['list']],
  outputDir: process.env.REAL_OUTPUT_DIR + '/playwright',
  use: {
    baseURL: process.env.REAL_BASE_URL, actionTimeout: 20_000,
    viewport: { width: 1600, height: 1250 }, deviceScaleFactor: 1,
    serviceWorkers: 'block', screenshot: 'only-on-failure', trace: mode === 'soak' ? 'off' : 'retain-on-failure', video: 'off',
    launchOptions: {
      executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
      args: ['--disable-gpu', '--disable-accelerated-video-decode', '--disable-background-networking',
        '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
