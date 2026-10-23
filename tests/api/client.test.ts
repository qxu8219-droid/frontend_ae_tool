import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "../../src/api/client";
import { example } from "./fixtures";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("API boundary", () => {
  it("routes every catalog, session, playback, and video operation through its typed contract", async () => {
    const snapshot = example("service/ws_connection_snapshot");
    const sid = "example-session";
    const bodies: Record<string, unknown> = {
      "GET /scenes": { scenes: [] },
      "GET /robots": { robots: [] },
      "GET /robots/r1/joints": { ...snapshot.data.joint_meta, robot_id: "r1" },
      "POST /sessions": {
        session_id: sid,
        status: "starting",
        ws_url: "/ws/sessions/example-session",
      },
      "GET /sessions/example-session": {
        session_id: sid,
        scene_id: "scene",
        robot_id: "r1",
        isaacsim_version: "6.2.0",
        mode: "kinematic",
        physics_engine: "physx",
        status: "ready",
        ws_url: "/ws/sessions/example-session",
        worker: snapshot.data.worker,
        video: snapshot.data.video,
        render_fps: 30,
      },
      "GET /sessions/example-session/logs/l/channels": {
        log_id: "l",
        channels: [],
      },
      "GET /sessions/example-session/playback": snapshot.data.playback,
      "GET /sessions/example-session/video": snapshot.data.video,
    };
    const seen: string[] = [];
    const api = createApiClient("/api/v1", async (url, init) => {
      const route = `${init?.method ?? "GET"} ${String(url).replace("/api/v1", "")}`;
      seen.push(route);
      if (route.startsWith("POST /sessions/example-session/playback/")) {
        const ack = example("service/playback_ack");
        ack.request_id = JSON.parse(String(init?.body)).request_id;
        return json(ack);
      }
      if (!(route in bodies)) throw new Error(`Unexpected route: ${route}`);
      return json(bodies[route]);
    });
    await api.scenes();
    await api.robots();
    await api.joints("r1");
    await api.createSession({
      scene_id: "scene",
      robot_id: "r1",
      isaacsim_version: "6.2.0",
      mode: "kinematic",
      physics_engine: "physx",
    });
    await api.session(sid);
    await api.channels(sid, "l");
    await api.playback(sid);
    await api.video(sid);
    await api.load(sid, { log_id: "l" });
    await api.play(sid);
    await api.pause(sid);
    await api.stop(sid);
    await api.seek(sid, { frame_index: -1 });
    await api.step(sid, { direction: "backward" });
    await api.speed(sid, { speed: 2 });
    expect(seen).toEqual([
      "GET /scenes",
      "GET /robots",
      "GET /robots/r1/joints",
      "POST /sessions",
      "GET /sessions/example-session",
      "GET /sessions/example-session/logs/l/channels",
      "GET /sessions/example-session/playback",
      "GET /sessions/example-session/video",
      "POST /sessions/example-session/playback/load",
      "POST /sessions/example-session/playback/play",
      "POST /sessions/example-session/playback/pause",
      "POST /sessions/example-session/playback/stop",
      "POST /sessions/example-session/playback/seek",
      "POST /sessions/example-session/playback/step",
      "POST /sessions/example-session/playback/speed",
    ]);
  });

  it("encodes path IDs, passes cancellation, and accepts an empty 204", async () => {
    const signal = new AbortController().signal;
    const api = createApiClient("/api/v1/", async (url, init) => {
      expect(url).toBe("/api/v1/sessions/a%2Fb%20%3F");
      expect(init?.signal).toBe(signal);
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    await expect(
      api.deleteSession("a/b ?", { signal }),
    ).resolves.toBeUndefined();
  });

  it("generates correlation IDs while returning only an accepted control acknowledgement", async () => {
    const api = createApiClient("/api/v1", async (url, init) => {
      expect(url).toBe("/api/v1/sessions/example-session/playback/seek");
      const body = JSON.parse(String(init?.body));
      expect(body.time_s).toBe(-1);
      expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      const ack = example("service/playback_ack");
      ack.request_id = body.request_id;
      return json(ack);
    });
    const ack = await api.seek("example-session", { time_s: -1 });
    expect(ack.ack_stage).toBe("accepted");
    expect(ack).not.toHaveProperty("presented_frame");
  });

  it("preserves caller correlation IDs and rejects mismatched response identities", async () => {
    const api = createApiClient("/api/v1", async (_, init) => {
      expect(JSON.parse(String(init?.body)).request_id).toBe("caller-id");
      const ack = example("service/playback_ack");
      ack.request_id = "caller-id";
      ack.playback.session_id = "wrong";
      return json(ack);
    });
    await expect(
      api.play("example-session", { request_id: "caller-id" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([{ speed: Infinity }, { speed: 0 }, { speed: true }, { speed: 11 }])(
    "rejects invalid speed before sending: %j",
    async (body) => {
      const api = createApiClient("/api/v1", async () => {
        throw new Error("must not fetch");
      });
      await expect(api.speed("s", body as any)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    },
  );

  it.each([
    { time_s: 1, frame_index: 2 },
    { time_s: null },
    {},
    { time_s: NaN },
  ])("rejects invalid seek before sending: %j", async (body) => {
    const api = createApiClient("/api/v1", async () => {
      throw new Error("must not fetch");
    });
    await expect(api.seek("s", body as any)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("normalizes actual backend errors without mock fallback", async () => {
    const api = createApiClient("/api/v1", async () =>
      json(
        {
          error: {
            code: "BACKEND_NOT_CONFIGURED",
            message: "Not ready",
            details: { endpoint: "scenes" },
          },
        },
        503,
      ),
    );
    await expect(api.scenes()).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_NOT_CONFIGURED",
      message: "Not ready",
      details: { endpoint: "scenes" },
    });
  });

  it("normalizes network and malformed responses but preserves AbortError", async () => {
    const offline = createApiClient("/api/v1", async () => {
      throw new TypeError("Offline");
    });
    await expect(offline.scenes()).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
    const malformed = createApiClient(
      "/api/v1",
      async () => new Response("<html>", { status: 502 }),
    );
    await expect(malformed.scenes()).rejects.toMatchObject({
      status: 502,
      code: "INVALID_RESPONSE",
    });
    const aborted = new DOMException("Aborted", "AbortError");
    const cancelled = createApiClient("/api/v1", async () => {
      throw aborted;
    });
    await expect(cancelled.scenes()).rejects.toBe(aborted);
  });

  it("rejects a late response if fetch ignores an already aborted signal", async () => {
    const controller = new AbortController();
    let finish!: (value: Response) => void;
    const api = createApiClient(
      "/api/v1",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const promise = api.scenes({ signal: controller.signal });
    controller.abort();
    finish(json({ scenes: [] }));
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects unexpected response fields and nonfinite values in error details", async () => {
    const api = createApiClient("/api/v1", async () =>
      json({ scenes: [], stale: true }),
    );
    await expect(api.scenes()).rejects.toBeInstanceOf(ApiError);
    const errors = createApiClient(
      "/api/v1",
      async () =>
        new Response(
          '{"error":{"code":"BAD","message":"bad","details":{"value":1e999}}}',
          { status: 400 },
        ),
    );
    await expect(errors.scenes()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("sends multipart uploads without overriding the browser boundary", async () => {
    const api = createApiClient("/api/v1", async (_, init) => {
      const form = init?.body as FormData;
      expect(form.get("file")).toBeInstanceOf(File);
      expect(form.get("parser")).toBe("csv");
      expect(form.get("mapping_config")).toBe('{"time":"stamp"}');
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      return json(example("service/upload_result"), 201);
    });
    const result = await api.upload("s", new File(["a,b"], "test.csv"), {
      parser: "csv",
      mapping_config: { time: "stamp" },
    });
    expect(result.log_id).toBe("example-log");
  });

  it.each([
    { parser: 3 },
    { mapping_config: { value: undefined } },
    { mapping_config: { value: Infinity } },
  ])(
    "rejects invalid upload options instead of silently serializing them",
    async (options) => {
      const api = createApiClient("/api/v1", async () => {
        throw new Error("must not fetch");
      });
      await expect(
        api.upload("s", new File(["a"], "a.csv"), options as any),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    },
  );

  it("normalizes curve channels and validates bounded finite queries", async () => {
    const api = createApiClient("/api/v1", async (url) => {
      expect(String(url)).toContain("channels=one%2Ctwo");
      return json({
        log_id: "l",
        from_s: 0,
        to_s: 2,
        max_points: 10,
        series: [],
      });
    });
    await expect(
      api.curve("s", "l", { channels: " one,two,one ", max_points: 10 }),
    ).resolves.toMatchObject({ log_id: "l" });
    for (const params of [
      { channels: "one,,two" },
      { channels: "one", to_s: Infinity },
      { channels: "one", from_s: 5, to_s: 1 },
      { channels: "one", max_points: 1 },
    ]) {
      await expect(api.curve("s", "l", params)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    }
  });
});
