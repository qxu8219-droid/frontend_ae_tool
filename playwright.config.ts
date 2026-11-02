import { defineConfig } from "@playwright/test";

const includeReal = process.env.E2E_REAL !== "0";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./output/test-results",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1100 },
    deviceScaleFactor: 1,
    serviceWorkers: "allow",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
      args: [
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--use-gl=disabled",
        "--disable-accelerated-video-decode",
        "--disable-accelerated-video-encode",
        "--disable-background-networking",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "mock",
      testMatch: ["replay.spec.ts", "workbench.spec.ts", "light-workbench.spec.ts"],
      use: { baseURL: "http://127.0.0.1:5183" },
    },
    ...(includeReal
      ? [
          {
            name: "real",
            testMatch: "real-mode.spec.ts",
            use: { baseURL: "http://127.0.0.1:5184" },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: "npm run dev -- --port 5183",
      url: "http://127.0.0.1:5183",
      env: { VITE_USE_MOCK: "true" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    ...(includeReal
      ? [
          {
            command:
              "env -u PYTHONPATH -u PYTHONHOME ../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 18010",
            url: "http://127.0.0.1:18010/openapi.json",
            reuseExistingServer: false,
            timeout: 30_000,
          },
          {
            command: "npm run dev -- --port 5184",
            url: "http://127.0.0.1:5184",
            env: {
              VITE_USE_MOCK: "false",
              API_PROXY_TARGET: "http://127.0.0.1:18010",
            },
            reuseExistingServer: false,
            timeout: 30_000,
          },
        ]
      : []),
  ],
});
