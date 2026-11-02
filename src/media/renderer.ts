import type { FrameSnapshot, JointMetadata } from "../domain/types";
import { validateFrameSnapshot } from "../api/validation";
import { chassisPanelAxes, jointPanelGroups, positionLimitEligible } from "./panelModel";
import {
  decodeStamp,
  MARKER_PIXELS,
  SOURCE_HEIGHT,
  SOURCE_WIDTH,
  stampBits,
} from "./stamp";
import type { DecodedFrame } from "./types";

/** Fixed presentation geometry, shared with independent screenshot decoders. */
export const PRESENTATION_WIDTH = 1600;
export const PRESENTATION_HEIGHT = 800;
export const CANVAS_WIDTH = PRESENTATION_WIDTH;
export const CANVAS_HEIGHT = PRESENTATION_HEIGHT;
export const PRESENTATION_IMAGE_RECT = Object.freeze({ x: 16, y: 48, width: 768, height: 432 });
export const PRESENTATION_HISTORY_RECT = Object.freeze({ x: 16, y: 568, width: 1568, height: 216 });
export const PRESENTATION_GROUP_RECTS = Object.freeze({
  left: Object.freeze({ x: 800, y: 48, width: 384, height: 264 }),
  right: Object.freeze({ x: 1192, y: 48, width: 392, height: 264 }),
  torso: Object.freeze({ x: 800, y: 320, width: 384, height: 232 }),
  base: Object.freeze({ x: 1192, y: 320, width: 392, height: 232 }),
});

export interface PresentationOptions {
  realMedia?: boolean;
  collapsedGroups?: readonly string[];
  historyCanvas?: HTMLCanvasElement | null;
  historyLogId?: string | null;
  historyRange?: { from: number; to: number };
}

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
    !positionLimitEligible(snapshot.quality[index])
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
  ctx.fillStyle = "#f3f6fa";
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

const LIGHT = Object.freeze({ panel: "#ffffff", edge: "#dee6ef", text: "#18304e", muted: "#60748c", missing: "#75859a", blue: "#356fad", warning: "#a66000", danger: "#b52e3b" });

function drawJointPanel(ctx: CanvasRenderingContext2D, snapshot: FrameSnapshot, metadata: JointMetadata | null, collapsedGroups: readonly string[] = []): void {
  for (const group of jointPanelGroups(snapshot, metadata, collapsedGroups)) {
    const rect = PRESENTATION_GROUP_RECTS[group.id as keyof typeof PRESENTATION_GROUP_RECTS];
    ctx.fillStyle = LIGHT.panel; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = LIGHT.edge; ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    label(ctx, `${group.collapsed ? "▸" : "▾"} ${group.label} · ${group.count}`, rect.x + 12, rect.y + 23, LIGHT.text, 17);
    if (group.collapsed) continue;
    label(ctx, "关节", rect.x + 12, rect.y + 46, LIGHT.muted, 14);
    label(ctx, "数值", rect.x + 177, rect.y + 46, LIGHT.muted, 14, "right");
    label(ctx, "单位", rect.x + 184, rect.y + 46, LIGHT.muted, 14);
    label(ctx, "来源", rect.x + 237, rect.y + 46, LIGHT.muted, 14);
    label(ctx, "限位", rect.x + rect.width - 10, rect.y + 46, LIGHT.muted, 14, "right");
    for (const [offset, row] of group.rows.entries()) {
      const y = rect.y + 67 + offset * 21;
      if (offset % 2 === 0) { ctx.fillStyle = "#f5f8fc"; ctx.fillRect(rect.x + 1, y - 16, rect.width - 2, 21); }
      const color = row.available ? LIGHT.text : LIGHT.missing;
      const limitColor = row.limitState === "exceeded" ? LIGHT.danger : row.limitState === "warning" ? LIGHT.warning : color;
      label(ctx, compactName(row.name), rect.x + 12, y, color, 16);
      label(ctx, row.valueText, rect.x + 177, y, color, 16, "right");
      label(ctx, row.unit, rect.x + 184, y, color, 16);
      ctx.font = "16px sans-serif"; ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(row.quality.text, rect.x + 237, y, 78);
      const flags = row.limitState === "exceeded" ? "越限" : row.limitState === "warning" ? "临界" : row.limitState === "unlimited" ? "∞" : row.limitState === "normal" ? "正常" : row.limitState === "unassessed" ? "未评估" : row.limitState === "unknown" ? "未知" : "—";
      label(ctx, flags, rect.x + rect.width - 10, y, limitColor, 16, "right");
    }
  }
}

