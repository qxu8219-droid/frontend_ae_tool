import { describe, it, expect } from "vitest";
import { FrameSynchronizer } from "../../src/media/frameSync";
import type { FrameSnapshot } from "../../src/domain/types";
import type { DecodedFrame } from "../../src/media/types";

function snapshot(id: number, seq = 0, epoch = 0, sid = "s"): FrameSnapshot {
  return {
    schema_version: 1,
    session_id: sid,
    log_id: "l",
    playback_epoch: epoch,
    control_seq: seq,
    target_seq: id,
    capture_id: id,
    render_seq: id,
    state: "paused",
    speed: 1,
    log_time_s: 1,
    duration_s: 12,
    progress: 1 / 12,
    source_sample_index: 60,
    joints: Array(28).fill(0),
    source_joints: Array(28).fill(0),
    quality: Array.from({ length: 28 }, () => ({
      origin: "derived",
      valid: true,
      processing: ["derived"],
      source_indices: [],
      method: "synthetic",
    })),
    chassis: null,
    limit_flags: 0,
    limit_warn_flags: 0,
    captured_wall_s: 1,
  } as unknown as FrameSnapshot;
}
function image(id: number, sid = "s") {
  let closes = 0;
  return {
    sessionId: sid,
    captureId: id,
    image: {} as CanvasImageSource,
    width: 640,
    height: 360,
    close() {
      closes++;
    },
    get closes() {
      return closes;
    },
  } satisfies DecodedFrame & { closes: number };
}
function setup(capacity = 3) {
  const tasks: Array<() => void> = [],
    shown: FrameSnapshot[] = [];
  const sync = new FrameSynchronizer({
    capacity,
    onPresent: (_image, data) => {
      shown.push(data);
    },
    schedule: (fn) => {
      tasks.push(fn);
      return tasks.length;
    },
    cancel: () => {},
  });
  sync.reset("s", 1);
  return {
    sync,
    shown,
    flush: () => {
      while (tasks.length) tasks.shift()!();
    },
  };
}
describe("same-frame presentation gate", () => {
  it("holds each side until its exact image identity arrives", () => {
    const { sync, shown, flush } = setup();
    const first = image(1),
      second = image(2);
    sync.addSnapshot(snapshot(2));
    sync.addFrame(first);
    flush();
    expect(shown).toHaveLength(0);
    sync.addFrame(second);
    flush();
    expect(shown.map((s) => s.capture_id)).toEqual([2]);
    expect(first.closes).toBe(1);
    expect(second.closes).toBe(1);
    sync.addSnapshot(snapshot(1));
    flush();
    expect(shown).toHaveLength(1);
  });
  it("enforces accepted-control and epoch barriers while preserving shown state", () => {
    const { sync, shown, flush } = setup();
    sync.addFrame(image(1));
    sync.addSnapshot(snapshot(1));
    flush();
    sync.setBarrier(5, 2, "l");
    const stale = image(2);
    sync.addFrame(stale);
    sync.addSnapshot(snapshot(2, 4, 1));
    flush();
    expect(shown.map((x) => x.capture_id)).toEqual([1]);
    sync.addFrame(image(3));
    sync.addSnapshot(snapshot(3, 5, 2));
    flush();
    expect(shown.map((x) => x.capture_id)).toEqual([1, 3]);
    sync.dispose();
    expect(stale.closes).toBe(1);
  });
  it("cleans pending resources and callbacks on session switch", () => {
    const { sync, shown, flush } = setup();
    const stale = image(1);
    sync.addFrame(stale);
    sync.addSnapshot(snapshot(1));
    sync.reset("new", 2);
    flush();
    expect(shown).toHaveLength(0);
    expect(stale.closes).toBe(1);
    const wrong = image(2);
    sync.addFrame(wrong);
    expect(wrong.closes).toBe(1);
    sync.addFrame(image(1, "new"));
    sync.addSnapshot(snapshot(1, 0, 0, "new"));
    flush();
    expect(shown[0].session_id).toBe("new");
  });
  it("preserves the session capture floor across a transport reconnect", () => {
    const { sync, shown, flush } = setup();
    sync.addFrame(image(11));
    sync.addSnapshot(snapshot(11));
    flush();
    sync.reset("s", 2);
    expect(sync.diagnostics().lastCapture).toBe(11);
    const stale = image(10);
    sync.addFrame(stale);
    sync.addSnapshot(snapshot(10));
    flush();
    expect(stale.closes).toBe(1);
    expect(shown).toHaveLength(1);
    sync.addFrame(image(12));
    sync.addSnapshot(snapshot(12));
    flush();
    expect(shown.at(-1)?.capture_id).toBe(12);
  });
  it("bounds orphan caches, closes duplicates and freezes the selected snapshot", () => {
    const { sync, shown, flush } = setup(2);
    const frames = [image(1), image(2), image(3)];
    frames.forEach((f) => sync.addFrame(f));
    expect(frames[0].closes).toBe(1);
    expect(sync.diagnostics().frames).toBe(2);
    const replacement = image(3);
    sync.addFrame(replacement);
    expect(frames[2].closes).toBe(1);
    const data = snapshot(3);
    sync.addSnapshot(data);
    data.joints[0] = 9;
    flush();
    expect(shown[0].joints[0]).toBe(0);
    expect(Object.isFrozen(shown[0].joints)).toBe(true);
    expect(replacement.closes).toBe(1);
    sync.dispose();
    expect(sync.diagnostics().frames).toBe(0);
  });
});
