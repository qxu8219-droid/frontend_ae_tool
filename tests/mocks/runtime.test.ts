import { afterEach, describe, expect, it } from "vitest";
import { createMockRuntime, type MockRuntime } from "../../src/mocks/runtime";
import type { FrameSnapshot, WsServerMessage } from "../../src/domain/types";
import {
  parseServerMessage,
  validateFrameSnapshot,
  validateRest,
} from "../../src/api/validation";

const runtimes: MockRuntime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.dispose();
});
function harness() {
  let now = 0;
  const runtime = createMockRuntime({
    now: () => now,
    wallNow: () => 1_800_000_000 + now / 1000,
  });
  runtimes.push(runtime);
  const session = runtime.createSession({
    scene_id: runtime.getScenes().scenes[0].id,
    robot_id: runtime.getRobots().robots[0].id,
  });
  return {
    runtime,
    sid: session.session_id,
    advance(ms: number) {
      now += ms;
      runtime.tick();
    },
  };
}
async function loaded() {
  const h = harness();
  h.advance(400);
  const upload = await h.runtime.uploadLog(
    h.sid,
    new File(["unparsed bytes"], "sample.log"),
  );
  h.runtime.control(h.sid, "load", {
    log_id: upload.log_id,
    request_id: "load-α",
  });
  return { ...h, upload };
}
describe("stateful synthetic replay runtime", () => {
  it("starts idle and publishes every worker phase before ready", () => {
    const h = harness(),
      messages: WsServerMessage[] = [];
    h.runtime.subscribeEvents(h.sid, (m) => messages.push(m));
    expect(messages[0].type).toBe("connection_snapshot");
    expect(h.runtime.getPlayback(h.sid).state).toBe("idle");
    expect(() => h.runtime.control(h.sid, "play", {})).toThrowError(/ready/i);
    for (let n = 0; n < 4; n++) h.advance(100);
    expect(
      messages
        .filter((m) => m.type === "system")
        .map((m) => m.data.worker?.phase),
    ).toEqual(["loading_scene", "loading_robot", "rtsp_publishing", "ready"]);
    expect(h.runtime.getSession(h.sid).status).toBe("ready");
    expect(() =>
      h.runtime.createSession({
        scene_id: h.runtime.getScenes().scenes[0].id,
        robot_id: h.runtime.getRobots().robots[0].id,
      }),
    ).toThrowError(/session/i);
  });
  it("accepts upload as explicitly synthetic without activating it", async () => {
    const h = harness();
    h.advance(400);
    const result = await h.runtime.uploadLog(
      h.sid,
      new File(["not a parsed robot log"], "input.log"),
    );
    expect(result.parser).toBe("mock_fixture_v1");
    expect(result.stats).toMatchObject({
      duration_s: 12,
      sample_count: 721,
      nominal_rate_hz: 60,
    });
    expect(result.channels[0].quality).toMatchObject({
      origin: "derived",
      method: "mock.synthetic.v1",
    });
    expect(result.raw_file_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(h.runtime.getPlayback(h.sid)).toMatchObject({
      state: "idle",
      log_id: null,
    });
  });
  it("correlates accepted controls and preserves seek states with monotonic captures", async () => {
    const h = await loaded(),
      frames: FrameSnapshot[] = [];
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    const ready = h.runtime.control(h.sid, "seek", {
      time_s: 2,
      request_id: "opaque:z",
    });
    expect(ready).toMatchObject({
      ack_stage: "accepted",
      request_id: "opaque:z",
      playback: { state: "ready", target_position: { log_time_s: 2 } },
    });
    expect(ready).not.toHaveProperty("presented");
    h.runtime.control(h.sid, "play", {});
    h.advance(50);
    const first = frames.at(-1)!;
    h.runtime.control(h.sid, "seek", { time_s: 5 });
    h.advance(50);
    expect(frames.at(-1)!.state).toBe("playing");
    expect(frames.at(-1)!.capture_id).toBeGreaterThan(first.capture_id);
    expect(frames.at(-1)!.playback_epoch).toBeGreaterThan(first.playback_epoch);
    h.runtime.control(h.sid, "pause", {});
    h.runtime.control(h.sid, "seek", { time_s: 3 });
    h.advance(100);
    expect(frames.at(-1)!).toMatchObject({
      state: "paused",
      log_time_s: 3,
      render_seq: frames.at(-1)!.capture_id,
    });
    expect(h.runtime.getPlayback(h.sid).rendered_identity).toMatchObject({
      capture_id: frames.at(-1)!.capture_id,
      playback_epoch: frames.at(-1)!.playback_epoch,
    });
    expect(h.runtime.getPlayback(h.sid).control_seq).toBeGreaterThan(
      ready.control_seq,
    );
  });
  it("steps to strict neighboring original samples from between samples", async () => {
    const h = await loaded();
    h.runtime.control(h.sid, "seek", { time_s: 0.025 });
    expect(
      h.runtime.control(h.sid, "step", { direction: "forward" }).playback,
    ).toMatchObject({
      state: "paused",
      target_position: { log_time_s: 2 / 60, source_sample_index: 2 },
    });
    h.runtime.control(h.sid, "seek", { time_s: 0.025 });
    expect(
      h.runtime.control(h.sid, "step", { direction: "backward" }).playback
        .target_position,
    ).toMatchObject({ log_time_s: 1 / 60, source_sample_index: 1 });
    h.runtime.control(h.sid, "step", { direction: "backward" });
    expect(
      h.runtime.control(h.sid, "step", { direction: "backward" }).playback
        .target_position?.log_time_s,
    ).toBe(0);
  });
  it("captures at 20Hz while paused and freezes each 28-joint snapshot", async () => {
    const h = await loaded(),
      frames: FrameSnapshot[] = [];
    h.runtime.control(h.sid, "pause", {});
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    h.advance(1000);
    expect(frames.length).toBe(20);
    const first = frames[0];
    expect(first.joints).toHaveLength(28);
    expect(first.quality).toHaveLength(28);
    expect(first.joints.every(Number.isFinite)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.joints)).toBe(true);
    expect(new Set(frames.map((f) => f.capture_id)).size).toBe(20);
    expect(frames.at(-1)!.log_time_s).toBe(0);
  });
  it("ends, seeks ended to paused, restarts ended with a new epoch and stops at ready zero", async () => {
    const h = await loaded();
    h.runtime.control(h.sid, "play", { speed: 10 });
    h.advance(1200);
    expect(h.runtime.getPlayback(h.sid)).toMatchObject({
      state: "ended",
      target_position: { log_time_s: 12 },
    });
    expect(h.runtime.control(h.sid, "seek", { time_s: 7 }).playback.state).toBe(
      "paused",
    );
    h.runtime.control(h.sid, "seek", { time_s: 12 });
    h.runtime.control(h.sid, "play", {});
    h.advance(50);
    const epoch = h.runtime.getPlayback(h.sid).playback_epoch;
    expect(h.runtime.control(h.sid, "play", {}).playback).toMatchObject({
      state: "playing",
      playback_epoch: epoch + 1,
      target_position: { log_time_s: 0 },
    });
    expect(h.runtime.control(h.sid, "stop", {}).playback).toMatchObject({
      state: "ready",
      target_position: { log_time_s: 0 },
    });
  });
  it("delays immutable frame WS payloads only and assigns envelope seq on delivery", async () => {
    const h = await loaded(),
      events: WsServerMessage[] = [],
      frames: FrameSnapshot[] = [];
    h.runtime.setScenario("data-delay");
    h.runtime.subscribeEvents(h.sid, (m) => events.push(m));
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    h.runtime.control(h.sid, "play", {});
    h.advance(50);
    const old = frames[0];
    h.advance(600);
    expect(events.filter((e) => e.type === "frame_snapshot")).toHaveLength(0);
    h.advance(50);
    const delivered = events.find((e) => e.type === "frame_snapshot");
    expect(delivered?.data).toEqual(old);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.type === "health_telemetry")).toBe(true);
  });
  it("keeps missing values invalid, wheel winding unwrapped and limit bits at normalized edges", async () => {
    const h = await loaded(),
      frames: FrameSnapshot[] = [];
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    h.runtime.control(h.sid, "seek", { time_s: 10 });
    h.advance(50);
    const f = frames.at(-1)!,
      meta = h.runtime.getJointMetadata(h.runtime.getRobots().robots[0].id);
    const wheel = meta.joints.findIndex((j) => j.type === "continuous");
    expect(Math.abs(f.source_joints[wheel])).toBeGreaterThan(2 * Math.PI);
    expect(Math.abs(f.joints[wheel])).toBeLessThanOrEqual(Math.PI);
    h.runtime.setScenario("missing-channels");
    h.advance(50);
    expect(
      frames.at(-1)!.quality.some((q) => q.origin === "missing" && !q.valid),
    ).toBe(true);
    h.runtime.control(h.sid, "seek", { time_s: 3 });
    h.advance(50);
    expect(frames.at(-1)!.limit_flags).toBeGreaterThan(0);
  });
  it("requires recreation after a worker error and clears old callbacks on delete", async () => {
    const h = await loaded(),
      events: WsServerMessage[] = [],
      frames: FrameSnapshot[] = [],
      closed: number[] = [];
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    h.runtime.subscribeConnection(h.sid, {
      message: (m) => events.push(m),
      close: (code) => closed.push(code),
    });
    h.runtime.setScenario("worker-error");
    expect(h.runtime.getPlayback(h.sid).state).toBe("error");
    h.runtime.setScenario("normal");
    expect(() => h.runtime.control(h.sid, "play", {})).toThrowError(
      /recreate/i,
    );
    h.runtime.deleteSession(h.sid);
    h.advance(1000);
    expect(frames).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(() => h.runtime.getPlayback(h.sid)).toThrowError(/not found/i);
    const session = h.runtime.createSession({
      scene_id: h.runtime.getScenes().scenes[0].id,
      robot_id: h.runtime.getRobots().robots[0].id,
    });
    expect(session.session_id).not.toBe(h.sid);
    expect(h.runtime.getPlayback(session.session_id).state).toBe("idle");
  });
  it("deletes idempotently without destroying a newly created session", () => {
    const h = harness();
    h.runtime.deleteSession(h.sid);
    expect(() => h.runtime.deleteSession(h.sid)).not.toThrow();
    const next = h.runtime.createSession({
      scene_id: h.runtime.getScenes().scenes[0].id,
      robot_id: h.runtime.getRobots().robots[0].id,
    });
    h.runtime.deleteSession(h.sid);
    expect(h.runtime.getSession(next.session_id).session_id).toBe(
      next.session_id,
    );
  });
  it("reports synthetic parse failure issues and never creates an active log", async () => {
    const h = harness();
    h.advance(400);
    h.runtime.setScenario("parse-error");
    await expect(
      h.runtime.uploadLog(h.sid, new File(["bad"], "bad.log")),
    ).rejects.toMatchObject({
      status: 422,
      body: {
        error: {
          details: {
            issues: [{ severity: "error", code: "MOCK_PARSE_ERROR" }],
          },
        },
      },
    });
    expect(h.runtime.getPlayback(h.sid).log_id).toBeNull();
  });
  it("uses independent connection identities, validates client input and only rate limits health", async () => {
    const h = await loaded(),
      a: WsServerMessage[] = [],
      b: WsServerMessage[] = [],
      closes: number[] = [];
    const conn = h.runtime.subscribeConnection(h.sid, {
      message: (m) => a.push(m),
      close: (code) => closes.push(code),
    });
    h.runtime.subscribeEvents(h.sid, (m) => b.push(m));
    expect(a[0].connection_id).not.toBe(b[0].connection_id);
    conn.receive({
      schema_version: 1,
      type: "set_telemetry_rate",
      connection_id: a[0].connection_id,
      session_id: h.sid,
      seq: 1,
      wall_time: 1,
      data: { hz: 10, request_id: "hz" },
    });
    conn.receive({
      schema_version: 1,
      type: "ping",
      connection_id: a[0].connection_id,
      session_id: h.sid,
      seq: 2,
      wall_time: 1,
      data: { request_id: "ping" },
    });
    expect(a.find((m) => m.type === "pong")?.data).toEqual({
      request_id: "ping",
    });
    h.advance(1000);
    expect(a.filter((m) => m.type === "frame_snapshot")).toHaveLength(20);
    h.runtime.setScenario("ws-reconnect");
    expect(closes).toHaveLength(1);
    const c: WsServerMessage[] = [];
    h.runtime.subscribeEvents(h.sid, (m) => c.push(m));
    expect(c[0]).toMatchObject({ type: "connection_snapshot", seq: 1 });
    expect(c[0].connection_id).not.toBe(a[0].connection_id);
  });
  it("delivers 30Hz health on a 10ms timer grid without reducing 20Hz frame captures", async () => {
    const h = await loaded(),
      events: WsServerMessage[] = [],
      closes: number[] = [];
    const connection = h.runtime.subscribeConnection(h.sid, {
      message: (m) => events.push(m),
      close: (code) => closes.push(code),
    });
    connection.receive({
      type: "set_telemetry_rate",
      connection_id: events[0].connection_id,
      session_id: h.sid,
      seq: 0,
      wall_time: 1,
      data: { hz: 30, request_id: "rate-zero-seq" },
    });
    expect(closes).toHaveLength(0);
    for (let i = 0; i < 100; i++) h.advance(10);
    expect(events.filter((e) => e.type === "health_telemetry")).toHaveLength(
      30,
    );
    expect(events.filter((e) => e.type === "frame_snapshot")).toHaveLength(20);
  });
  it("validates parser identifiers and individual channel identifiers before state lookup", async () => {
    const h = harness();
    await expect(
      h.runtime.uploadLog(h.sid, new File(["x"], "x"), { parser: "../parser" }),
    ).rejects.toMatchObject({ status: 400 });
    h.advance(400);
    const upload = await h.runtime.uploadLog(h.sid, new File(["x"], "x"));
    expect(() =>
      h.runtime.getCurve(h.sid, upload.log_id, { channels: "x".repeat(257) }),
    ).toThrowError(/256/);
    expect(
      h.runtime.getCurve(h.sid, upload.log_id, {
        channels: upload.channels[0].name,
        from_s: 15,
      }).series[0].points,
    ).toHaveLength(0);
    expect(() =>
      h.runtime.getCurve("unknown", "unknown", { channels: "" }),
    ).toThrowError(/channels/);
  });
  it("queries requested channels and retains extrema within bounded deterministic history", async () => {
    const h = await loaded(),
      name = h.upload.channels[0].name;
    const full = h.runtime.getCurve(h.sid, h.upload.log_id, {
      channels: name,
      max_points: "1000",
    });
    const small = h.runtime.getCurve(h.sid, h.upload.log_id, {
      channels: ` ${name},${name} `,
      max_points: "8",
    });
    expect(small.series).toHaveLength(1);
    expect(small.series[0].points.length).toBeLessThanOrEqual(8);
    const values = full.series[0].points.map((p) => p.value!);
    const selected = small.series[0].points.map((p) => p.value!);
    expect(Math.max(...selected)).toBe(Math.max(...values));
    expect(Math.min(...selected)).toBe(Math.min(...values));
    expect(() =>
      h.runtime.getCurve(h.sid, h.upload.log_id, {
        channels: `${name},`,
        max_points: "8",
      }),
    ).toThrowError();
    expect(() =>
      h.runtime.getCurve(h.sid, h.upload.log_id, { channels: "unknown" }),
    ).toThrowError();
  });
  it("emits payloads that pass the generated REST and WS schemas and semantic checks", async () => {
    const h = await loaded(),
      events: WsServerMessage[] = [],
      frames: FrameSnapshot[] = [];
    h.runtime.subscribeEvents(h.sid, (m) => events.push(m));
    h.runtime.subscribeFrames(h.sid, (f) => frames.push(f));
    validateRest("SceneList", h.runtime.getScenes());
    validateRest("RobotList", h.runtime.getRobots());
    validateRest(
      "JointMetadata",
      h.runtime.getJointMetadata(h.runtime.getRobots().robots[0].id),
    );
    validateRest("SessionStatus", h.runtime.getSession(h.sid));
    validateRest("UploadResult", h.upload);
    validateRest(
      "LogChannels",
      h.runtime.getLogChannels(h.sid, h.upload.log_id),
    );
    validateRest(
      "CurveResponse",
      h.runtime.getCurve(h.sid, h.upload.log_id, {
        channels: h.upload.channels[0].name,
      }),
    );
    validateRest("RESTPlaybackResponse", h.runtime.control(h.sid, "play", {}));
    h.advance(1000);
    validateRest("PlaybackSnapshot", h.runtime.getPlayback(h.sid));
    validateRest("VideoInfo", h.runtime.getVideo(h.sid));
    h.runtime.setScenario("worker-error");
    for (const message of events)
      expect(() => parseServerMessage(message, h.sid)).not.toThrow();
    for (const frame of frames)
      expect(() => validateFrameSnapshot(frame)).not.toThrow();
  });
  it.each([
    ["seek", { time_s: null }],
    ["seek", { time_s: 1, frame_index: 2 }],
    ["seek", { time_s: true }],
    ["seek", { time_s: Infinity }],
    ["step", { direction: "sideways" }],
    ["speed", { speed: 0.09 }],
    ["speed", { speed: 10.01 }],
    ["play", { request_id: 7 }],
    ["wat", {}],
    ["pause", { unknown: true }],
  ])(
    "rejects malformed %s without changing controls",
    async (command, body) => {
      const h = await loaded(),
        before = h.runtime.getPlayback(h.sid);
      expect(() => h.runtime.control(h.sid, command, body)).toThrowError();
      expect(h.runtime.getPlayback(h.sid).control_seq).toBe(before.control_seq);
    },
  );
});
