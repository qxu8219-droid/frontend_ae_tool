import { test, expect } from "./fixtures";
import { diagnostics } from "./oracle";

test("real mode exposes the backend 503 without MSW or synthetic fallback frames", async ({
  page,
  context,
  evidence,
}) => {
  const failure = page.waitForResponse(
    (response) =>
      response.url().includes("/api/v1/") && response.status() === 503,
  );
  await page.goto("/");
  const response = await failure;
  expect(await response.json()).toMatchObject({
    error: {
      code: "BACKEND_NOT_CONFIGURED",
      message: expect.any(String),
      details: expect.any(Object),
    },
  });
  await expect(page.getByTestId("mode-badge")).toContainText("真实");
  await expect(page.getByTestId("error-message")).toContainText(
    /BACKEND_NOT_CONFIGURED|configured backend runtime|503/,
  );
  await page.waitForTimeout(500);
  const state = await diagnostics(page);
  expect(state.session.mode).toBe("real");
  expect(state.session.sid).toBeNull();
  expect(state.snapshot).toBeNull();
  expect(state.sync.presented).toBe(0);
  expect(state.sync.frames).toBe(0);
  expect(state.sync.snapshots).toBe(0);
  expect(context.serviceWorkers()).toHaveLength(0);
  expect(evidence.serviceWorkers).toEqual([]);
  expect(
    evidence.requests.filter((request) =>
      /mockServiceWorker|\/src\/mocks\//.test(request.url),
    ),
  ).toEqual([]);
  const registrations = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map(
      (value) => value.active?.scriptURL,
    ),
  );
  expect(registrations).toEqual([]);
  evidence.observations.realMode = {
    responseStatus: response.status(),
    state,
    serviceWorkerRegistrations: registrations,
  };
});
