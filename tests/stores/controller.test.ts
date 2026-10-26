import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createWorkbenchController } from "../../src/app/controller";
import { useSessionStore } from "../../src/stores/session";
import { usePlaybackStore } from "../../src/stores/playback";
import { useTelemetryStore } from "../../src/stores/telemetry";
import { ApiError, type ApiClient } from "../../src/api/client";
import type { ControlAck } from "../../src/domain/types";
import type { SessionSocketOptions } from "../../src/api/socket";
import { useHistoryStore } from "../../src/stores/history";
import { useUiStore } from "../../src/stores/ui";
import { example } from "../api/fixtures";
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.unstubAllGlobals());

it('ignores invalid or sessionless timeline intents without freezing future presentation', () => {
  const controller = createWorkbenchController({ getCanvas: () => null, source, socketFactory });
  controller.seek(1); expect(useSessionStore().waitingForControl).toBe(false);
  useSessionStore().sid = 's'; controller.seek(NaN); controller.seek(-1);
  expect(useSessionStore().waitingForControl).toBe(false); controller.dispose();
});

it("rejects duplicate creation while starting or when a session is active", async () => {
  let release!: (value: unknown) => void;
  let created = 0;
  const api = {
    createSession: () => {
      created++;
      return new Promise((r) => {
        release = r;
      });
    },
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  const first = controller.create();
  void controller.create();
  expect(created).toBe(1);
  release({ session_id: "s", status: "starting", ws_url: "/ws" });
  await first;
  void controller.create();
  expect(created).toBe(1);
  controller.dispose();
});

it("uploads mapping and retains the active log until explicit activation", async () => {
  const uploaded = example("service/upload_result");
  const calls: unknown[] = [];
  const api = {
    upload: async (_sid: string, _file: File, options: unknown) => {
      calls.push(options);
      return uploaded;
    },
    load: async () => {
      throw new Error("upload must not activate");
    },
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  useSessionStore().sid = "s";
  usePlaybackStore().update(ack(5).playback);
  await controller.loadFile(new File(["{}"], "data.json"), {
    parser: "json_v1",
    mapping_config: { timestamp: { field: "time", unit: "s" } },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    parser: "json_v1",
    mapping_config: { timestamp: { field: "time", unit: "s" } },
  });
  expect(usePlaybackStore().uploaded?.log_id).toBe(uploaded.log_id);
  expect(usePlaybackStore().server?.target_position?.log_time_s).toBe(5);
  expect(useUiStore().error).toBeNull();
  controller.dispose();
});

it("clears local state immediately and blocks creation until deletion finishes", async () => {
  let deleted!: () => void;
  let creates = 0;
  const api = {
    deleteSession: () =>
      new Promise<void>((r) => {
        deleted = r;
      }),
    createSession: async () => {
      creates++;
      return { session_id: "new", status: "starting", ws_url: "/ws" };
    },
  } as unknown as ApiClient;
  const controller = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  useSessionStore().sid = "old";
  const closing = controller.close();
  expect(useSessionStore().sid).toBeNull();
  await controller.create();
  expect(creates).toBe(0);
  deleted();
  await closing;
  await controller.create();
  expect(useSessionStore().sid).toBe("new");
  controller.dispose();
});
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
  expect(controller.diagnostics.sync().suspended).toBe(true);
  release(ack(3));
  await Promise.all([first, second]);
  expect(order).toEqual([3, 5]);
  expect(usePlaybackStore().server?.target_position?.log_time_s).toBe(5);
  controller.dispose();
});

it('passes real video capabilities, ignores supplemental WS poses, and holds on media faults', () => {
  let callbacks!: SessionSocketOptions;
  const realSource = { ...source, capabilities: { ...source.capabilities, kind: 'whep' as const }, connect: vi.fn(), disconnect: vi.fn() };
  const controller = createWorkbenchController({ getCanvas: () => null, source: realSource,
    socketFactory: options => { callbacks = options; return socketFactory(); } });
  const first = example('service/ws_connection_snapshot'); const sid = first.session_id;
  useSessionStore().sid = sid;
  callbacks.onStatus({ state: 'connecting', generation: 1 });
  callbacks.onMessage(first, 1);
  expect(realSource.connect).toHaveBeenLastCalledWith(sid, expect.any(Function), expect.any(Function), first.data.video);
  callbacks.onMessage(example('service/ws_frame_snapshot'), 1);
  expect(controller.diagnostics.sync().snapshots).toBe(0);
  const fault = { ...example('service/ws_system'), session_id: sid,
    data: { event: 'mediamtx_unreachable', message: 'test failure' } };
  callbacks.onMessage(fault, 1);
  expect(controller.diagnostics.sync().suspended).toBe(true);
  expect(useUiStore().mediaStatus).toContain('共同保持'); controller.dispose();
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

it("a newer explicit seek supersedes an older coalesced timeline target", async () => {
  const sent: number[] = [];
  let release!: (value: ControlAck) => void;
  const api = {
    seek: async (_sid: string, body: { time_s: number }) => {
      sent.push(body.time_s);
      if (sent.length === 1)
        return new Promise<ControlAck>((r) => (release = r));
      return ack(body.time_s, sent.length);
    },
  } as unknown as ApiClient;
  const c = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  useSessionStore().sid = "s";
  usePlaybackStore().update(ack(0, 0).playback);
  useHistoryStore().setContext("s", "l");
  c.seek(1);
  await Promise.resolve();
  await Promise.resolve();
  c.seek(2);
  const explicit = c.control("seek", { time_s: 3 });
  release(ack(1));
  await explicit;
  await new Promise((r) => setTimeout(r, 0));
  expect(sent).toEqual([1, 3]);
  expect(usePlaybackStore().server?.target_position?.log_time_s).toBe(3);
  c.dispose();
});
it("a failed replacement upload cannot leave an old result available for activation", async () => {
  const api = {
    upload: async () => {
      throw new ApiError(422, "BAD_LOG", "invalid log");
    },
  } as unknown as ApiClient;
  const c = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  useSessionStore().sid = "s";
  usePlaybackStore().uploaded = example("service/upload_result");
  usePlaybackStore().update(ack(5).playback);
  await c.loadFile(new File(["bad"], "new.log"));
  expect(usePlaybackStore().uploaded).toBeNull();
  expect(usePlaybackStore().server?.log_id).toBe("l");
  c.dispose();
});
it("a failed deletion retains a cleanup handle so Close can retry instead of stranding the server session", async () => {
  const deleted: string[] = [];
  let creates = 0;
  const api = {
    deleteSession: async (sid: string) => {
      deleted.push(sid);
      if (deleted.length === 1)
        throw new ApiError(0, "NETWORK_ERROR", "offline");
    },
    createSession: async () => {
      creates++;
      return { session_id: "new", status: "starting", ws_url: "/ws" };
    },
  } as unknown as ApiClient;
  const c = createWorkbenchController({
    api,
    source,
    socketFactory,
    getCanvas: () => null,
  });
  useSessionStore().sid = "old";
  await c.close();
  await c.create();
  expect(creates).toBe(0);
  await c.close();
  expect(deleted).toEqual(["old", "old"]);
  await c.create();
  expect(useSessionStore().sid).toBe("new");
  c.dispose();
});
