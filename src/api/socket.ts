import type { WsClientMessage, WsServerMessage } from "./messages.gen";
import { parseServerMessage, validateClientMessage } from "./validation";

export interface SocketStatus {
  state: "connecting" | "open" | "reconnecting" | "closed" | "error";
  generation: number;
  message?: string;
}

/** Structural transport seam: production uses the browser's native WebSocket. */
export interface SocketTransport {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type Timer = ReturnType<typeof globalThis.setTimeout>;
export interface SessionSocketOptions {
  baseUrl?: string;
  onMessage(message: WsServerMessage, generation: number): void;
  onStatus(status: SocketStatus): void;
  WebSocketImpl?: new (url: string) => SocketTransport;
  reconnectDelayMs?: number;
  setTimeout?: (callback: () => void, delay: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}

export class SessionSocket {
  private readonly options: SessionSocketOptions;
  private readonly schedule: (callback: () => void, delay: number) => Timer;
  private readonly cancel: (timer: Timer) => void;
  private readonly retryBase: number;
  private socket: SocketTransport | null = null;
  private retryTimer?: Timer;
  private heartbeatTimer?: Timer;
  private snapshotTimer?: Timer;
  private sessionId: string | null = null;
  private connectionId: string | null = null;
  private generation = 0;
  private incomingSeq = -1;
  private outgoingSeq = 0;
  private retries = 0;
  private active = false;
  private desiredRate?: 10 | 20 | 30;

  constructor(options: SessionSocketOptions) {
    this.options = options;
    this.schedule =
      options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.cancel =
      options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.retryBase = options.reconnectDelayMs ?? 500;
    if (!Number.isFinite(this.retryBase) || this.retryBase < 1)
      throw new RangeError("Reconnect delay must be positive and finite");
  }

  connect(sid: string): void {
    if (typeof sid !== "string" || !sid || sid.length > 256)
      throw new TypeError("Session ID must contain 1–256 characters");
    // Invalidate before closing: a queued event from the retired socket cannot
    // mutate state, even if the browser already captured its old handler.
    this.generation += 1;
    this.clearResources();
    this.sessionId = sid;
    this.active = true;
    this.retries = 0;
    const generation = this.generation;
    this.status("connecting");
    if (this.current(generation)) this.open(generation);
  }

  disconnect(): void {
    this.active = false;
    this.generation += 1;
    this.clearResources();
    this.sessionId = null;
    this.status("closed");
  }

  setTelemetryRate(hz: 10 | 20 | 30): void {
    if (![10, 20, 30].includes(hz))
      throw new RangeError("Telemetry rate must be 10, 20, or 30 Hz");
    this.desiredRate = hz;
    this.send("set_telemetry_rate", hz);
  }

  ping(): void {
    this.send("ping");
  }

