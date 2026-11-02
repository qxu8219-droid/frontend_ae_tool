import { beforeEach, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useTelemetryStore } from "../../src/stores/telemetry";
import { usePlaybackStore } from "../../src/stores/playback";
import type { FrameSnapshot, PlaybackSnapshot } from "../../src/domain/types";
beforeEach(() => setActivePinia(createPinia()));
const frame = (id = 1, epoch = 1) =>
  ({
    session_id: "s",
    log_id: "l",
    capture_id: id,
    render_seq: id,
    playback_epoch: epoch,
    control_seq: epoch,
    log_time_s: 1,
    duration_s: 12,
    progress: 1 / 12,
    joints: Array(28).fill(0),
    source_joints: Array(28).fill(0),
    quality: Array(28).fill({ origin: "derived", valid: true }),
    state: "paused",
    speed: 1,
    chassis: null,
    limit_flags: 0,
    limit_warn_flags: 0,
    captured_wall_s: 1,
    target_seq: id,
  }) as unknown as FrameSnapshot;
it("server acceptance cannot advance the currently displayed state", () => {
  const telemetry = useTelemetryStore(),
    playback = usePlaybackStore();
  telemetry.context("s", 1);
  telemetry.accept(frame(), 1);
  playback.update({
    session_id: "s",
    log_id: "l",
    playback_epoch: 2,
    control_seq: 2,
    state: "paused",
    speed: 1,
    duration_s: 12,
    target_position: { log_time_s: 9, target_seq: 2 },
  } as PlaybackSnapshot);
  expect(telemetry.presented?.log_time_s).toBe(1);
  expect(playback.server?.target_position?.log_time_s).toBe(9);
});
it("rejects retired sessions, connections, controls, and capture regressions", () => {
  const telemetry = useTelemetryStore();
  telemetry.context("s", 1);
  expect(telemetry.accept(frame(4, 2), 1)).toBe(true);
  telemetry.context("s", 2);
  expect(telemetry.presented?.capture_id).toBe(4);
  expect(telemetry.accept(frame(5, 2), 1)).toBe(false);
  expect(telemetry.accept(frame(3, 2), 2)).toBe(false);
  expect(telemetry.accept(frame(5, 1), 2)).toBe(false);
  telemetry.context("new", 3);
  expect(telemetry.presented).toBeNull();
  expect(telemetry.accept(frame(8, 2), 3)).toBe(false);
});
it("does not regress server control state when a previous response arrives late", () => {
  const playback = usePlaybackStore();
  const state = {
    schema_version: 1,
    session_id: "s",
    log_id: "l",
    state: "paused",
    speed: 1,
    duration_s: 12,
  } as const;
  playback.update({ ...state, control_seq: 8, playback_epoch: 3 });
  playback.update({ ...state, control_seq: 7, playback_epoch: 2 });
  expect(playback.server?.control_seq).toBe(8);
});
