import metadataFixture from "../api/fixtures/joint-metadata.json";
import type {
  ChannelQuality,
  ControlAck,
  CurveResponse,
  FrameSnapshot,
  JointMetadata,
  PlaybackSnapshot,
  RobotList,
  ScenarioId,
  Schema,
  SceneList,
  SessionCreated,
  SessionStatus,
  UploadResult,
  VideoInfo,
  WsServerMessage,
} from "../domain/types";

const DURATION = 12,
  SAMPLE_HZ = 60,
  CAPTURE_MS = 50,
  MAX_UPLOAD = 1024 * 1024;
const phases = [
  "booting",
  "loading_scene",
  "loading_robot",
  "rtsp_publishing",
  "ready",
] as const;
const scenarios: ScenarioId[] = [
  "normal",
  "no-log",
  "parse-error",
  "missing-channels",
  "worker-error",
  "video-delay",
  "data-delay",
  "ws-reconnect",
];
const metadata = metadataFixture as JointMetadata;
type Command = "load" | "play" | "pause" | "stop" | "seek" | "step" | "speed";
type EventPayload = {
  [K in WsServerMessage["type"]]: Pick<
    Extract<WsServerMessage, { type: K }>,
    "type" | "data"
  >;
}[WsServerMessage["type"]];
type JsonObject = Record<string, Schema["JsonValue"]>;
type Worker = Schema["WorkerStatus"];

export class MockError extends Error {
  readonly body: Schema["ErrorEnvelope"];
  constructor(
    readonly status: number,
    code: string,
    message: string,
    details: JsonObject = {},
  ) {
    super(message);
    this.name = "MockError";
    this.body = { error: { code, message, details } };
  }
}
function invalid(message: string): never {
  throw new MockError(400, "INVALID_REQUEST", message);
}
function record(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("Expected a JSON object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((k) => !allowed.includes(k)))
    invalid("Unknown request field");
  return result;
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256)
    invalid(`${name} must be a nonempty string (at most 256 characters)`);
  return value;
}
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    invalid(`${name} must be finite numeric data`);
  return value;
}
function speed(value: unknown): number {
  const n = finite(value, "speed");
  if (n < 0.1 || n > 10) invalid("speed must be between 0.1 and 10");
  return n;
}
function safeIncrement(n: number): number {
  if (n >= Number.MAX_SAFE_INTEGER)
    throw new MockError(
      409,
      "SEQUENCE_EXHAUSTED",
      "Recreate the session: sequence exhausted",
    );
  return n + 1;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function copy<T>(value: T): T {
  return structuredClone(value);
}
function clamp(value: number, min = 0, max = DURATION) {
  return Math.max(min, Math.min(max, value));
}
function jsonValue(value: unknown): value is Schema["JsonValue"] {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonValue)
  );
}
function numericQuery(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
      invalid(`${name} must be numeric`);
    value = Number(value);
  }
  return finite(value, name);
}
function quality(missing: boolean, index?: number): Schema["ChannelQuality"] {
  return missing
    ? {
        origin: "missing",
        valid: false,
        method: "mock.synthetic.v1",
        processing: ["defaulted"],
        source_indices: [],
      }
    : {
        origin: "derived",
        valid: true,
        method: "mock.synthetic.v1",
        processing: ["derived"],
        source_indices: index === undefined ? [] : [index],
      };
}

interface LogRecord {
  result: UploadResult;
  missing: boolean;
}
interface Connection {
  id: string;
  seq: number;
  clientSeq: number;
  hz: 10 | 20 | 30;
  nextHealth: number;
  message: (message: WsServerMessage) => void;
  close?: (code: number, reason: string) => void;
  pending: Array<{ due: number; frame: FrameSnapshot }>;
  active: boolean;
}
interface Session {
  id: string;
  sceneId: string;
  robotId: string;
  createdAt: number;
  phaseIndex: number;
  worker: Worker;
  logs: Map<string, LogRecord>;
  logId: string | null;
  state: PlaybackSnapshot["state"];
  time: number;
  speed: number;
  epoch: number;
  controlSeq: number;
  targetSeq: number;
  captureId: number;
  lastUpdate: number;
  nextCapture: number;
  rendered: Schema["FrameIdentity"] | null;
  frames: Set<(frame: FrameSnapshot) => void>;
  connections: Set<Connection>;
  reconnectAt: number | null;
  alerted: Set<string>;
}
export interface MockRuntimeOptions {
  /** Monotonic clock in milliseconds. No timers run until start() is called. */
  now?: () => number;
  /** UTC Unix seconds; independently injectable from the monotonic clock. */
  wallNow?: () => number;
}
export interface MockConnection {
  receive: (message: unknown) => void;
  dispose: () => void;
}