  private current(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private status(state: SocketStatus["state"], message?: string): void {
    this.options.onStatus({
      state,
      generation: this.generation,
      ...(message === undefined ? {} : { message }),
    });
  }

  private open(generation: number): void {
    if (!this.current(generation) || !this.sessionId) return;
    try {
      const apiUrl = new URL(
        this.options.baseUrl ?? "/api/v1",
        globalThis.location?.href ?? "http://localhost/",
      );
      if (!["http:", "https:", "ws:", "wss:"].includes(apiUrl.protocol))
        throw new TypeError("Unsupported API URL protocol");
      const url = new URL(
        `/ws/sessions/${encodeURIComponent(this.sessionId)}`,
        apiUrl,
      );
      url.protocol =
        apiUrl.protocol === "https:" || apiUrl.protocol === "wss:"
          ? "wss:"
          : "ws:";
      const WebSocketImpl = this.options.WebSocketImpl ?? globalThis.WebSocket;
      const transport = new WebSocketImpl(url.href);
      this.socket = transport;
      transport.onopen = () => {
        // Physical connection is not usable until its full snapshot is accepted.
        if (!this.current(generation)) return;
      };
      transport.onmessage = (event) => this.receive(event.data, generation);
      transport.onerror = () => {
        if (this.current(generation))
          this.resync(generation, "WebSocket transport error", true);
      };
      transport.onclose = (event) => {
        if (this.current(generation))
          this.resync(generation, `WebSocket closed (${event.code})`);
      };
      this.snapshotTimer = this.schedule(
        () => this.resync(generation, "Connection snapshot timed out"),
        10000,
      );
    } catch (error) {
      this.resync(
        generation,
        error instanceof Error ? error.message : "WebSocket connection failed",
        true,
      );
    }
  }

  private receive(input: unknown, generation: number): void {
    if (!this.current(generation)) return;
    let message: WsServerMessage;
    const first = this.connectionId === null;
    try {
      if (typeof input !== "string")
        throw new TypeError("WS JSON messages must use text frames");
      message = parseServerMessage(input, this.sessionId!);
      if (first) {
        if (message.type !== "connection_snapshot")
          throw new Error("First message must be a connection_snapshot");
      } else {
        if (message.connection_id !== this.connectionId)
          throw new Error("WS connection identity changed");
        if (message.seq !== this.incomingSeq + 1)
          throw new Error("WS sequence gap or duplicate requires resync");
        // The configured backend refreshes complete metadata on control/media
        // resync within the same connection. Identity and contiguous seq still apply.
      }
    } catch (error) {
      this.resync(
        generation,
        error instanceof Error ? error.message : "Invalid WS message",
      );
      return;
    }
    this.connectionId = message.connection_id;
    this.incomingSeq = message.seq;
    if (first) {
      if (this.snapshotTimer !== undefined) this.cancel(this.snapshotTimer);
      this.snapshotTimer = undefined;
      this.retries = 0;
    }
    // The owner restores the full snapshot before observing an open status.
    this.options.onMessage(message, generation);
    if (first && this.current(generation)) {
      this.status("open");
      if (!this.current(generation)) return;
      if (this.desiredRate !== undefined)
        this.send("set_telemetry_rate", this.desiredRate);
      if (this.current(generation)) this.startHeartbeat(generation);
    }
  }

  private send(type: "ping" | "set_telemetry_rate", hz?: 10 | 20 | 30): void {
    if (
      !this.active ||
      !this.socket ||
      this.socket.readyState !== 1 ||
      !this.connectionId ||
      !this.sessionId
    )
      return;
    const generation = this.generation;
    const envelope = {
      schema_version: 1 as const,
      connection_id: this.connectionId,
      session_id: this.sessionId,
      seq: this.outgoingSeq,
      wall_time: Date.now() / 1000,
    };
    const request_id = crypto.randomUUID();
    const message: WsClientMessage =
      type === "ping"
        ? { ...envelope, type, data: { request_id } }
        : { ...envelope, type, data: { request_id, hz: hz! } };
    try {
      this.socket.send(JSON.stringify(validateClientMessage(message)));
      this.outgoingSeq += 1;
    } catch (error) {
      this.resync(
        generation,
        error instanceof Error ? error.message : "WebSocket send failed",
        true,
      );
    }
  }

  private startHeartbeat(generation: number): void {
    this.heartbeatTimer = this.schedule(() => {
      this.heartbeatTimer = undefined;
      if (!this.current(generation)) return;
      this.ping();
      if (this.current(generation)) this.startHeartbeat(generation);
    }, 30000);
  }

  private resync(generation: number, message: string, error = false): void {
    if (!this.current(generation)) return;
    this.generation += 1;
    this.clearResources();
    const nextGeneration = this.generation;
    if (error) this.status("error", message);
    if (!this.current(nextGeneration)) return;
    this.status("reconnecting", message);
    if (!this.current(nextGeneration)) return;
    const delay = Math.min(
      30000,
      this.retryBase * 2 ** Math.min(this.retries, 16),
    );
    this.retries += 1;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = undefined;
      if (this.current(nextGeneration)) this.open(nextGeneration);
    }, delay);
  }

  private clearResources(): void {
    for (const timer of [
      this.retryTimer,
      this.heartbeatTimer,
      this.snapshotTimer,
    ])
      if (timer !== undefined) this.cancel(timer);
    this.retryTimer = this.heartbeatTimer = this.snapshotTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    this.incomingSeq = -1;
    this.outgoingSeq = 0;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* Already closed transports need no action. */
      }
    }
  }
}
