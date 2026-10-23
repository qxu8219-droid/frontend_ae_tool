import type { FrameSnapshot } from "../domain/types";
import type { DecodedFrame } from "./types";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export class FrameSynchronizer {
  private sessionId = "";
  private generation = 0;
  private lifecycle = 0;
  private control = 0;
  private epoch = 0;
  private logId: string | null = null;
  private lastCapture = 0;
  private frames = new Map<number, DecodedFrame>();
  private snapshots = new Map<number, FrameSnapshot>();
  private pending: number | null = null;
  private presented = 0;
  private dropped = 0;
  private readonly capacity: number;
  private readonly schedule: (callback: () => void) => number;
  private readonly cancel: (handle: number) => void;
  constructor(
    private options: {
      onPresent: (image: DecodedFrame, data: FrameSnapshot) => void | boolean;
      capacity?: number;
      schedule?: (callback: () => void) => number;
      cancel?: (handle: number) => void;
    },
  ) {
    this.capacity = options.capacity ?? 48;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 128
    )
      throw new Error("Invalid pair cache capacity");
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  }
  reset(sessionId: string, generation: number) {
    const sameSession = sessionId === this.sessionId;
    this.clear();
    this.sessionId = sessionId;
    this.generation = generation;
    // Capture IDs and control barriers belong to the producer session, not a
    // WebSocket connection. Reconnect may retain the last visible good pair.
    if (!sameSession) {
      this.control = 0;
      this.epoch = 0;
      this.logId = null;
      this.lastCapture = 0;
    }
  }
  private clear() {
    this.lifecycle++;
    if (this.pending !== null) this.cancel(this.pending);
    this.pending = null;
    for (const frame of this.frames.values()) frame.close();
    this.frames.clear();
    this.snapshots.clear();
  }
  setBarrier(controlSeq: number, epoch?: number, logId?: string) {
    this.control = Math.max(this.control, controlSeq);
    if (epoch !== undefined) this.epoch = Math.max(this.epoch, epoch);
    if (logId !== undefined) this.logId = logId;
    for (const [id, snapshot] of this.snapshots)
      if (!this.allowed(snapshot)) {
        this.snapshots.delete(id);
        this.frames.get(id)?.close();
        this.frames.delete(id);
        this.dropped++;
      }
  }
  private allowed(data: FrameSnapshot) {
    return (
      data.session_id === this.sessionId &&
      data.capture_id > this.lastCapture &&
      data.control_seq >= this.control &&
      data.playback_epoch >= this.epoch &&
      (this.logId === null || data.log_id === this.logId)
    );
  }
  addSnapshot(data: FrameSnapshot) {
    if (!this.allowed(data)) {
      this.dropped++;
      return;
    }
    this.snapshots.set(data.capture_id, freeze(structuredClone(data)));
    while (this.snapshots.size > this.capacity) {
      this.snapshots.delete(this.snapshots.keys().next().value!);
      this.dropped++;
    }
    this.queue();
  }
  addFrame(frame: DecodedFrame) {
    if (
      frame.sessionId !== this.sessionId ||
      frame.captureId <= this.lastCapture
    ) {
      frame.close();
      this.dropped++;
      return;
    }
    const old = this.frames.get(frame.captureId);
    if (old === frame) return;
    old?.close();
    this.frames.set(frame.captureId, frame);
    while (this.frames.size > this.capacity) {
      const id = this.frames.keys().next().value!;
      this.frames.get(id)!.close();
      this.frames.delete(id);
      this.dropped++;
    }
    this.queue();
  }
  private queue() {
    if (this.pending !== null) return;
    const lifecycle = this.lifecycle;
    this.pending = this.schedule(() => {
      if (lifecycle !== this.lifecycle) return;
      this.pending = null;
      const id = [...this.frames.keys()]
        .filter((key) => this.snapshots.has(key))
        .sort((a, b) => b - a)[0];
      if (id === undefined) return;
      const frame = this.frames.get(id)!,
        snapshot = this.snapshots.get(id)!;
      this.frames.delete(id);
      this.snapshots.delete(id);
      try {
        if (this.allowed(snapshot)) {
          if (this.options.onPresent(frame, snapshot) !== false) {
            this.lastCapture = id;
            this.epoch = snapshot.playback_epoch;
            this.presented++;
          } else this.dropped++;
        } else this.dropped++;
      } finally {
        frame.close();
      }
      for (const [key, value] of this.frames)
        if (key <= this.lastCapture) {
          value.close();
          this.frames.delete(key);
        }
      for (const key of this.snapshots.keys())
        if (key <= this.lastCapture) this.snapshots.delete(key);
    });
  }
  diagnostics() {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      frames: this.frames.size,
      snapshots: this.snapshots.size,
      capacity: this.capacity,
      presented: this.presented,
      dropped: this.dropped,
      lastCapture: this.lastCapture,
    };
  }
  dispose() {
    this.clear();
    this.sessionId = "";
  }
}
