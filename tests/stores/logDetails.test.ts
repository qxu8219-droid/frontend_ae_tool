import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePlaybackStore } from "../../src/stores/playback";
import type { PlaybackSnapshot, UploadResult } from "../../src/domain/types";
import { example } from "../api/fixtures";

beforeEach(() => setActivePinia(createPinia()));

function result(logId: string): UploadResult {
  return { ...example("service/upload_result"), log_id: logId };
}

function active(sessionId: string, logId: string, seq = 1): PlaybackSnapshot {
  return {
    ...example("protocol/PlaybackSnapshot"),
    session_id: sessionId,
    log_id: logId,
    control_seq: seq,
    playback_epoch: seq,
  };
}

it("keeps active A details while B becomes the current upload candidate", () => {
  const store = usePlaybackStore();
  store.recordUpload("s", result("a"), { name: "a.json", size: 10 }, 100);
  store.update(active("s", "a"));
  store.beginUpload("s");
  expect(store.uploaded).toBeNull();
  expect(store.getLogDetails("s", "a")?.fileName).toBe("a.json");
  store.recordUpload("s", result("b"), { name: "b.json", size: 20 }, 200);
  expect(store.uploaded?.log_id).toBe("b");
  expect(store.server?.log_id).toBe("a");
  expect(store.getLogDetails("s", "a")).toMatchObject({
    sessionId: "s", fileName: "a.json", fileSize: 10, importedAt: 100,
    result: { log_id: "a" },
  });
  expect(store.getLogDetails("s", "b")?.fileName).toBe("b.json");
});

it("looks up details by both session and log and returns null for missing identities", () => {
  const store = usePlaybackStore();
  store.recordUpload("s1", result("a"), { name: "first.json", size: 1 });
  store.recordUpload("s2", result("a"), { name: "second.json", size: 2 });
  expect(store.getLogDetails("s1", "a")?.fileName).toBe("first.json");
  expect(store.getLogDetails("s2", "a")?.fileName).toBe("second.json");
  expect(store.getLogDetails("other", "a")).toBeNull();
  expect(store.getLogDetails("s1", "missing")).toBeNull();
  expect(store.getLogDetails("s1", null)).toBeNull();
  expect(store.getLogDetails("s1", undefined)).toBeNull();
});

it("saves a detached snapshot of nested upload metadata and file scalars", () => {
  const store = usePlaybackStore();
  const original = result("a");
  original.mapping_snapshot = { timestamp: { field: "time", unit: "s" } };
  const file = { name: "a.json", size: 10 };
  store.recordUpload("s", original, file, 100);
  original.mapping_snapshot.timestamp = { field: "mutated" };
  original.issues.push({ code: "MUTATED", message: "changed", severity: "error" });
  original.log_id = "changed";
  file.name = "changed.json";
  file.size = 99;
  expect(store.getLogDetails("s", "a")).toMatchObject({
    fileName: "a.json", fileSize: 10,
    result: { log_id: "a", mapping_snapshot: { timestamp: { field: "time", unit: "s" } } },
  });
  expect(store.getLogDetails("s", "a")?.result.issues.some(issue => issue.code === "MUTATED")).toBe(false);
});

it("keeps retained details isolated from edits to the compatibility candidate", () => {
  const store = usePlaybackStore();
  store.recordUpload("s", result("a"), { name: "a.json", size: 10 });
  store.uploaded!.parser = "edited";
  expect(store.getLogDetails("s", "a")?.result.parser).not.toBe("edited");
});

it("evicts old details at eight entries while preserving the active log and candidate", () => {
  const store = usePlaybackStore();
  store.recordUpload("s", result("active"), { name: "active.json", size: 1 });
  store.update(active("s", "active"));
  for (let i = 0; i < 10; i++) {
    store.beginUpload("s");
    store.recordUpload("s", result(`log-${i}`), { name: `${i}.json`, size: i });
  }
  expect(store.getLogDetails("s", "active")?.fileName).toBe("active.json");
  expect(store.getLogDetails("s", "log-9")?.fileName).toBe("9.json");
  expect(store.uploaded?.log_id).toBe("log-9");
  expect(store.getLogDetails("s", "log-0")).toBeNull();
  expect(store.getLogDetails("s", "log-2")).toBeNull();
  const retained = ["active", ...Array.from({ length: 10 }, (_, i) => `log-${i}`)]
    .filter(logId => store.getLogDetails("s", logId));
  expect(retained).toHaveLength(8);
});

it("does not relabel details when ordinary playback switches session or log", () => {
  const store = usePlaybackStore();
  store.recordUpload("s1", result("a"), { name: "a.json", size: 10 });
  store.update(active("s1", "a"));
  store.update(active("s1", "b", 2));
  expect(store.getLogDetails("s1", "b")).toBeNull();
  store.update(active("s2", "a"));
  expect(store.getLogDetails("s2", "a")).toBeNull();
  expect(store.getLogDetails("s1", "a")?.fileName).toBe("a.json");
});

it("clears imported details and candidate on reset", () => {
  const store = usePlaybackStore();
  store.recordUpload("s1", result("a"), { name: "a.json", size: 10 });
  store.update(active("s1", "a"));
  store.reset();
  store.update(active("s2", "a"));
  expect(store.uploaded).toBeNull();
  expect(store.getLogDetails("s1", "a")).toBeNull();
  expect(store.getLogDetails("s2", "a")).toBeNull();
});
