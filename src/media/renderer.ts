import type {
  ChannelQuality,
  FrameSnapshot,
  JointMetadata,
} from "../domain/types";
import { validateFrameSnapshot } from "../api/validation";
import canonicalMetadata from "../api/fixtures/joint-metadata.json";
import {
  decodeStamp,
  MARKER_PIXELS,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
  stampBits,
} from "./stamp";
import type { DecodedFrame } from "./types";

/** Fixed presentation geometry, shared with independent screenshot decoders. */
export const PRESENTATION_WIDTH = 1280;
export const PRESENTATION_HEIGHT = 720;
export const CANVAS_WIDTH = PRESENTATION_WIDTH;
export const CANVAS_HEIGHT = PRESENTATION_HEIGHT;
export const PRESENTATION_IMAGE_RECT = Object.freeze({
  x: 20,
  y: 70,
  width: 900,
  height: 506.25,
});

const COLORS = Object.freeze({
  background: "#080f1b",
  panel: "#0b1523",
  grid: "#192c42",
  edge: "#26374b",
  text: "#e5edf6",
  muted: "#8297af",
  missing: "#738092",
  cyan: "#45d8e8",
  body: "#617c99",
  bodyLight: "#a1b7cd",
  warning: "#f2bd63",
  danger: "#f17e87",
});
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
type Point = readonly [number, number];

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableSnapshot(snapshot: FrameSnapshot): FrameSnapshot {
  // Clone before awaiting bitmap creation: callers retain ownership of their input.
  return freeze(structuredClone(validateFrameSnapshot(snapshot)));
}

function context2d(
  canvas: HTMLCanvasElement,
  readback = false,
): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: readback });
  if (!context)
    throw new Error("A 2D canvas context is required for frame rendering");
  return context;
}

function surface(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  return canvas;
}

