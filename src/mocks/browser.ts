import { setupWorker } from "msw/browser";
import { createMockHandlers } from "./handlers";
import { mockRuntime } from "./runtime";

let worker: ReturnType<typeof setupWorker> | undefined;
let starting: Promise<void> | undefined;

/** Starts HTTP and native WebSocket interception before any app requests run. */
export function startMocks(): Promise<void> {
  if (starting) return starting;
  worker = setupWorker(...createMockHandlers(mockRuntime));
  starting = worker
    .start({
      serviceWorker: { url: "/mockServiceWorker.js" },
      onUnhandledRequest: "bypass",
      quiet: true,
    })
    .then(() => {
      mockRuntime.start();
    })
    .catch((error) => {
      worker?.stop();
      worker = undefined;
      starting = undefined;
      throw error;
    });
  return starting;
}

export function stopMocks(): void {
  mockRuntime.dispose();
  worker?.stop();
  worker = undefined;
  starting = undefined;
}

if (import.meta.hot) import.meta.hot.dispose(stopMocks);