/** Stateful synthetic service. It never parses the uploaded robot log or claims real H.264. */
export class MockRuntime {
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private session: Session | null = null;
  private scenario: ScenarioId = "normal";
  private serial = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly namespace =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  constructor(options: MockRuntimeOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now() / 1000);
  }
  private id(kind: string) {
    this.serial = safeIncrement(this.serial);
    return `mock-${kind}-${this.namespace}-${this.serial}`;
  }
  getScenario(): ScenarioId {
    return this.scenario;
  }
  setScenario(id: ScenarioId): void {
    if (!scenarios.includes(id)) invalid("Unknown mock scenario");
    this.tick();
    this.scenario = id;
    const s = this.session;
    if (!s) return;
    if (id === "worker-error") this.failWorker(s);
    if (id === "no-log" && s.state !== "error") {
      s.logId = null;
      s.state = "idle";
      s.time = 0;
      s.epoch = safeIncrement(s.epoch);
      s.rendered = null;
      s.connections.forEach((c) => {
        c.pending = [];
      });
      this.broadcast(s, {
        type: "playback_state",
        data: {
          playback: this.snapshot(s),
          reason: "mock_no_log",
          request_id: null,
        },
      });
    }
    if (id === "ws-reconnect") {
      if (s.connections.size) {
        for (const c of [...s.connections])
          this.closeConnection(s, c, 1012, "Mock reconnect scenario");
      } else s.reconnectAt = this.now() + 1000;
    } else s.reconnectAt = null;
  }
  getScenes(): SceneList {
    return {
      scenes: [
        {
          id: "mock-lab",
          name: "Mock 合成实验室",
          description: "CPU synthetic fixture; no IsaacSim is running.",
          source: "mock.synthetic.v1",
          thumbnail_url: null,
        },
      ],
    };
  }
  getRobots(): RobotList {
    return {
      robots: [
        {
          id: metadata.robot_id,
          name: "R1 Pro · Mock",
          dof: 28,
          usd_variants: [
            {
              isaacsim_version: "6.2.0",
              physics_engine: "physx",
              usd_path: "mock://synthetic/r1pro.usd",
            },
          ],
        },
      ],
    };
  }
  getJointMetadata(robotId: string): JointMetadata {
    identifier(robotId, "robot_id");
    if (robotId !== metadata.robot_id)
      throw new MockError(404, "ROBOT_NOT_FOUND", "Robot not found");
    return copy(metadata);
  }
  createSession(body: unknown): SessionCreated {
    const b = record(body, [
      "scene_id",
      "robot_id",
      "isaacsim_version",
      "mode",
      "physics_engine",
    ]);
    const sceneId = identifier(b.scene_id, "scene_id"),
      robotId = identifier(b.robot_id, "robot_id");
    for (const [key, value] of [
      ["isaacsim_version", "6.2.0"],
      ["mode", "kinematic"],
      ["physics_engine", "physx"],
    ])
      if (b[key] !== undefined && b[key] !== value)
        invalid(`Unsupported ${key}`);
    if (!this.getScenes().scenes.some((scene) => scene.id === sceneId))
      throw new MockError(404, "SCENE_NOT_FOUND", "Scene not found");
    this.getJointMetadata(robotId);
    if (this.session)
      throw new MockError(
        409,
        "SESSION_EXISTS",
        "Only one mock session may be active",
      );
    const now = this.now(),
      id = this.id("session");
    this.session = {
      id,
      sceneId,
      robotId,
      createdAt: now,
      phaseIndex: 0,
      worker: {
        phase: "booting",
        pid: null,
        message: "Mock worker booting",
        restart_policy: "recreate_session_reload_from_start",
      },
      logs: new Map(),
      logId: null,
      state: "idle",
      time: 0,
      speed: 1,
      epoch: 0,
      controlSeq: 0,
      targetSeq: 0,
      captureId: 0,
      lastUpdate: now,
      nextCapture: now + CAPTURE_MS,
      rendered: null,
      frames: new Set(),
      connections: new Set(),
      reconnectAt: this.scenario === "ws-reconnect" ? now + 1000 : null,
      alerted: new Set(),
    };
    return { session_id: id, status: "starting", ws_url: `/ws/sessions/${id}` };
  }
  private requireSession(sid: string): Session {
    identifier(sid, "session_id");
    if (!this.session || this.session.id !== sid)
      throw new MockError(404, "SESSION_NOT_FOUND", "Session not found");
    return this.session;
  }
  private ready(s: Session): void {
    if (s.worker.phase === "error" || s.state === "error")
      throw new MockError(
        409,
        "WORKER_FAILED",
        "Worker failed; recreate session and re-upload from start",
      );
    if (s.worker.phase !== "ready")
      throw new MockError(503, "WORKER_NOT_READY", "Worker is not ready");
  }
  private log(s: Session, lid: string): LogRecord {
    identifier(lid, "log_id");
    const log = s.logs.get(lid);
    if (!log) throw new MockError(404, "LOG_NOT_FOUND", "Log not found");
    return log;
  }
  getSession(sid: string): SessionStatus {
    this.tick();
    const s = this.requireSession(sid);
    return {
      session_id: s.id,
      scene_id: s.sceneId,
      robot_id: s.robotId,
      isaacsim_version: "6.2.0",
      mode: "kinematic",
      physics_engine: "physx",
      status:
        s.worker.phase === "error"
          ? "error"
          : s.worker.phase === "ready"
            ? "ready"
            : "starting",
      ws_url: `/ws/sessions/${s.id}`,
      worker: copy(s.worker),
      video: this.video(s),
      render_fps: s.worker.phase === "ready" ? 20 : null,
    };
  }
  deleteSession(sid: string): void {
    identifier(sid, "session_id");
    const s = this.session;
    if (!s || s.id !== sid) return;
    for (const c of [...s.connections])
      this.closeConnection(s, c, 1000, "Session deleted");
    s.frames.clear();
    s.logs.clear();
    s.alerted.clear();
    s.reconnectAt = null;
    this.session = null;
  }
  async uploadLog(
    sid: string,
    file: File,
    options: { parser?: unknown; mapping_config?: unknown } = {},
  ): Promise<UploadResult> {
    if (
      !file ||
      typeof file.arrayBuffer !== "function" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      invalid("file must be an uploaded File");
    if (file.size > MAX_UPLOAD)
      throw new MockError(413, "UPLOAD_TOO_LARGE", "Mock upload exceeds 1 MiB");
    if (options.parser !== undefined && options.parser !== null) {
      if (
        typeof options.parser !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(options.parser)
      )
        invalid("parser must be a safe identifier (at most 128 characters)");
    }
    if (
      options.mapping_config !== undefined &&
      options.mapping_config !== null
    ) {
      if (
        typeof options.mapping_config !== "object" ||
        Array.isArray(options.mapping_config) ||
        !jsonValue(options.mapping_config)
      )
        invalid("mapping_config must be a finite JSON object");
    }
    this.tick();
    const s = this.requireSession(sid);
    this.ready(s);
    if (this.scenario === "parse-error")
      throw new MockError(
        422,
        "MOCK_PARSE_ERROR",
        "Mock scenario: synthetic parser failure; uploaded content was not parsed",
        {
          parser: "mock_fixture_v1",
          issues: [
            {
              severity: "error",
              code: "MOCK_PARSE_ERROR",
              message:
                "Mock synthetic parser failure; no uploaded content was parsed.",
              line: null,
              channel: null,
            },
          ],
        },
      );
    if (s.logs.size >= 16)
      throw new MockError(
        409,
        "MOCK_LOG_CAPACITY",
        "Mock log capacity reached; recreate session",
      );
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_UPLOAD)
      throw new MockError(413, "UPLOAD_TOO_LARGE", "Mock upload exceeds 1 MiB");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    if (this.requireSession(sid) !== s)
      throw new MockError(404, "SESSION_NOT_FOUND", "Session not found");
    this.ready(s);
    const missing = this.scenario === "missing-channels",
      logId = this.id("log"),
      mappingId = this.id("mapping");
    const channels = this.channels(missing);
    const result: UploadResult = {
      log_id: logId,
      parser: "mock_fixture_v1",
      raw_file_ref: `mock://uploads/${logId}`,
      raw_file_sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
      mapping_snapshot_id: mappingId,
      mapping_snapshot: {
        schema_version: 1,
        synthetic: true,
        method: "mock.synthetic.v1",
        input_file_name: file.name,
        requested_parser:
          options.parser === undefined
            ? null
            : (options.parser as string | null),
        requested_mapping:
          options.mapping_config === undefined
            ? null
            : (options.mapping_config as Schema["JsonValue"]),
        time_unit: "s",
        original_sample_hz: 60,
      },
      stats: {
        duration_s: DURATION,
        sample_count: 721,
        nominal_rate_hz: 60,
        joints_mapped: channels
          .filter((c) => c.quality.valid)
          .map((c) => c.name),
        joints_missing: channels
          .filter((c) => !c.quality.valid)
          .map((c) => c.name),
        chassis: {
          available: true,
          frame: "world",
          source_channels: [
            "mock.chassis.x",
            "mock.chassis.y",
            "mock.chassis.yaw",
          ],
        },
      },
      issues: [
        {
          severity: "info",
          code: "MOCK_SYNTHETIC_FIXTURE",
          message:
            "Mock：仅记录文件名、摘要和映射信息；当前显示合成轨迹，未解析或持久化文件内容。",
        },
        ...(missing
          ? [
              {
                severity: "warning" as const,
                code: "MOCK_MISSING_CHANNELS",
                message:
                  "Mock: three synthetic channels intentionally missing.",
              },
            ]
          : []),
      ],
      channels,
    };
    s.logs.set(logId, { result: freeze(copy(result)), missing });
    return copy(result);
  }
  private channels(missing: boolean): Schema["ChannelDescriptor"][] {
    return metadata.joints.map((joint, index) => ({
      name: joint.name,
      label: `${joint.name} · Mock`,
      kind: "joint",
      joint_index: index,
      unit: joint.unit,
      source_unit: joint.unit,
      source_field: null,
      quality: quality(missing && index >= 25),
      lower: joint.lower,
      upper: joint.upper,
      angle_semantics:
        joint.type === "continuous"
          ? "angular_unwrapped"
          : joint.type === "revolute"
            ? "bounded"
            : "linear",
      wrap_period: null,
    }));
  }
  getLogChannels(sid: string, lid: string): Schema["LogChannels"] {
    const log = this.log(this.requireSession(sid), lid);
    return { log_id: lid, channels: copy(log.result.channels) };
  }
  getCurve(
    sid: string,
    lid: string,
    query: Record<string, unknown>,
  ): CurveResponse {
    const b = record(query, ["channels", "from_s", "to_s", "max_points"]);
    if (
      typeof b.channels !== "string" ||
      b.channels.length < 1 ||
      b.channels.length > 32768
    )
      invalid("channels must be a comma-separated string");
    const pieces = b.channels.split(",").map((c) => c.trim());
    if (pieces.some((c) => !c))
      invalid("channels cannot contain empty entries");
    const names = [...new Set(pieces)];
    if (names.length > 128) invalid("At most 128 channels may be queried");
    names.forEach((name) => identifier(name, "channel"));
    const from = numericQuery(b.from_s, 0, "from_s"),
      to = numericQuery(b.to_s, Math.max(from, DURATION), "to_s"),
      max = numericQuery(b.max_points, 2000, "max_points");
    if (from < 0 || to < 0 || from > to) invalid("Invalid curve time range");
    if (!Number.isInteger(max) || max < 2 || max > 10000)
      invalid("max_points must be an integer between 2 and 10000");
    const log = this.log(this.requireSession(sid), lid);
    const series = names.map((name) => {
      const index = metadata.canonical_order.indexOf(name);
      if (index < 0)
        throw new MockError(
          404,
          "CHANNEL_NOT_FOUND",
          `Channel not found: ${name}`,
        );
      const missing = log.missing && index >= 25,
        points: Schema["CurvePoint"][] = [];
      // Prescan original samples independently of the chart's point budget.
      // Sample classifications hold until the next original sample; then clip
      // the full spans so a query beginning between samples retains its limit.
      const intervals: Schema["LimitInterval"][] = [];
      const descriptor = log.result.channels[index];
      if (
        !missing &&
        descriptor.angle_semantics !== "angular_unwrapped" &&
        descriptor.lower != null &&
        descriptor.upper != null &&
        Number.isFinite(descriptor.lower) &&
        Number.isFinite(descriptor.upper) &&
        descriptor.upper > descriptor.lower
      ) {
        let active: Schema["LimitInterval"] | null = null;
        for (let sample = 0; sample <= 720; sample++) {
          const time = sample / SAMPLE_HZ;
          const normalized =
            (this.sourceValue(index, time) - descriptor.lower) /
            (descriptor.upper - descriptor.lower);
          const severity =
            normalized < 0 || normalized > 1
              ? "error"
              : normalized <= 0.05 || normalized >= 0.95
                ? "warning"
                : null;
          if (active && active.severity !== severity) {
            active.to_s = time;
            intervals.push(active);
            active = null;
          }
          if (severity && !active)
            active = {
              channel: name,
              from_s: time,
              to_s: time,
              severity,
              code:
                severity === "error"
                  ? "JOINT_LIMIT_EXCEEDED"
                  : "JOINT_LIMIT_NEAR",
            };
          if (active) active.to_s = time;
        }
        if (active) intervals.push(active);
      }
      for (
        let sample = Math.max(0, Math.ceil(from * SAMPLE_HZ));
        sample <= Math.min(720, Math.floor(to * SAMPLE_HZ));
        sample++
      )
        points.push({
          time_s: sample / SAMPLE_HZ,
          value: missing ? null : this.sourceValue(index, sample / SAMPLE_HZ),
          quality: quality(missing, sample),
        });
      return {
        channel: name,
        unit: log.result.channels[index].unit,
        points: this.downsample(points, max),
        limit_intervals: intervals
          .filter((interval) => interval.to_s >= from && interval.from_s <= to)
          .map((interval) => ({
            ...interval,
            from_s: Math.max(from, interval.from_s),
            to_s: Math.min(to, interval.to_s),
          })),
      };
    });
    return {
      log_id: lid,
      from_s: from,
      to_s: to,
      max_points: max,
      downsampling: "min_max",
      series,
    };
  }
  private downsample(
    points: Schema["CurvePoint"][],
    max: number,
  ): Schema["CurvePoint"][] {
    if (points.length <= max) return points;
    const buckets = Math.floor(max / 2),
      selected = new Set<number>();
    for (let bucket = 0; bucket < buckets; bucket++) {
      const begin = Math.floor((bucket * points.length) / buckets),
        end = Math.floor(((bucket + 1) * points.length) / buckets);
      let min = begin,
        maxIndex = begin;
      for (let i = begin + 1; i < end; i++) {
        if ((points[i].value ?? 0) < (points[min].value ?? 0)) min = i;
        if ((points[i].value ?? 0) > (points[maxIndex].value ?? 0))
          maxIndex = i;
      }
      selected.add(min);
      selected.add(maxIndex);
    }
    return [...selected].sort((a, b) => a - b).map((i) => points[i]);
  }
  getPlayback(sid: string): PlaybackSnapshot {
    this.tick();
    return this.snapshot(this.requireSession(sid));
  }
  private position(s: Session): Schema["PositionRef"] {
    const sample = s.time * SAMPLE_HZ,
      rounded = Math.round(sample);
    return {
      log_time_s: s.time,
      source_sample_index: Math.abs(sample - rounded) < 1e-8 ? rounded : null,
      target_seq: s.targetSeq,
    };
  }
  private snapshot(s: Session): PlaybackSnapshot {
    return {
      schema_version: 1,
      session_id: s.id,
      state: s.state,
      log_id: s.logId,
      duration_s: s.logId ? DURATION : 0,
      speed: s.speed,
      playback_epoch: s.epoch,
      control_seq: s.controlSeq,
      target_position: s.logId ? this.position(s) : null,
      applied_position: s.logId ? this.position(s) : null,
      rendered_identity: s.rendered ? copy(s.rendered) : null,
    };
  }
  control(sid: string, command: string, body: unknown): ControlAck {
    const commands: Command[] = [
      "load",
      "play",
      "pause",
      "stop",
      "seek",
      "step",
      "speed",
    ];
    if (!commands.includes(command as Command))
      invalid("Unknown playback command");
    const extra: Record<Command, string[]> = {
      load: ["log_id"],
      play: ["speed"],
      pause: [],
      stop: [],
      seek: ["time_s", "frame_index"],
      step: ["direction"],
      speed: ["speed"],
    };
    const optional = ["play", "pause", "stop"].includes(command);
    const b = record(optional && body == null ? {} : body, [
      "request_id",
      ...extra[command as Command],
    ]);
    if (b.request_id !== undefined && b.request_id !== null)
      identifier(b.request_id, "request_id");
    let requestedSpeed: number | undefined, target: number | undefined;
    if (command === "load") identifier(b.log_id, "log_id");
    if (
      command === "speed" ||
      (command === "play" && b.speed !== undefined && b.speed !== null)
    )
      requestedSpeed = speed(b.speed);
    if (command === "seek") {
      if (Object.hasOwn(b, "time_s") === Object.hasOwn(b, "frame_index"))
        invalid("seek requires exactly one of time_s or frame_index");
      if (Object.hasOwn(b, "time_s"))
        target = clamp(finite(b.time_s, "time_s"));
      else {
        const n = finite(b.frame_index, "frame_index");
        if (!Number.isSafeInteger(n))
          invalid("frame_index must be a safe integer");
        target = clamp(n, 0, 720) / SAMPLE_HZ;
      }
    }
    if (
      command === "step" &&
      b.direction !== "forward" &&
      b.direction !== "backward"
    )
      invalid("direction must be forward or backward");
    this.tick();
    const s = this.requireSession(sid);
    this.ready(s);
    if (command === "load") this.log(s, b.log_id as string);
    else if (!s.logId)
      throw new MockError(
        409,
        "LOG_NOT_LOADED",
        "Load a log before playback controls",
      );
    const requestId =
      b.request_id == null ? this.id("request") : (b.request_id as string);
    s.controlSeq = safeIncrement(s.controlSeq);
    s.targetSeq = safeIncrement(s.targetSeq);
    let jump = false;
    if (command === "load") {
      s.logId = b.log_id as string;
      s.time = 0;
      s.state = "ready";
      jump = true;
    }
    if (command === "play") {
      if (s.state === "ended") {
        s.time = 0;
        jump = true;
      }
      s.state = "playing";
    }
    if (command === "pause") s.state = "paused";
    if (command === "stop") {
      s.time = 0;
      s.state = "ready";
      jump = true;
    }
    if (command === "seek") {
      s.time = target!;
      if (s.state === "ended") s.state = "paused";
      jump = true;
    }
    if (command === "step") {
      const sample = s.time * SAMPLE_HZ,
        nearest = Math.round(sample),
        stable = Math.abs(sample - nearest) < 1e-8 ? nearest : sample;
      s.time =
        clamp(
          b.direction === "forward"
            ? Math.floor(stable) + 1
            : Math.ceil(stable) - 1,
          0,
          720,
        ) / SAMPLE_HZ;
      s.state = "paused";
      jump = true;
    }
    if (requestedSpeed !== undefined) s.speed = requestedSpeed;
    if (jump) {
      s.epoch = safeIncrement(s.epoch);
      s.rendered = null;
      s.alerted.clear();
      s.connections.forEach((c) => {
        c.pending = [];
      });
    }
    s.lastUpdate = this.now();
    const playback = this.snapshot(s);
    this.broadcast(s, {
      type: "playback_state",
      data: { playback, reason: command, request_id: requestId },
    });
    return {
      ack_stage: "accepted",
      request_id: requestId,
      control_seq: s.controlSeq,
      playback_epoch: s.epoch,
      playback,
    };
  }
  getVideo(sid: string): VideoInfo {
    this.tick();
    return this.video(this.requireSession(sid));
  }
  private video(s: Session): VideoInfo {
    const publishing = s.worker.phase === "ready";
    return {
      transport: "whep",
      publishing,
      whep_url: publishing ? `https://mock.invalid/whep/${s.id}` : null,
      stream_path: publishing ? `mock/${s.id}` : null,
      ice_servers: [],
      sei_uuid_hex: publishing ? "83249d41b6545e6e8d7779430f88bb0d" : null,
      snapshot_transport: "h264_sei_snapshot_catalog",
      catalog_schema_version: 1,
      identity_scheme: "capture32_crc32",
      decoder: "webcodecs_h264",
      receiver_transform: "rtcrtp_script_transform_or_encoded_streams",
      presentation: "verified_pair_single_canvas",
      render_fps: publishing ? 20 : null,
    };
  }
  subscribeFrames(
    sid: string,
    listener: (frame: FrameSnapshot) => void,
  ): () => void {
    const s = this.requireSession(sid);
    s.frames.add(listener);
    return () => s.frames.delete(listener);
  }
  subscribeEvents(
    sid: string,
    listener: (message: WsServerMessage) => void,
  ): () => void {
    return this.subscribeConnection(sid, { message: listener }).dispose;
  }
  subscribeConnection(
    sid: string,
    handlers: {
      message: (message: WsServerMessage) => void;
      close?: (code: number, reason: string) => void;
    },
  ): MockConnection {
    this.tick();
    const s = this.requireSession(sid);
    const c: Connection = {
      id: this.id("connection"),
      seq: 0,
      clientSeq: -1,
      hz: 20,
      nextHealth: this.now() + 50,
      message: handlers.message,
      close: handlers.close,
      pending: [],
      active: true,
    };
    s.connections.add(c);
    this.send(s, c, {
      type: "connection_snapshot",
      data: {
        joint_meta: copy(metadata),
        playback: this.snapshot(s),
        worker: copy(s.worker),
        video: this.video(s),
        sync: {
          state: "awaiting_pair",
          playback_epoch: s.epoch,
          last_rendered_identity: s.rendered ? copy(s.rendered) : null,
          identity_scheme: "capture32_crc32",
          presentation: "verified_pair_single_canvas",
          snapshot_catalog_capacity: 16,
          gap_action: "reconnect_and_wait_for_pair",
        },
        telemetry_hz: c.hz,
      },
    });
    return {
      dispose: () => this.removeConnection(s, c),
      receive: (message) => {
        if (!c.active) return;
        try {
          this.clientMessage(s, c, message);
        } catch {
          this.closeConnection(
            s,
            c,
            1008,
            "Invalid mock WebSocket client message",
          );
        }
      },
    };
  }
  private clientMessage(s: Session, c: Connection, message: unknown): void {
    const m = record(message, [
      "schema_version",
      "session_id",
      "connection_id",
      "seq",
      "wall_time",
      "type",
      "data",
    ]);
    if (m.schema_version !== undefined && m.schema_version !== 1)
      invalid("Unsupported schema version");
    if (m.session_id !== s.id || m.connection_id !== c.id)
      invalid("Mismatched connection identity");
    const seq = finite(m.seq, "seq");
    if (!Number.isSafeInteger(seq) || seq <= c.clientSeq)
      invalid("Client sequence must increase");
    if (finite(m.wall_time, "wall_time") < 0)
      invalid("wall_time must be positive");
    if (m.type !== "ping" && m.type !== "set_telemetry_rate")
      invalid("Unknown client message");
    const data = record(
        m.data,
        m.type === "ping" ? ["request_id"] : ["request_id", "hz"],
      ),
      requestId = identifier(data.request_id, "request_id");
    if (m.type === "set_telemetry_rate") {
      if (data.hz !== 10 && data.hz !== 20 && data.hz !== 30)
        invalid("Telemetry rate must be 10, 20, or 30");
      c.hz = data.hz;
      c.nextHealth = this.now() + 1000 / c.hz;
      this.send(s, c, {
        type: "telemetry_rate_changed",
        data: { hz: c.hz, request_id: requestId },
      });
    } else this.send(s, c, { type: "pong", data: { request_id: requestId } });
    c.clientSeq = seq;
  }
  private send(s: Session, c: Connection, event: EventPayload): void {
    if (!c.active) return;
    c.seq = safeIncrement(c.seq);
    c.message(
      freeze({
        ...event,
        schema_version: 1,
        session_id: s.id,
        connection_id: c.id,
        seq: c.seq,
        wall_time: this.wallNow(),
      }) as WsServerMessage,
    );
  }
  private broadcast(s: Session, event: EventPayload): void {
    for (const c of s.connections) this.send(s, c, event);
  }
  private removeConnection(s: Session, c: Connection): void {
    c.active = false;
    c.pending = [];
    s.connections.delete(c);
  }
  private closeConnection(
    s: Session,
    c: Connection,
    code: number,
    reason: string,
  ): void {
    if (!c.active) return;
    this.removeConnection(s, c);
    c.close?.(code, reason);
  }
  private failWorker(s: Session): void {
    if (s.worker.phase === "error") return;
    const error = {
      code: "MOCK_WORKER_EXITED",
      message: "Mock worker failure; recreate session and re-upload from start",
      details: { synthetic: true },
    };
    s.worker = {
      phase: "error",
      pid: null,
      message: error.message,
      error,
      restart_policy: "recreate_session_reload_from_start",
    };
    s.state = "error";
    s.connections.forEach((c) => {
      c.pending = [];
    });
    this.broadcast(s, {
      type: "system",
      data: {
        event: "worker_exited",
        worker: copy(s.worker),
        error,
        message: error.message,
      },
    });
    this.broadcast(s, {
      type: "playback_state",
      data: {
        playback: this.snapshot(s),
        reason: "worker_error",
        request_id: null,
      },
    });
    this.broadcast(s, {
      type: "alert",
      data: {
        alert_id: this.id("alert"),
        severity: "error",
        source: "mock.worker",
        code: error.code,
        message: error.message,
        log_id: null,
        playback_epoch: null,
        log_time_s: null,
        joint_index: null,
      },
    });
  }
  private advance(s: Session, now: number): void {
    const delta = Math.max(0, now - s.lastUpdate);
    s.lastUpdate = now;
    if (s.state === "playing") {
      s.time = clamp(s.time + (delta / 1000) * s.speed);
      if (s.time >= DURATION) {
        s.state = "ended";
        this.broadcast(s, {
          type: "playback_state",
          data: {
            playback: this.snapshot(s),
            reason: "ended",
            request_id: null,
          },
        });
      }
    }
  }
  private sourceValue(index: number, time: number): number {
    const joint = metadata.joints[index];
    if (joint.type === "continuous")
      return (index % 2 ? -1 : 1) * (2.4 * time + index * 0.1);
    const lower = joint.lower ?? -1,
      upper = joint.upper ?? 1;
    return (
      (lower + upper) / 2 +
      (upper - lower) * 0.56 * Math.sin((time * Math.PI) / 6 + index * 0.17)
    );
  }
  private capture(s: Session, at: number): void {
    if (
      !s.logId ||
      !["ready", "playing", "paused", "ended"].includes(s.state) ||
      s.worker.phase !== "ready"
    )
      return;
    if (s.captureId >= 0xffffffff) {
      this.failWorker(s);
      return;
    }
    s.captureId++;
    s.targetSeq = safeIncrement(s.targetSeq);
    const missing =
      this.scenario === "missing-channels" || this.log(s, s.logId).missing;
    const qualities: ChannelQuality[] = [],
      source: number[] = [],
      joints: number[] = [];
    let flags = 0,
      warns = 0;
    const sourceIndex = this.position(s).source_sample_index;
    metadata.joints.forEach((joint, i) => {
      const absent = missing && i >= 25,
        value = absent ? 0 : this.sourceValue(i, s.time);
      source.push(value);
      joints.push(
        joint.type === "continuous"
          ? ((((value + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) %
              (2 * Math.PI)) -
              Math.PI
          : value,
      );
      qualities.push(quality(absent, sourceIndex ?? undefined));
      if (
        !absent &&
        joint.type !== "continuous" &&
        joint.lower !== null &&
        joint.upper !== null
      ) {
        const normalized = (value - joint.lower) / (joint.upper - joint.lower);
        if (normalized < 0 || normalized > 1) flags |= 1 << i;
        else if (normalized <= 0.05 || normalized >= 0.95) warns |= 1 << i;
      }
    });
    const frame = freeze<FrameSnapshot>({
      schema_version: 1,
      session_id: s.id,
      log_id: s.logId,
      playback_epoch: s.epoch,
      control_seq: s.controlSeq,
      target_seq: s.targetSeq,
      capture_id: s.captureId,
      render_seq: s.captureId,
      captured_wall_s: this.wallNow() - (this.now() - at) / 1000,
      log_time_s: s.time,
      source_sample_index: sourceIndex,
      state: s.state as FrameSnapshot["state"],
      duration_s: DURATION,
      progress: s.time / DURATION,
      speed: s.speed,
      source_joints: source as FrameSnapshot["source_joints"],
      joints: joints as FrameSnapshot["joints"],
      quality: qualities as FrameSnapshot["quality"],
      chassis: {
        frame: "world" as const,
        x: Math.sin(s.time * 0.2) * 0.5,
        y: Math.cos(s.time * 0.2) * 0.2,
        yaw: s.time * 0.12,
      },
      limit_flags: flags,
      limit_warn_flags: warns,
    });
    s.rendered = {
      schema_version: 1,
      session_id: s.id,
      log_id: s.logId,
      playback_epoch: s.epoch,
      control_seq: s.controlSeq,
      target_seq: s.targetSeq,
      capture_id: s.captureId,
      render_seq: s.captureId,
    };
    for (const listener of s.frames) listener(frame);
    for (const c of s.connections) {
      if (this.scenario === "data-delay") {
        if (c.pending.length >= 32) c.pending.shift();
        c.pending.push({ due: at + 650, frame });
      } else this.send(s, c, { type: "frame_snapshot", data: frame });
    }
    const alertKey = `${s.epoch}:${flags}:${warns}`;
    if ((flags || warns) && !s.alerted.has(alertKey)) {
      // At most one alert per second/epoch; keep the fixture history bounded.
      const secondKey = `${s.epoch}:second:${Math.floor(s.time)}`;
      if (!s.alerted.has(secondKey)) {
        s.alerted.add(secondKey);
        s.alerted.add(alertKey);
        const bit = flags || warns,
          jointIndex = metadata.joints.findIndex(
            (_, i) => (bit & (1 << i)) !== 0,
          );
        this.broadcast(s, {
          type: "alert",
          data: {
            alert_id: this.id("alert"),
            severity: flags ? "error" : "warning",
            source: "mock.synthetic.v1",
            code: flags ? "JOINT_LIMIT_EXCEEDED" : "JOINT_LIMIT_NEAR",
            message: flags
              ? "Mock synthetic joint exceeds its position limit"
              : "Mock synthetic joint is near its position limit",
            log_id: s.logId,
            playback_epoch: s.epoch,
            log_time_s: s.time,
            joint_index: jointIndex,
            details: { synthetic: true },
          },
        });
      }
    }
  }
  tick(): void {
    const s = this.session;
    if (!s) return;
    const now = this.now();
    if (now < s.lastUpdate) return;
    if (s.worker.phase !== "error") {
      const stage = Math.min(4, Math.floor((now - s.createdAt) / 100));
      while (s.phaseIndex < stage) {
        s.phaseIndex++;
        s.worker = {
          phase: phases[s.phaseIndex],
          pid: null,
          message: `Mock worker ${phases[s.phaseIndex]}`,
          restart_policy: "recreate_session_reload_from_start",
        };
        this.broadcast(s, {
          type: "system",
          data: {
            event: "worker_phase_changed",
            worker: copy(s.worker),
            message: s.worker.message,
          },
        });
      }
      if (s.worker.phase === "ready" && this.scenario === "worker-error")
        this.failWorker(s);
    }
    // Suspend/resume may skip old captures, but cannot create an unbounded catch-up queue.
    if (now - s.nextCapture > 20000) {
      const resume = now - 20000;
      this.advance(s, resume);
      s.nextCapture = resume;
    }
    while (s.nextCapture <= now) {
      const at = s.nextCapture;
      this.advance(s, at);
      this.capture(s, at);
      s.nextCapture += CAPTURE_MS;
    }
    this.advance(s, now);
    for (const c of [...s.connections]) {
      while (c.active && c.pending[0] && c.pending[0].due <= now) {
        const pending = c.pending.shift()!;
        this.send(s, c, { type: "frame_snapshot", data: pending.frame });
      }
      if (c.active && now + 1e-8 >= c.nextHealth) {
        const interval = 1000 / c.hz;
        c.nextHealth +=
          (Math.floor((now - c.nextHealth + 1e-8) / interval) + 1) * interval;
        this.send(s, c, {
          type: "health_telemetry",
          data: {
            worker_alive: s.worker.phase !== "error",
            render_fps: s.worker.phase === "ready" ? 20 : 0,
            cpu_percent: 12 + Math.sin(now / 1000) * 2,
            memory_bytes: 64 * 1024 * 1024,
            gpu_percent: null,
            gpu_memory_bytes: null,
          },
        });
      }
    }
    if (s.reconnectAt !== null && now >= s.reconnectAt) {
      s.reconnectAt = null;
      for (const c of [...s.connections])
        this.closeConnection(s, c, 1012, "Mock reconnect scenario");
    }
  }
  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 10);
  }
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.session) this.deleteSession(this.session.id);
  }
}
export function createMockRuntime(
  options: MockRuntimeOptions = {},
): MockRuntime {
  return new MockRuntime(options);
}
export const mockRuntime = createMockRuntime();
