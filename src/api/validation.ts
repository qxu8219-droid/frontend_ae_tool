import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import type { components } from "./types.gen";
import type { FrameSnapshot } from "./generated/frame-catalog.gen";
import type {
  ChannelQuality,
  FrameIdentity,
  PlaybackSnapshot,
  VideoInfo,
} from "./generated/ws-server.gen";
import type { WsClientMessage, WsServerMessage } from "./messages.gen";
import openapi from "./schemas/openapi.json";
import serverSchema from "./schemas/ws-server.schema.json";
import clientSchema from "./schemas/ws-client.schema.json";
import frameSchema from "./schemas/frame-catalog.schema.json";
import jointMetadata from "./fixtures/joint-metadata.json";

type Schemas = components["schemas"];

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

// OpenAPI's discriminator is an annotation. oneOf + required const types still
// perform the actual validation; no coercion, defaults, or removal is allowed.
const ajv = new Ajv2020({
  strict: true,
  strictSchema: false,
  strictNumbers: true,
  coerceTypes: false,
  allErrors: true,
  validateFormats: false,
});
const serverValidator = ajv.compile(serverSchema);
const clientValidator = ajv.compile(clientSchema);
const frameValidator = ajv.compile({
  $defs: frameSchema.$defs,
  $ref: "#/$defs/FrameSnapshot",
});
const restRoot = "https://model-evaluation.local/frontend/rest-components";
ajv.addSchema({ $id: restRoot, components: openapi.components });
const restValidators = new Map<string, ValidateFunction>();

function requireContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new ContractValidationError(message);
}

/** Also covers arbitrary JSON details and mapping values outside typed numbers. */
export function assertFiniteJson(
  value: unknown,
  path = "$",
  ancestors = new Set<object>(),
): void {
  if (typeof value === "number")
    requireContract(Number.isFinite(value), `${path}: number must be finite`);
  if (typeof value === "object" && value !== null) {
    requireContract(
      !ancestors.has(value),
      `${path}: cyclic objects are not JSON`,
    );
    ancestors.add(value);
    for (const [key, child] of Object.entries(value))
      assertFiniteJson(child, `${path}.${key}`, ancestors);
    ancestors.delete(value);
  }
}

function validate(
  validator: ValidateFunction,
  value: unknown,
  label: string,
): void {
  assertFiniteJson(value);
  if (!validator(value)) {
    const errors = validator.errors
      ?.slice(0, 4)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new ContractValidationError(
      `${label}: ${errors ?? "invalid contract"}`,
    );
  }
}

function quality(value: ChannelQuality): void {
  requireContract(
    !(value.origin === "missing" && value.valid),
    "Missing source cannot be valid",
  );
  requireContract(
    value.origin !== "derived" || Boolean(value.method),
    "Derived quality requires a method",
  );
  const processing = value.processing ?? [];
  requireContract(
    new Set(processing).size === processing.length,
    "Quality processing operations must be unique",
  );
  requireContract(
    !(
      processing.includes("original") &&
      processing.some((p) =>
        ["interpolated", "forward_filled", "defaulted", "derived"].includes(p),
      )
    ),
    "Processed quality cannot claim original samples",
  );
}

function identity(value: FrameIdentity): void {
  requireContract(
    value.capture_id === value.render_seq,
    "capture_id and render_seq must identify the same frame",
  );
}

function belongsToPlayback(
  frame: FrameIdentity,
  playback: PlaybackSnapshot,
): void {
  identity(frame);
  requireContract(
    frame.session_id === playback.session_id &&
      frame.log_id === playback.log_id &&
      frame.playback_epoch === playback.playback_epoch,
    "Rendered identity belongs to another session/log/epoch",
  );
  requireContract(
    frame.control_seq <= playback.control_seq,
    "Rendered identity exceeds the accepted control barrier",
  );
}

function playback(value: PlaybackSnapshot): void {
  const hasLog = value.log_id != null;
  requireContract(
    hasLog ||
      (!value.target_position &&
        !value.applied_position &&
        !value.rendered_identity),
    "Playback positions require a log",
  );
  requireContract(
    hasLog || value.state === "idle" || value.state === "error",
    "Active playback requires a log",
  );
  for (const position of [value.target_position, value.applied_position]) {
    if (position)
      requireContract(
        position.log_time_s <= (value.duration_s ?? 0),
        "Playback position exceeds duration",
      );
  }
  if (value.rendered_identity)
    belongsToPlayback(value.rendered_identity, value);
}

function video(value: VideoInfo): void {
  requireContract(
    !value.publishing ||
      Boolean(value.whep_url && value.stream_path && value.sei_uuid_hex),
    "Publishing video requires endpoint, stream path, and SEI UUID",
  );
}

function joints(value: Schemas["JointMetadata"]): void {
  requireContract(
    value.canonical_order.every(
      (name, index) => name === jointMetadata.canonical_order[index],
    ),
    "Joint canonical order does not match the protocol",
  );
  value.joints.forEach((joint, index) => {
    requireContract(
      joint.name === value.canonical_order[index],
      "Joint metadata must follow canonical order",
    );
    requireContract(
      joint.unit === (joint.type === "prismatic" ? "m" : "rad"),
      "Joint unit does not match its type",
    );
    requireContract(
      joint.type === "continuous"
        ? joint.lower === null && joint.upper === null
        : joint.lower !== null &&
            joint.upper !== null &&
            joint.lower <= joint.upper,
      "Joint position limits are invalid",
    );
  });
}

