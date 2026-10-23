import type {
  CurveResponse,
  FrameSnapshot,
  Schema,
  WsServerMessage,
} from "../../src/domain/types";
export const channels: Schema["ChannelDescriptor"][] = [
  "a",
  "b",
  "c",
  "d",
  "e",
].map((name, joint_index) => ({
  name,
  label: name,
  kind: "joint",
  joint_index,
  unit: joint_index === 1 ? "m" : "rad",
  source_field: null,
  quality: { origin: "derived", valid: true, method: "fixture" },
}));
export const curve = (log_id = "l"): CurveResponse => ({
  log_id,
  from_s: 0,
  to_s: 12,
  max_points: 2000,
  series: [
    {
      channel: "a",
      unit: "rad",
      points: [
        { time_s: 0, value: 1, quality: { origin: "derived", valid: true } },
        { time_s: 1, value: 0, quality: { origin: "missing", valid: false } },
        { time_s: 2, value: 2, quality: { origin: "derived", valid: true } },
      ],
      limit_intervals: [
        {
          channel: "a",
          from_s: 2,
          to_s: 3,
          severity: "warning",
          code: "JOINT_LIMIT_NEAR",
        },
        {
          channel: "a",
          from_s: 5,
          to_s: 6,
          severity: "error",
          code: "JOINT_LIMIT_EXCEEDED",
        },
      ],
    },
    {
      channel: "b",
      unit: "m",
      points: [
        { time_s: 0, value: 0.5, quality: { origin: "measured", valid: true } },
      ],
      limit_intervals: [],
    },
  ],
});
export const frame = (
  time = 1,
  epoch = 1,
  sid = "s",
  lid = "l",
): FrameSnapshot =>
  ({
    session_id: sid,
    log_id: lid,
    capture_id: epoch * 100 + Math.round(time * 10),
    render_seq: epoch * 100 + Math.round(time * 10),
    playback_epoch: epoch,
    control_seq: epoch,
    target_seq: epoch,
    log_time_s: time,
    duration_s: 12,
    progress: time / 12,
    joints: Array(28).fill(0),
    source_joints: Array(28).fill(0),
    quality: Array(28).fill({ origin: "derived", valid: true }),
    state: "paused",
    speed: 1,
    chassis: null,
    limit_flags: 0,
    limit_warn_flags: 0,
    captured_wall_s: 1,
  }) as FrameSnapshot;
export const alert = (
  time = 2,
  epoch = 1,
  id = "one",
): Extract<WsServerMessage, { type: "alert" }>["data"] => ({
  alert_id: id,
  log_id: "l",
  log_time_s: time,
  playback_epoch: epoch,
  joint_index: 0,
  severity: "warning",
  source: "mock.synthetic.v1",
  code: "JOINT_LIMIT_NEAR",
  message: "Near limit",
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