function drawHistory(ctx: CanvasRenderingContext2D, snapshot: FrameSnapshot, options: PresentationOptions): void {
  const rect = PRESENTATION_HISTORY_RECT;
  ctx.fillStyle = LIGHT.panel; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  const range = options.historyRange;
  const matches = options.historyCanvas && options.historyLogId === snapshot.log_id && range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from;
  if (!matches) { label(ctx, "历史曲线 · 等待当前日志数据", rect.x + rect.width / 2, rect.y + rect.height / 2, LIGHT.muted, 16, "center"); return; }
  ctx.imageSmoothingEnabled = true; ctx.drawImage(options.historyCanvas!, rect.x, rect.y, rect.width, rect.height);
  if (snapshot.log_time_s >= range.from && snapshot.log_time_s <= range.to) {
    const cursor = rect.x + 60 + ((snapshot.log_time_s - range.from) / (range.to - range.from)) * 1488;
    line(ctx, [[cursor, rect.y + 40], [cursor, rect.y + 186]], LIGHT.blue, 2);
    label(ctx, `${snapshot.log_time_s.toFixed(3)} s`, Math.max(110, Math.min(1510, cursor)), rect.y + 210, LIGHT.blue, 14, "center");
  } else label(ctx, "当前帧位于所选曲线范围外", 800, rect.y + 210, LIGHT.muted, 14, "center");
}

/** Paint an image and every visible reading from the same verified, frozen snapshot. */
export function drawPresentation(canvas: HTMLCanvasElement, frame: DecodedFrame, snapshot: FrameSnapshot, jointMeta: JointMetadata | null, options: PresentationOptions = {}): void {
  const data = immutableSnapshot(snapshot);
  if (frame.sessionId !== data.session_id || frame.captureId !== data.capture_id) throw new Error("Presentation requires a frame and snapshot with the same identity");
  const ctx = preparePresentation(canvas);
  label(ctx, options.realMedia ? "同步回放 · 真实画面" : "同步回放 · MOCK 示意", 16, 30, LIGHT.text, 18);
  label(ctx, `CAPTURE ${data.capture_id} / EPOCH ${data.playback_epoch} / CONTROL ${data.control_seq}`, 1584, 30, LIGHT.blue, 14, "right");
  const rect = PRESENTATION_IMAGE_RECT;
  ctx.imageSmoothingEnabled = false; ctx.drawImage(frame.image, rect.x, rect.y, rect.width, rect.height);
  drawJointPanel(ctx, data, jointMeta, options.collapsedGroups);
  ctx.fillStyle = LIGHT.panel; ctx.fillRect(16, 488, 768, 42);
  label(ctx, `LOG TIME  ${data.log_time_s.toFixed(3)} / ${data.duration_s.toFixed(3)} s`, 20, 506, LIGHT.text, 15);
  label(ctx, `${(data.progress * 100).toFixed(1)}% / ${data.state} / ${data.speed}x`, 780, 506, LIGHT.blue, 15, "right");
  chassisPanelAxes(data).forEach((axis, index) => {
    ctx.font = `13px ${MONO}`; ctx.fillStyle = axis.available ? LIGHT.text : LIGHT.missing; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText(`${index === 0 ? "CHASSIS " : ""}${axis.axis} ${axis.valueText} ${axis.unit} · ${axis.qualityText}`, 20 + index * 250, 526, 245);
  });
  label(ctx, `Wheel source rad: ${[1, 3, 5].map((index) => data.source_joints[index].toFixed(3)).join(" / ")} (unwrapped)`, 390, 30, LIGHT.muted, 13);
  ctx.fillStyle = LIGHT.edge; ctx.fillRect(16, 529, 768, 1);
  ctx.fillStyle = LIGHT.blue; ctx.fillRect(16, 529, 768 * data.progress, 1);
  drawHistory(ctx, data, options);
}

/** Clear stale readings while no complete image/snapshot pair is available. */
export function drawEmptyPresentation(canvas: HTMLCanvasElement, message = "Waiting for a synchronized frame"): void {
  const ctx = preparePresentation(canvas);
  label(ctx, "同步回放", 16, 30, LIGHT.text, 18);
  const rect = PRESENTATION_IMAGE_RECT;
  ctx.fillStyle = LIGHT.panel; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  label(ctx, message, rect.x + rect.width / 2, rect.y + rect.height / 2, LIGHT.muted, 16, "center");
  for (const [id, group] of Object.entries(PRESENTATION_GROUP_RECTS)) {
    ctx.fillStyle = LIGHT.panel; ctx.fillRect(group.x, group.y, group.width, group.height);
    label(ctx, `${({ left: "左臂 / 夹爪 · 9", right: "右臂 / 夹爪 · 9", torso: "躯干 · 4", base: "底盘 · 6" } as Record<string,string>)[id]}`, group.x + 12, group.y + 23, LIGHT.text, 17);
    label(ctx, "暂无同帧数据", group.x + 12, group.y + 50, LIGHT.muted, 16);
  }
  label(ctx, "LOG TIME —    CHASSIS —", 20, 520, LIGHT.muted, 16);
  const history = PRESENTATION_HISTORY_RECT; ctx.fillStyle = LIGHT.panel; ctx.fillRect(history.x, history.y, history.width, history.height);
  label(ctx, "历史曲线 · 等待同帧数据", 800, history.y + history.height / 2, LIGHT.muted, 16, "center");
}
