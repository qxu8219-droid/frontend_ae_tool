import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { getResponse, HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { createMockHandlers } from "../../src/mocks/handlers";
import { createMockRuntime } from "../../src/mocks/runtime";
import type { WsServerMessage } from "../../src/api/messages.gen";

const origin = "http://mock.test";
const server = setupServer();
let runtime: ReturnType<typeof createMockRuntime>;
let now: number;
const sockets = new Set<WebSocket>();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  now = 0;
  runtime = createMockRuntime({
    now: () => now,
    wallNow: () => 1_700_000_000 + now / 1000,
  });
  server.use(...createMockHandlers(runtime));
});
afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  runtime.dispose();
  server.resetHandlers();
});
afterAll(() => server.close());

function request(path: string, init?: RequestInit) {
  return fetch(`${origin}/api/v1${path}`, init);
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function createSession() {
  const [scenes, robots] = await Promise.all([
    request("/scenes").then((response) => response.json()),
    request("/robots").then((response) => response.json()),
  ]);
  const response = await request(
    "/sessions",
    json({
      scene_id: scenes.scenes[0].id,
      robot_id: robots.robots[0].id,
    }),
  );
  expect(response.status).toBe(201);
  const session = await response.json();
  return session as { session_id: string; ws_url: string };
}

async function readySession() {
  const session = await createSession();
  now += 500;
  runtime.tick();
  return session;
}

function uploadForm() {
  const form = new FormData();
  form.set(
    "file",
    new File(["time_s,value\n0,0\n1,1\n"], "sample.csv", { type: "text/csv" }),
  );
  return form;
}

async function expectError(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({
    error: {
      code: code ?? expect.any(String),
      message: expect.any(String),
    },
  });
}

function connect(session: string) {
  const socket = new WebSocket(`ws://mock.test/ws/sessions/${session}`);
  sockets.add(socket);
  return socket;
}

function nextMessage(socket: WebSocket, type: WsServerMessage["type"]) {
  return new Promise<WsServerMessage>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${type}`)),
      2000,
    );
    const onMessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as WsServerMessage;
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

describe("REST mock transport", () => {
  it("exposes the original 18 routes with contract statuses and shared playback state", async () => {
    const session = await readySession();
    const status = await request(`/sessions/${session.session_id}`).then(
      (response) => response.json(),
    );
    expect(status.status).toBe("ready");
    const joints = await request(`/robots/${status.robot_id}/joints`).then(
      (response) => response.json(),
    );
    expect(joints.canonical_order).toHaveLength(28);

    const uploadResponse = await request(
      `/sessions/${session.session_id}/logs`,
      { method: "POST", body: uploadForm() },
    );
    expect(uploadResponse.status).toBe(201);
    const uploaded = await uploadResponse.json();
    const logPath = `/sessions/${session.session_id}/logs/${uploaded.log_id}`;
    const channels = await request(`${logPath}/channels`).then((response) =>
      response.json(),
    );
    expect(channels.channels.length).toBeGreaterThan(0);
    const curve = await request(
      `${logPath}/curve?channels=${encodeURIComponent(channels.channels[0].name)}&max_points=10`,
    );
    expect(curve.status).toBe(200);

    const commands: Array<[string, Record<string, unknown>]> = [
      ["load", { log_id: uploaded.log_id }],
      ["play", {}],
      ["pause", {}],
      ["seek", { time_s: 1 }],
      ["step", { direction: "forward" }],
      ["speed", { speed: 2 }],
      ["stop", {}],
    ];
    for (const [command, body] of commands) {
      const response = await request(
        `/sessions/${session.session_id}/playback/${command}`,
        json({ ...body, request_id: command }),
      );
      expect(response.status, command).toBe(200);
      expect(await response.json()).toMatchObject({
        ack_stage: "accepted",
        request_id: command,
      });
    }
    const playback = await request(
      `/sessions/${session.session_id}/playback`,
    ).then((response) => response.json());
    expect(playback.speed).toBe(2);
    expect(
      (await request(`/sessions/${session.session_id}/video`)).status,
    ).toBe(200);
    expect(
      (await request(`/sessions/${session.session_id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (await request(`/sessions/${session.session_id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("preserves runtime resource, conflict and worker-not-ready errors", async () => {
    await expectError(await request("/sessions/unknown"), 404);
    const session = await createSession();
    await expectError(
      await request(`/sessions/${session.session_id}/playback/play`, json({})),
      503,
    );
    await expectError(
      await request(
        "/sessions",
        json({
          scene_id: runtime.getScenes().scenes[0].id,
          robot_id: runtime.getRobots().robots[0].id,
        }),
      ),
      409,
    );
    now += 500;
    runtime.tick();
    await expectError(
      await request(`/sessions/${session.session_id}/playback/play`, json({})),
      409,
    );
  });

  it.each(["{", '{"scene_id":NaN}', '{"scene_id":1e400}', "null", "[]"])(
    "rejects malformed or invalid JSON: %s",
    async (body) => {
      await expectError(
        await request("/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        400,
      );
    },
  );

  it("rejects unknown query keys and repeated curve parameters before runtime lookup", async () => {
    await expectError(await request("/scenes?extra=1"), 400);
    await expectError(
      await request(
        "/sessions/unknown/logs/unknown/curve?channels=a&channels=b",
      ),
      400,
    );
    await expectError(
      await request("/sessions/unknown/logs/unknown/curve?channels=a&extra=1"),
      400,
    );
  });

  it("rejects unknown playback commands without forwarding to a real backend", async () => {
    await expectError(
      await request("/sessions/unknown/playback/unknown-command", json({})),
      400,
    );
  });

  it.each([
    "extra",
    "duplicate",
    "missing-file",
    "text-file",
    "mapping-array",
    "mapping-overflow",
  ])("rejects invalid multipart fields: %s", async (kind) => {
    const { session_id } = await createSession();
    const form = uploadForm();
    if (kind === "extra") form.set("extra", "no");
    if (kind === "duplicate")
      form.append("file", new File(["x"], "second.csv"));
    if (kind === "missing-file") form.delete("file");
    if (kind === "text-file") form.set("file", "not-a-file");
    if (kind === "mapping-array") form.set("mapping_config", "[]");
    if (kind === "mapping-overflow") form.set("mapping_config", '{"x":1e400}');
    await expectError(
      await request(`/sessions/${session_id}/logs`, {
        method: "POST",
        body: form,
      }),
      400,
    );
  });

  it("rejects the actual file when it exceeds 1 MiB", async () => {
    const { session_id } = await createSession();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(1024 * 1024 + 1)], "large.csv"));
    await expectError(
      await request(`/sessions/${session_id}/logs`, {
        method: "POST",
        body: form,
      }),
      413,
    );
  });

  it("accepts a 1 MiB file and passes multipart parser and mapping options through", async () => {
    const { session_id } = await readySession();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(1024 * 1024)], "boundary.csv"));
    form.set("parser", "test-parser");
    form.set("mapping_config", '{"source":{"time_unit":"ms","factor":0.001}}');
    const response = await request(`/sessions/${session_id}/logs`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      mapping_snapshot: {
        requested_parser: "test-parser",
        requested_mapping: { source: { time_unit: "ms", factor: 0.001 } },
      },
    });
  });

  it("accepts omitted and null optional playback request bodies", async () => {
    const { session_id } = await readySession();
    const uploaded = await request(`/sessions/${session_id}/logs`, {
      method: "POST",
      body: uploadForm(),
    }).then((response) => response.json());
    await request(
      `/sessions/${session_id}/playback/load`,
      json({ log_id: uploaded.log_id }),
    );
    expect(
      (
        await request(`/sessions/${session_id}/playback/play`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (await request(`/sessions/${session_id}/playback/pause`, json(null)))
        .status,
    ).toBe(200);
  });

  it("preserves fatal log parse errors as 422 with issue details", async () => {
    const { session_id } = await readySession();
    runtime.setScenario("parse-error");
    const response = await request(`/sessions/${session_id}/logs`, {
      method: "POST",
      body: uploadForm(),
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });

  it.each([true, false])(
    "stops reading oversized upload streams (declared length: %s)",
    async (declaredLength) => {
      let reads = 0;
      let streamController:
        ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            streamController = controller;
            reads++;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        },
        { highWaterMark: 0 },
      );
      const headers: Record<string, string> = {
        "content-type": "multipart/form-data; boundary=test",
      };
      if (declaredLength) headers["content-length"] = String(4 * 1024 * 1024);
      const req = new Request(`${origin}/api/v1/sessions/unknown/logs`, {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
      const handlers = createMockHandlers(runtime).filter(
        (handler): handler is HttpHandler => handler instanceof HttpHandler,
      );
      const response = await getResponse(handlers, req);
      expect(response).toBeDefined();
      await expectError(response!, 413);
      expect(reads).toBeLessThan(declaredLength ? 4 : 24);
      const readsAtResponse = reads;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reads).toBe(readsAtResponse);
      // MSW retains an unread logging clone, so cancellation of the handler's
      // tee branch does not cancel the source until that clone finishes too.
      streamController?.close();
    },
  );

  it("bounds JSON bodies independently of multipart uploads", async () => {
    await expectError(
      await request("/sessions", json({ scene_id: "x".repeat(64 * 1024) })),
      413,
    );
  });
});

describe.skipIf(typeof globalThis.WebSocket === "undefined")(
  "native WebSocket mock transport",
  () => {
    it("closes connections to an unknown session", async () => {
      const socket = connect("unknown");
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      expect((await closed).code).toBe(1008);
    });

    it("sends a fresh connection snapshot, correlates ping, and creates a new connection on reconnect", async () => {
      const { session_id } = await readySession();
      const first = connect(session_id);
      const snapshot = await nextMessage(first, "connection_snapshot");
      expect(snapshot.session_id).toBe(session_id);
      expect(snapshot.seq).toBe(1);
      const pong = nextMessage(first, "pong");
      first.send(
        JSON.stringify({
          schema_version: 1,
          session_id,
          connection_id: snapshot.connection_id,
          seq: 1,
          wall_time: Date.now() / 1000,
          type: "ping",
          data: { request_id: "native-ping" },
        }),
      );
      expect(await pong).toMatchObject({
        type: "pong",
        data: { request_id: "native-ping" },
      });
      const closed = new Promise<CloseEvent>((resolve) =>
        first.addEventListener("close", resolve, { once: true }),
      );
      first.close(1000, "reconnect");
      expect((await closed).code).toBe(1000);
      const second = connect(session_id);
      const reconnected = await nextMessage(second, "connection_snapshot");
      expect(reconnected.seq).toBe(1);
      expect(reconnected.connection_id).not.toBe(snapshot.connection_id);
      const terminated = new Promise<CloseEvent>((resolve) =>
        second.addEventListener("close", resolve, { once: true }),
      );
      await request(`/sessions/${session_id}`, { method: "DELETE" });
      expect((await terminated).code).toBe(1000);
    });

    it("closes malformed native client messages with a protocol error", async () => {
      const { session_id } = await readySession();
      const socket = connect(session_id);
      await nextMessage(socket, "connection_snapshot");
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      socket.send("{");
      expect((await closed).code).toBe(1008);
    });

    it("forwards scenario-driven disconnects and snapshots a replacement connection", async () => {
      const { session_id } = await readySession();
      const socket = connect(session_id);
      const first = await nextMessage(socket, "connection_snapshot");
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      runtime.setScenario("ws-reconnect");
      await closed;
      const replacement = connect(session_id);
      const second = await nextMessage(replacement, "connection_snapshot");
      expect(second.seq).toBe(1);
      expect(second.connection_id).not.toBe(first.connection_id);
    });
  },
);

it('returns explicit empty annotations for mock archives and rejects unknown log ids', async () => {
  const session = await readySession();
  const uploaded = await request(`/sessions/${session.session_id}/logs`, { method: 'POST', body: uploadForm() }).then(r => r.json());
  const annotations = await request(`/sessions/${session.session_id}/logs/${uploaded.log_id}/annotations`);
  expect(annotations.status).toBe(200);
  expect(await annotations.json()).toMatchObject({ log_id: uploaded.log_id, source_sha256: uploaded.raw_file_sha256,
    alignment: 'none', provisional: false, assumptions: [], segments: [], events: [], reference: {} });
  await expectError(await request(`/sessions/${session.session_id}/logs/missing/annotations`), 404);
});
