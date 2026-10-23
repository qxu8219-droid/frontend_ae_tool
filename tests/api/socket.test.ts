import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionSocket,
  type SocketStatus,
  type SocketTransport,
} from "../../src/api/socket";
import type { WsServerMessage } from "../../src/api/messages.gen";
import { validateClientMessage } from "../../src/api/validation";
import { example } from "./fixtures";

class FakeSocket implements SocketTransport {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  remoteClose() {
    this.readyState = 3;
    this.onclose?.({ code: 1013 } as CloseEvent);
  }
}

function snapshot(
  sid = "example-session",
  connection = "connection-1",
  seq = 0,
) {
  const message = example("service/ws_connection_snapshot");
  message.seq = seq;
  message.session_id = sid;
  message.connection_id = connection;
  message.data.playback.session_id = sid;
  message.data.playback.rendered_identity = null;
  message.data.sync.last_rendered_identity = null;
  return message;
}
function health(
  seq: number,
  sid = "example-session",
  connection = "connection-1",
) {
  return {
    ...example("service/ws_health_telemetry"),
    seq,
    session_id: sid,
    connection_id: connection,
  };
}
function setup() {
  const messages: { message: WsServerMessage; generation: number }[] = [];
  const statuses: SocketStatus[] = [];
  const socket = new SessionSocket({
    baseUrl: "https://example.test/api/v1",
    WebSocketImpl: FakeSocket,
    reconnectDelayMs: 100,
    onMessage: (message, generation) => messages.push({ message, generation }),
    onStatus: (status) => statuses.push(status),
  });
  return { socket, messages, statuses };
}

describe("SessionSocket connection lifecycle", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("derives a safe WS URL and waits for a snapshot before declaring open", () => {
    const { socket, messages, statuses } = setup();
    socket.connect("session/with ?");
    const transport = FakeSocket.instances[0]!;
    expect(transport.url).toBe(
      "wss://example.test/ws/sessions/session%2Fwith%20%3F",
    );
    transport.open();
    expect(statuses.at(-1)?.state).toBe("connecting");
    transport.receive(snapshot("session/with ?"));
    expect(messages[0]?.message.type).toBe("connection_snapshot");
    expect(statuses.at(-1)?.state).toBe("open");
    expect(messages[0]?.generation).toBe(statuses.at(-1)?.generation);
    socket.disconnect();
  });

  it("drops late socket callbacks after switching sessions", () => {
    const { socket, messages } = setup();
    socket.connect("first");
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(snapshot("first"));
    const lateCallback = first.onmessage!;
    socket.connect("second");
    const second = FakeSocket.instances[1]!;
    lateCallback({ data: JSON.stringify(health(1, "first")) } as MessageEvent);
    second.open();
    second.receive(snapshot("second", "connection-2"));
    expect(messages.map((entry) => entry.message.session_id)).toEqual([
      "first",
      "second",
    ]);
    expect(messages[1]!.generation).toBeGreaterThan(messages[0]!.generation);
    expect(first.readyState).toBe(3);
    socket.disconnect();
  });

  it("invalidates the generation on a sequence gap and restores only from a fresh full snapshot", () => {
    const { socket, messages, statuses } = setup();
    socket.connect("example-session");
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(snapshot());
    first.receive(health(1));
    first.receive(health(3));
    expect(messages).toHaveLength(2);
    expect(statuses.at(-1)?.state).toBe("reconnecting");
    expect(statuses.at(-1)!.generation).toBeGreaterThan(
      messages[0]!.generation,
    );
    vi.advanceTimersByTime(100);
    const second = FakeSocket.instances[1]!;
    second.open();
    const restored = snapshot("example-session", "fresh", 0);
    restored.data.playback.speed = 2;
    second.receive(restored);
    second.receive(health(1, "example-session", "fresh"));
    expect(messages[2]!.message).toMatchObject({
      type: "connection_snapshot",
      data: { playback: { speed: 2 } },
    });
    expect(messages).toHaveLength(4);
    socket.disconnect();
  });

  it.each([
    "missing-snapshot",
    "malformed",
    "wrong-session",
    "wrong-connection",
    "duplicate",
    "second-snapshot",
  ])("resyncs after %s without delivering the invalid payload", (kind) => {
    const { socket, messages, statuses } = setup();
    socket.connect("example-session");
    const transport = FakeSocket.instances[0]!;
    transport.open();
    if (kind !== "missing-snapshot") transport.receive(snapshot());
    const bad =
      kind === "missing-snapshot"
        ? health(0)
        : kind === "wrong-session"
          ? health(1, "other")
          : kind === "wrong-connection"
            ? health(1, "example-session", "other")
            : kind === "duplicate"
              ? health(0)
              : kind === "second-snapshot"
                ? snapshot("example-session", "connection-1", 1)
                : { ...health(1), extra: true };
    transport.receive(bad);
    expect(messages).toHaveLength(kind === "missing-snapshot" ? 0 : 1);
    expect(transport.readyState).toBe(3);
    expect(statuses.at(-1)?.state).toBe("reconnecting");
    socket.disconnect();
  });

  it("emits complete validated envelopes, resets outgoing sequence, and restores selected telemetry rate", () => {
    const { socket } = setup();
    socket.setTelemetryRate(30);
    socket.connect("example-session");
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(snapshot());
    socket.ping();
    expect(
      first.sent.map((value) => validateClientMessage(value as any)),
    ).toMatchObject([
      {
        type: "set_telemetry_rate",
        seq: 0,
        data: { hz: 30 },
        connection_id: "connection-1",
        session_id: "example-session",
        schema_version: 1,
      },
      { type: "ping", seq: 1, connection_id: "connection-1" },
    ]);
    expect((first.sent[1] as any).data.request_id).toMatch(/^[0-9a-f-]{36}$/);
    first.remoteClose();
    vi.advanceTimersByTime(100);
    const second = FakeSocket.instances[1]!;
    second.open();
    second.receive(snapshot("example-session", "fresh"));
    expect(second.sent[0]).toMatchObject({
      type: "set_telemetry_rate",
      seq: 0,
      connection_id: "fresh",
      data: { hz: 30 },
    });
    socket.disconnect();
  });

  it("pings every 30 seconds and cancels heartbeat and reconnection on explicit disconnect", () => {
    const { socket } = setup();
    socket.connect("example-session");
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(snapshot());
    vi.advanceTimersByTime(30000);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatchObject({ type: "ping" });
    first.remoteClose();
    socket.disconnect();
    vi.advanceTimersByTime(120000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(first.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses bounded exponential retries and times out a connection without a snapshot", () => {
    const { socket } = setup();
    socket.connect("example-session");
    FakeSocket.instances[0]!.remoteClose();
    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    FakeSocket.instances[1]!.remoteClose();
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const third = FakeSocket.instances[2]!;
    third.open();
    vi.advanceTimersByTime(10000);
    expect(third.readyState).toBe(3);
    socket.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});