function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string = COLORS.text,
  size = 14,
  align: CanvasTextAlign = "left",
): void {
  ctx.font = `${size}px ${MONO}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

function line(
  ctx: CanvasRenderingContext2D,
  points: readonly Point[],
  color: string,
  width = 1,
): void {
  ctx.beginPath();
  points.forEach(([x, y], index) =>
    index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
  );
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function jointColor(snapshot: FrameSnapshot, index: number): string {
  if (
    !snapshot.quality[index].valid ||
    snapshot.quality[index].origin === "missing"
  )
    return COLORS.missing;
  if (snapshot.limit_flags & (1 << index)) return COLORS.danger;
  if (snapshot.limit_warn_flags & (1 << index)) return COLORS.warning;
  return COLORS.cyan;
}

function joint(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  radius = 4,
): void {
  ctx.beginPath();
  ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.panel;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawArm(
  ctx: CanvasRenderingContext2D,
  snapshot: FrameSnapshot,
  shoulder: Point,
  side: -1 | 1,
): void {
  const start = side < 0 ? 10 : 19;
  const lengths = [35, 15, 34, 13, 12, 10, 8];
  let point = shoulder;
  let angle = 0.45;
  lengths.forEach((length, offset) => {
    angle +=
      Math.sin(snapshot.joints[start + offset]) * (offset < 4 ? 0.48 : 0.24);
    const next: Point = [
      point[0] + side * Math.cos(angle) * length,
      point[1] + Math.sin(angle) * length,
    ];
    line(ctx, [point, next], COLORS.body, offset < 4 ? 12 : 7);
    line(ctx, [point, next], COLORS.bodyLight, 2);
    joint(ctx, point, jointColor(snapshot, start + offset), offset < 4 ? 5 : 3);
    point = next;
  });
  // Each claw finger is driven by its own prismatic joint (including missing channels).
  for (const finger of [0, 1]) {
    const index = start + 7 + finger;
    const opening = 5 + Math.min(18, Math.abs(snapshot.joints[index]) * 240);
    const direction = finger === 0 ? -1 : 1;
    const along: Point = [side * Math.cos(angle), Math.sin(angle)];
    const across: Point = [-Math.sin(angle), side * Math.cos(angle)];
    const base: Point = [
      point[0] + across[0] * opening * direction,
      point[1] + across[1] * opening * direction,
    ];
    const tip: Point = [base[0] + along[0] * 14, base[1] + along[1] * 14];
    line(
      ctx,
      [
        point,
        base,
        tip,
        [
          tip[0] - across[0] * direction * 4,
          tip[1] - across[1] * direction * 4,
        ],
      ],
      jointColor(snapshot, index),
      3,
    );
  }
}

function drawRobot(
  ctx: CanvasRenderingContext2D,
  snapshot: FrameSnapshot,
): void {
  const pose = snapshot.chassis;
  const x = 320 + Math.tanh(pose?.x ?? 0) * 65;
  const y = 259 - Math.tanh(pose?.y ?? 0) * 25;
  const yaw = pose?.yaw ?? 0;
  ctx.fillStyle = "#101f31";
  ctx.beginPath();
  ctx.ellipse(x, y + 37, 105, 21, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ground-plane yaw affects the three steering/wheel modules independently.
  const wheels: Point[] = [];
  for (let index = 0; index < 3; index++) {
    const angle = yaw + (index * Math.PI * 2) / 3 + Math.PI / 6;
    const wheel: Point = [
      x + Math.cos(angle) * 54,
      y + 16 + Math.sin(angle) * 22,
    ];
    wheels.push(wheel);
    line(ctx, [[x, y], wheel], COLORS.body, 12);
    ctx.save();
    ctx.translate(wheel[0], wheel[1]);
    ctx.rotate(Math.sin(snapshot.joints[index * 2] + yaw) * 0.6);
    ctx.fillStyle = "#20334a";
    ctx.fillRect(-10, -13, 20, 26);
    ctx.strokeStyle = COLORS.bodyLight;
    ctx.lineWidth = 2;
    ctx.strokeRect(-10, -13, 20, 26);
    const spin = snapshot.joints[index * 2 + 1];
    line(
      ctx,
      [
        [-Math.cos(spin) * 7, -Math.sin(spin) * 9],
        [Math.cos(spin) * 7, Math.sin(spin) * 9],
      ],
      jointColor(snapshot, index * 2 + 1),
      2,
    );
    ctx.restore();
    joint(ctx, wheel, jointColor(snapshot, index * 2), 3);
  }
  line(ctx, [...wheels, wheels[0]], COLORS.body, 4);
  const hip: Point = [x, y - 8];
  const waist: Point = [x + Math.sin(snapshot.joints[6]) * 16, y - 45];
  const chest: Point = [
    waist[0] + Math.sin(snapshot.joints[7]) * 18,
    y - 99 - Math.sin(snapshot.joints[8]) * 11,
  ];
  line(ctx, [hip, waist, chest], COLORS.body, 22);
  line(ctx, [hip, waist, chest], COLORS.bodyLight, 3);
  joint(ctx, hip, jointColor(snapshot, 6), 7);
  joint(ctx, waist, jointColor(snapshot, 7), 7);
  const spread = 34 + Math.cos(yaw + snapshot.joints[9]) * 7;
  const left: Point = [
    chest[0] - spread,
    chest[1] + Math.sin(snapshot.joints[9]) * 8,
  ];
  const right: Point = [
    chest[0] + spread,
    chest[1] - Math.sin(snapshot.joints[9]) * 8,
  ];
  line(ctx, [left, right], COLORS.body, 25);
  line(ctx, [left, right], COLORS.bodyLight, 3);
  joint(ctx, chest, jointColor(snapshot, 8), 7);
  joint(ctx, [chest[0], chest[1] - 19], jointColor(snapshot, 9), 4);
  ctx.fillStyle = COLORS.body;
  ctx.fillRect(chest[0] - 18, chest[1] - 45, 36, 23);
  ctx.fillStyle = COLORS.cyan;
  ctx.fillRect(chest[0] - 12, chest[1] - 38, 24, 4);
  drawArm(ctx, snapshot, left, -1);
  drawArm(ctx, snapshot, right, 1);

  // A world-axis inset makes the chassis yaw readable without implying USD geometry.
  line(
    ctx,
    [
      [32, 301],
      [77, 301],
    ],
    COLORS.muted,
  );
  line(
    ctx,
    [
      [32, 301],
      [32, 264],
    ],
    COLORS.muted,
  );
  label(ctx, "x", 81, 305, COLORS.muted, 10);
  label(ctx, "y", 29, 258, COLORS.muted, 10);
  if (pose) {
    const direction: Point = [
      49 + Math.cos(yaw) * 24,
      285 - Math.sin(yaw) * 24,
    ];
    line(ctx, [[49, 285], direction], COLORS.cyan, 3);
    joint(ctx, direction, COLORS.cyan, 2);
  }
}

function drawSource(
  ctx: CanvasRenderingContext2D,
  snapshot: FrameSnapshot,
): void {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  for (let x = 0; x <= SOURCE_WIDTH; x += 32)
    line(
      ctx,
      [
        [x, 64],
        [x, SOURCE_HEIGHT],
      ],
      COLORS.grid,
    );
  for (let y = 64; y <= SOURCE_HEIGHT; y += 32)
    line(
      ctx,
      [
        [0, y],
        [SOURCE_WIDTH, y],
      ],
      COLORS.grid,
    );
  label(ctx, "MOCK / SCHEMATIC ROBOT", 16, 51, COLORS.cyan, 12);
  label(
    ctx,
    `CAPTURE ${snapshot.capture_id}`,
    624,
    51,
    COLORS.muted,
    11,
    "right",
  );
  drawRobot(ctx, snapshot);
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 326, SOURCE_WIDTH, 34);
  label(
    ctx,
    `LOG ${snapshot.log_time_s.toFixed(3)} s`,
    16,
    340,
    COLORS.text,
    11,
  );
  label(
    ctx,
    "Synthetic fixture / no USD model",
    624,
    340,
    COLORS.muted,
    10,
    "right",
  );
  const pose = snapshot.chassis;
  label(
    ctx,
    pose
      ? `WORLD  x ${pose.x.toFixed(3)} m  y ${pose.y.toFixed(3)} m  yaw ${pose.yaw.toFixed(3)} rad`
      : "WORLD  chassis unavailable",
    16,
    354,
    COLORS.muted,
    10,
  );

  // Opaque blocks are larger than the exact sample pixels, keeping the stamp visible.
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, SOURCE_WIDTH, 35);
  const bits = stampBits(snapshot.capture_id);
  MARKER_PIXELS.forEach(([x, y], index) => {
    ctx.fillStyle = bits[index] ? "#32d4ac" : "#ec6f79";
    ctx.fillRect(x - 5, y - 4, 10, 8);
  });
}

/** Render one immutable mock pose, then decode identity from the actual bitmap pixels. */
export async function makeMockFrame(
  snapshot: FrameSnapshot,
): Promise<DecodedFrame> {
  const data = immutableSnapshot(snapshot);
  const canvas = surface();
  drawSource(context2d(canvas), data);
  const bitmap = await createImageBitmap(canvas);
  try {
    if (bitmap.width !== SOURCE_WIDTH || bitmap.height !== SOURCE_HEIGHT)
      throw new Error("Unexpected mock bitmap dimensions");
    // Never decode the drawing canvas: independently read the bitmap being delivered.
    const readback = surface();
    const context = context2d(readback, true);
    context.drawImage(bitmap, 0, 0);
    const captureId = decodeStamp(
      MARKER_PIXELS.map(([x, y]) => context.getImageData(x, y, 1, 1).data),
    );
    if (captureId !== data.capture_id)
      throw new Error("Decoded mock frame does not match its snapshot");
    let closed = false;
    return Object.freeze({
      sessionId: data.session_id,
      captureId,
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close(): void {
        if (!closed) {
          closed = true;
          bitmap.close();
        }
      },
    });
  } catch (error) {
    bitmap.close();
    throw error;
  }
}

function preparePresentation(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  // Resizing resets transforms, clipping, and composite state from previous callers.
  canvas.width = PRESENTATION_WIDTH;
  canvas.height = PRESENTATION_HEIGHT;
  const ctx = context2d(canvas);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, PRESENTATION_WIDTH, PRESENTATION_HEIGHT);
  return ctx;
}

function compactName(name: string): string {
  return name
    .replace("left_gripper_finger_joint", "L grip ")
    .replace("right_gripper_finger_joint", "R grip ")
    .replace("left_arm_joint", "L arm ")
    .replace("right_arm_joint", "R arm ")
    .replace("steer_motor_joint", "steer ")
    .replace("wheel_motor_joint", "wheel ")
    .replace("torso_joint", "torso ");
}

function qualityLabel(quality: ChannelQuality): string {
  if (quality.origin === "missing") return "missing";
  if (!quality.valid) return "invalid";
  if (quality.origin === "derived" || quality.processing?.includes("derived"))
    return "推算";
  return quality.origin === "commanded" ? "cmd." : "meas.";
}

function drawJointPanel(
  ctx: CanvasRenderingContext2D,
  snapshot: FrameSnapshot,
  metadata: JointMetadata | null,
): void {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(936, 70, 324, 584);
  label(ctx, "APPLIED JOINTS / 28", 948, 93, COLORS.text, 15);
  label(ctx, "joint", 948, 116, COLORS.muted);
  label(ctx, "value", 1093, 116, COLORS.muted, 14, "right");
  label(ctx, "unit", 1101, 116, COLORS.muted);
  label(ctx, "quality", 1140, 116, COLORS.muted);
  label(ctx, "limit", 1252, 116, COLORS.muted, 14, "right");
  snapshot.joints.forEach((value, index) => {
    const descriptor = metadata?.joints?.[index];
    const name =
      descriptor?.name ??
      metadata?.canonical_order?.[index] ??
      canonicalMetadata.canonical_order[index];
    const unit = descriptor?.unit ?? canonicalMetadata.joints[index].unit;
    const quality = snapshot.quality[index];
    const missing = !quality.valid || quality.origin === "missing";
    const color = missing ? COLORS.missing : COLORS.text;
    const y = 137 + index * 17.5;
    if (index % 2 === 0) {
      ctx.fillStyle = "#0f1c2c";
      ctx.fillRect(942, y - 13, 312, 17.5);
    }
    const continuous =
      (descriptor?.type ?? canonicalMetadata.joints[index].type) ===
      "continuous";
    const flags =
      snapshot.limit_flags & (1 << index)
        ? "LIMIT"
        : snapshot.limit_warn_flags & (1 << index)
          ? "WARN"
          : continuous
            ? "FREE"
            : "—";
    label(ctx, compactName(name), 948, y, color, 14);
    const formatted =
      Math.abs(value) >= 10000 ? value.toExponential(1) : value.toFixed(3);
    label(ctx, formatted, 1093, y, color, 14, "right");
    label(ctx, unit, 1101, y, color, 14);
    // Sans-serif keeps full missing/derived labels legible within the narrow column.
    ctx.font = "14px sans-serif";
    ctx.fillStyle = missing
      ? COLORS.missing
      : qualityLabel(quality) === "推算"
        ? COLORS.cyan
        : COLORS.muted;
    ctx.textAlign = "left";
    ctx.fillText(qualityLabel(quality), 1140, y);
    label(
      ctx,
      flags,
      1252,
      y,
      missing
        ? COLORS.missing
        : flags === "LIMIT"
          ? COLORS.danger
          : flags === "WARN"
            ? COLORS.warning
            : COLORS.muted,
      14,
      "right",
    );
  });
  label(ctx, "LIMIT exceeded · WARN near bound", 948, 640, COLORS.muted, 14);
}

/** Paint an image and every visible reading from the same verified, frozen snapshot. */
export function drawPresentation(
  canvas: HTMLCanvasElement,
  frame: DecodedFrame,
  snapshot: FrameSnapshot,
  jointMeta: JointMetadata | null,
): void {
  const data = immutableSnapshot(snapshot);
  if (
    frame.sessionId !== data.session_id ||
    frame.captureId !== data.capture_id
  ) {
    throw new Error(
      "Presentation requires a frame and snapshot with the same identity",
    );
  }
  const ctx = preparePresentation(canvas);
  label(ctx, "MOCK ROBOT REPLAY", 20, 32, COLORS.text, 20);
  label(ctx, "Schematic fixture / no USD model", 20, 54, COLORS.muted, 14);
  label(
    ctx,
    `CAPTURE ${data.capture_id}  /  EPOCH ${data.playback_epoch}  /  CONTROL ${data.control_seq}`,
    1260,
    32,
    COLORS.cyan,
    14,
    "right",
  );
  const rect = PRESENTATION_IMAGE_RECT;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frame.image, rect.x, rect.y, rect.width, rect.height);
  drawJointPanel(ctx, data, jointMeta);
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(20, 592, 900, 74);
  label(
    ctx,
    `LOG TIME  ${data.log_time_s.toFixed(3)} / ${data.duration_s.toFixed(3)} s`,
    20,
    612,
    COLORS.text,
    15,
  );
  label(
    ctx,
    `${(data.progress * 100).toFixed(1)}% / ${data.state} / ${data.speed}x`,
    920,
    612,
    COLORS.cyan,
    15,
    "right",
  );
  const pose = data.chassis;
  label(
    ctx,
    pose
      ? `CHASSIS  x ${pose.x.toFixed(3)} m   y ${pose.y.toFixed(3)} m   yaw ${pose.yaw.toFixed(3)} rad`
      : "CHASSIS  unavailable",
    20,
    637,
    pose ? COLORS.text : COLORS.missing,
    15,
  );
  label(
    ctx,
    `Wheel source rad: ${[1, 3, 5].map((index) => data.source_joints[index].toFixed(3)).join(" / ")} (unwrapped)`,
    20,
    660,
    COLORS.muted,
    14,
  );
  ctx.fillStyle = COLORS.edge;
  ctx.fillRect(20, 674, 900, 10);
  ctx.fillStyle = COLORS.cyan;
  ctx.fillRect(20, 674, 900 * data.progress, 10);
  label(
    ctx,
    "Image, joints, quality, limits and time share this capture.",
    20,
    707,
    COLORS.muted,
    14,
  );
  label(ctx, "Gray: missing / invalid", 948, 680, COLORS.missing, 14);
  label(ctx, "Cyan: 推算 / derived", 948, 704, COLORS.cyan, 14);
}

/** Clear stale readings while no complete image/snapshot pair is available. */
export function drawEmptyPresentation(
  canvas: HTMLCanvasElement,
  message = "Waiting for a synchronized frame",
): void {
  const ctx = preparePresentation(canvas);
  label(ctx, "ROBOT REPLAY", 20, 32, COLORS.text, 20);
  ctx.fillStyle = COLORS.panel;
  const rect = PRESENTATION_IMAGE_RECT;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillRect(936, 70, 324, 584);
  label(
    ctx,
    message,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    COLORS.muted,
    15,
    "center",
  );
  label(ctx, "APPLIED JOINTS / 28", 948, 93, COLORS.text, 15);
  label(ctx, "No paired snapshot", 948, 124, COLORS.muted, 14);
  label(ctx, "LOG TIME  —", 20, 612, COLORS.muted, 15);
  label(ctx, "CHASSIS  unavailable", 20, 637, COLORS.muted, 15);
  ctx.fillStyle = COLORS.edge;
  ctx.fillRect(20, 674, 900, 10);
}