function channel(value: Schemas["ChannelDescriptor"]): void {
  quality(value.quality);
  requireContract(
    (value.angle_semantics === "angular_wrapped") ===
      (value.wrap_period != null),
    "Only wrapped angular channels require a wrap period",
  );
}

function curve(value: Schemas["CurveResponse"]): void {
  requireContract(value.from_s <= value.to_s, "Curve range must be ordered");
  requireContract(
    new Set(value.series.map((series) => series.channel)).size ===
      value.series.length,
    "Curve channels must be unique",
  );
  for (const series of value.series) {
    requireContract(
      series.points.length <= value.max_points,
      "Curve point budget exceeded",
    );
    series.points.forEach((point, index) => {
      quality(point.quality);
      requireContract(
        point.value !== null || !point.quality.valid,
        "Null curve values cannot claim valid source data",
      );
      requireContract(
        point.time_s >= value.from_s && point.time_s <= value.to_s,
        "Curve point lies outside requested range",
      );
      requireContract(
        index === 0 || point.time_s > series.points[index - 1]!.time_s,
        "Curve points must be strictly increasing",
      );
    });
    for (const interval of series.limit_intervals ?? []) {
      requireContract(
        interval.channel === series.channel && interval.from_s <= interval.to_s,
        "Limit interval must have ordered times and match its channel",
      );
    }
  }
}

export function validateRest<N extends keyof Schemas>(
  name: N,
  value: unknown,
): Schemas[N] {
  let validator = restValidators.get(name);
  if (!validator) {
    validator = ajv.compile({
      $ref: `${restRoot}#/components/schemas/${name}`,
    });
    restValidators.set(name, validator);
  }
  validate(validator, value, name);
  // Pydantic's model validators are not represented by JSON Schema. These
  // semantic checks mirror those rules using generated types, without defaults.
  switch (name) {
    case "JointMetadata":
      joints(value as Schemas["JointMetadata"]);
      break;
    case "PlaybackSnapshot":
      playback(value as Schemas["PlaybackSnapshot"]);
      break;
    case "VideoInfo":
      video(value as Schemas["VideoInfo"]);
      break;
    case "SessionStatus":
      video((value as Schemas["SessionStatus"]).video);
      break;
    case "RESTPlaybackResponse": {
      const ack = value as Schemas["RESTPlaybackResponse"];
      playback(ack.playback);
      requireContract(
        ack.control_seq === ack.playback.control_seq &&
          ack.playback_epoch === ack.playback.playback_epoch,
        "Control acknowledgement identity does not match playback",
      );
      break;
    }
    case "UploadResult": {
      const upload = value as Schemas["UploadResult"];
      const names = [
        ...upload.stats.joints_mapped,
        ...upload.stats.joints_missing,
      ];
      requireContract(
        names.length === 28 &&
          new Set(names).size === 28 &&
          jointMetadata.canonical_order.every((name) => names.includes(name)),
        "Mapped and missing joints must partition the canonical joints",
      );
      upload.channels.forEach(channel);
      break;
    }
    case "LogChannels":
      (value as Schemas["LogChannels"]).channels.forEach(channel);
      break;
    case "CurveResponse":
      curve(value as Schemas["CurveResponse"]);
      break;
  }
  return value as Schemas[N];
}

export function validateFrameSnapshot(value: unknown): FrameSnapshot {
  validate(frameValidator, value, "FrameSnapshot");
  const frame = value as FrameSnapshot;
  identity(frame);
  requireContract(
    frame.log_time_s <= frame.duration_s,
    "Frame log time exceeds duration",
  );
  const progress =
    frame.duration_s === 0 ? 0 : frame.log_time_s / frame.duration_s;
  requireContract(
    Math.abs(frame.progress - progress) <=
      Math.max(
        1e-9,
        1e-9 * Math.max(Math.abs(frame.progress), Math.abs(progress)),
      ),
    "Frame progress must equal log time divided by duration",
  );
  frame.quality.forEach(quality);
  return frame;
}

export function parseServerMessage(
  input: unknown,
  expectedSessionId?: string,
): WsServerMessage {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new ContractValidationError("WS message must contain valid JSON");
    }
  }
  validate(serverValidator, value, "WS server message");
  const message = value as WsServerMessage;
  requireContract(
    expectedSessionId === undefined || message.session_id === expectedSessionId,
    "WS session does not match the active session",
  );
  switch (message.type) {
    case "connection_snapshot": {
      const data = message.data;
      joints(data.joint_meta);
      playback(data.playback);
      video(data.video);
      requireContract(
        message.session_id === data.playback.session_id,
        "WS playback session does not match its envelope",
      );
      requireContract(
        data.sync.playback_epoch === data.playback.playback_epoch,
        "Connection snapshot epochs do not match",
      );
      if (data.sync.last_rendered_identity)
        belongsToPlayback(data.sync.last_rendered_identity, data.playback);
      break;
    }
    case "playback_state":
      playback(message.data.playback);
      requireContract(
        message.session_id === message.data.playback.session_id,
        "WS playback session does not match its envelope",
      );
      break;
    case "frame_snapshot":
      validateFrameSnapshot(message.data);
      requireContract(
        message.session_id === message.data.session_id,
        "WS frame session does not match its envelope",
      );
      break;
    case "alert": {
      const data = message.data;
      const location = [data.log_id, data.playback_epoch, data.log_time_s].map(
        (v) => v != null,
      );
      requireContract(
        location.every(Boolean) ||
          (location.every((v) => !v) && data.joint_index == null),
        "Alert requires a complete log location",
      );
      break;
    }
  }
  return message;
}

export function validateClientMessage(value: WsClientMessage): WsClientMessage {
  validate(clientValidator, value, "WS client message");
  return value;
}
