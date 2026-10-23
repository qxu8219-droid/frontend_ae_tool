import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createWorkbenchController } from "../../src/app/controller";
import { useSessionStore } from "../../src/stores/session";
import { usePlaybackStore } from "../../src/stores/playback";
import { useTelemetryStore } from "../../src/stores/telemetry";
import type { ApiClient } from "../../src/api/client";
import type { ControlAck } from "../../src/domain/types";
import type { SessionSocketOptions } from "../../src/api/socket";
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.unstubAllGlobals());
const socketFactory = () => ({
  connect() {},
  disconnect() {},
  setTelemetryRate() {},
  ping() {},
});
const source = {
  capabilities: {
    kind: "unavailable" as const,
    identity: "capture32_crc32" as const,
    controllable: false,
  },
  connect() {},
  disconnect() {},
};
function ack(time: number, seq = 1): ControlAck {
  return {
    request_id: "r",
    control_seq: seq,
    playback_epoch: seq,
    ack_stage: "accepted",
    playback: {
      schema_version: 1,
      session_id: "s",
      log_id: "l",
      playback_epoch: seq,
      control_seq: seq,
      state: "paused",
      speed: 1,
      duration_s: 12,
      target_position: {
        log_time_s: time,
        source_sample_index: 0,
        target_seq: seq,
      },
    },
  };
}
it("cleans a created session whose response arrives after local cancellation", async () => {
  let resolve!: (value: {
    session_id: string;
    status: "starting";
    ws_url: string;
  }) => void;
  const resources = new Set<string>();
  const api = {
    createSession: () => new Promise((r) => (resolve = r)),
    deleteSession: async (sid: string) => {
      resources.delete(sid);
    },
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    getCanvas: () => null,
    socketFactory,
    source,
  });
  const pending = controller.create();
  await Promise.resolve();
  await controller.close();
  resources.add("late");
  resolve({
    session_id: "late",
    status: "starting",
    ws_url: "/ws/sessions/late",
  });
  await pending;
  expect(resources.size).toBe(0);
  expect(useSessionStore().sid).toBeNull();
  controller.dispose();
});
it("keeps accepted server progress separate from a canvas presentation", async () => {
  const api = { seek: async () => ack(9) } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    getCanvas: () => null,
    socketFactory,
    source,
  });
  useSessionStore().sid = "s";
  await controller.control("seek", { time_s: 9 });
  expect(usePlaybackStore().server?.target_position?.log_time_s).toBe(9);
  expect(useTelemetryStore().presented).toBeNull();
  controller.dispose();
});
it("serializes controls so an older request cannot arrive after the latest intent", async () => {
  let release!: (value: ControlAck) => void;
  const order: number[] = [];
  const api = {
    seek: async (_sid: string, body: { time_s: number }) => {
      order.push(body.time_s);
      if (body.time_s === 3)
        return new Promise<ControlAck>((r) => (release = r));
      return ack(5, 2);
    },
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    getCanvas: () => null,
    socketFactory,
    source,
  });
  useSessionStore().sid = "s";
  const first = controller.control("seek", { time_s: 3 }),
    second = controller.control("seek", { time_s: 5 });
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual([3]);
  release(ack(3));
  await Promise.all([first, second]);
  expect(order).toEqual([3, 5]);
  expect(usePlaybackStore().server?.target_position?.log_time_s).toBe(5);
  controller.dispose();
});

it("uses the socket generation as the single authority across close and recreate", async () => {
  let next = 0,
    transportGeneration = 0;
  const api = {
    createSession: async () => ({
      session_id: `s${++next}`,
      status: "starting",
      ws_url: "/ws",
    }),
    deleteSession: async () => {},
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    getCanvas: () => null,
    source,
    socketFactory: (options) => ({
      connect() {
        options.onStatus({
          state: "connecting",
          generation: ++transportGeneration,
        });
      },
      disconnect() {
        options.onStatus({
          state: "closed",
          generation: ++transportGeneration,
        });
      },
      setTelemetryRate() {},
      ping() {},
    }),
  });
  await controller.create();
  expect(controller.diagnostics.sync().sessionId).toBe("s1");
  await controller.close();
  await controller.create();
  expect(controller.diagnostics.sync().sessionId).toBe("s2");
  expect(controller.diagnostics.sync().generation).toBe(
    useSessionStore().socket.generation,
  );
  controller.dispose();
});

it("a stale acknowledgement cannot replace the accepted log pairing barrier", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let resolve!: (value: ControlAck) => void, callbacks!: SessionSocketOptions;
  const api = {
    load: () => new Promise<ControlAck>((r) => (resolve = r)),
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    getCanvas: () => null,
    source,
    socketFactory: (options) => {
      callbacks = options;
      return socketFactory();
    },
  });
  useSessionStore().sid = "s";
  const pending = controller.control("load", { log_id: "old" });
  await Promise.resolve();
  await Promise.resolve();
  callbacks.onStatus({ state: "open", generation: 2 });
  const newest = { ...ack(5, 2).playback, log_id: "new" };
  callbacks.onMessage(
    {
      schema_version: 1,
      session_id: "s",
      connection_id: "c",
      seq: 1,
      wall_time: 1,
      type: "playback_state",
      data: { playback: newest, reason: "load" },
    },
    2,
  );
  const stale = { ...ack(1), playback: { ...ack(1).playback, log_id: "old" } };
  resolve(stale);
  await pending;
  expect(usePlaybackStore().server?.log_id).toBe("new");
  callbacks.onMessage(
    {
      schema_version: 1,
      session_id: "s",
      connection_id: "c",
      seq: 2,
      wall_time: 2,
      type: "frame_snapshot",
      data: {
        schema_version: 1,
        session_id: "s",
        log_id: "new",
        capture_id: 99,
        render_seq: 99,
        playback_epoch: 2,
        control_seq: 2,
        target_seq: 99,
        state: "paused",
        speed: 1,
        log_time_s: 5,
        duration_s: 12,
        progress: 5 / 12,
        joints: Array(28).fill(0),
        source_joints: Array(28).fill(0),
        quality: Array(28).fill({
          origin: "derived",
          valid: true,
          method: "synthetic",
        }),
        chassis: null,
        limit_flags: 0,
        limit_warn_flags: 0,
        captured_wall_s: 1,
      },
    } as Parameters<SessionSocketOptions["onMessage"]>[0],
    2,
  );
  expect(controller.diagnostics.sync().snapshots).toBe(1);
  controller.dispose();
  vi.unstubAllGlobals();
});
