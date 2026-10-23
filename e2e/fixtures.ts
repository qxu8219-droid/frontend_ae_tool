import { writeFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";

export interface BrowserEvidence {
  requests: Array<{ method: string; url: string }>;
  responses: Array<{ url: string; status: number }>;
  sockets: string[];
  serviceWorkers: string[];
  samples: unknown[];
  observations: Record<string, unknown>;
}

function localOnly(value: string): boolean {
  const url = new URL(value);
  return (
    ["data:", "blob:", "about:"].includes(url.protocol) ||
    (["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  );
}

export const test = base.extend<{ evidence: BrowserEvidence }>({
  evidence: [
    async ({ context, page }, use, testInfo) => {
      const evidence: BrowserEvidence = {
        requests: [],
        responses: [],
        sockets: [],
        serviceWorkers: [],
        samples: [],
        observations: {},
      };
      const blocked: string[] = [];
      // Preserve native MSW HTTP/WebSocket behavior; routing only blocks non-local requests.
      await context.route("**/*", async (route) => {
        if (localOnly(route.request().url())) await route.continue();
        else {
          blocked.push(route.request().url());
          await route.abort("blockedbyclient");
        }
      });
      context.on("request", (request) =>
        evidence.requests.push({
          method: request.method(),
          url: request.url(),
        }),
      );
      context.on("response", (response) =>
        evidence.responses.push({
          url: response.url(),
          status: response.status(),
        }),
      );
      context.on("serviceworker", (worker) =>
        evidence.serviceWorkers.push(worker.url()),
      );
      page.on("websocket", (socket) => {
        evidence.sockets.push(socket.url());
        if (!localOnly(socket.url())) blocked.push(socket.url());
      });
      await use(evidence);
      const summary = {
        scope:
          "T05–T07 mock frontend browser behavior; not real media or final product acceptance",
        title: testInfo.title,
        project: testInfo.project.name,
        status: testInfo.status,
        sampleCount: evidence.samples.length,
        requestCount: evidence.requests.length,
        blockedNonLocalRequests: blocked,
        ...evidence,
      };
      const path = testInfo.outputPath("observations.json");
      await writeFile(path, JSON.stringify(summary, null, 2));
      await testInfo.attach("Mock workbench observations", {
        path,
        contentType: "application/json",
      });
      if (!page.isClosed()) {
        const screenshot = testInfo.outputPath("final-page.png");
        await page.screenshot({ path: screenshot, fullPage: true });
        await testInfo.attach("Final page", {
          path: screenshot,
          contentType: "image/png",
        });
      }
      expect(blocked, "Browser activity must stay on loopback origins").toEqual(
        [],
      );
      expect(
        evidence.requests.filter((request) => !localOnly(request.url)),
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
