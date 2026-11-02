import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createHistoryLoader } from "../../src/app/history";
import { useHistoryStore } from "../../src/stores/history";
import type { CurveResponse, Schema } from "../../src/domain/types";
import { channels, curve, deferred } from "./fixtures";
beforeEach(() => setActivePinia(createPinia()));
it("loads all channel histories once and makes the result available to any selected subset", async () => {
  const loader = createHistoryLoader({
    channels: async () => ({ log_id: "l", channels }),
    curve: async (_s, _l, params) => {
      expect(params.channels).toEqual(["a", "b", "c", "d", "e"]);
      expect(params.to_s).toBe(12);
      return curve();
    },
  });
  await loader.load("s", "l", 12);
  const s = useHistoryStore();
  expect(s.channels).toHaveLength(5);
  expect(s.curve?.series).toHaveLength(2);
  expect(s.loading).toBe(false);
  expect(s.error).toBe("");
});
it("aborts replaced channel requests and ignores their late completion", async () => {
  const old = deferred<Schema["LogChannels"]>();
  let oldSignal: AbortSignal | undefined;
  const loader = createHistoryLoader({
    channels: async (_s, l, options) => {
      if (l === "old") {
        oldSignal = options?.signal;
        return old.promise;
      }
      return { log_id: l, channels };
    },
    curve: async (_s, l) => curve(l),
  });
  const first = loader.load("s", "old", 12);
  await loader.load("s", "new", 12);
  old.resolve({ log_id: "old", channels: [] });
  await first;
  expect(oldSignal?.aborted).toBe(true);
  expect(useHistoryStore().curve?.log_id).toBe("new");
  expect(useHistoryStore().channels).toHaveLength(5);
});
it("cancels an in-flight curve without letting it revive cleared session data", async () => {
  const pending = deferred<CurveResponse>();
  const loader = createHistoryLoader({
    channels: async () => ({ log_id: "l", channels }),
    curve: async () => pending.promise,
  });
  const work = loader.load("s", "l", 12);
  await Promise.resolve();
  loader.cancel();
  useHistoryStore().reset();
  pending.resolve(curve());
  await work;
  expect(useHistoryStore().curve).toBeNull();
  expect(useHistoryStore().loading).toBe(false);
});
it("exposes current failures without overwriting a newer request failure", async () => {
  const old = deferred<Schema["LogChannels"]>();
  const loader = createHistoryLoader({
    channels: async (_s, l) =>
      l === "old" ? old.promise : Promise.reject(new Error("new failure")),
    curve: async () => curve(),
  });
  const first = loader.load("s", "old", 12);
  await loader.load("s", "new", 12);
  old.reject(new Error("obsolete failure"));
  await first;
  expect(useHistoryStore().error).toBe("new failure");
  expect(useHistoryStore().loading).toBe(false);
});
