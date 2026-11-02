import type { FrameSnapshot, ScenarioId } from "../domain/types";
import { makeMockFrame } from "./renderer";
import type { DecodedFrame, VideoSource } from "./types";

export interface MockFrameRuntime {
  subscribeFrames(
    sid: string,
    onSnapshot: (snapshot: FrameSnapshot) => void,
  ): () => void;
  getScenario(): ScenarioId;
}

export interface MockSourceDiagnostics {
  inFlight: number;
  pending: number;
  owned: number;
  dropped: number;
  generation: number;
}

export interface MockVideoSource extends VideoSource {
  diagnostics(): MockSourceDiagnostics;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Image ownership stays explicit until the consumer closes the delivered frame. */
export function createMockVideoSource(
  runtime: MockFrameRuntime,
  options: {
    makeFrame?: (snapshot: FrameSnapshot) => Promise<DecodedFrame>;
  } = {},
): MockVideoSource {
  const makeFrame = options.makeFrame ?? makeMockFrame;
  const pending = new Map<DecodedFrame, ReturnType<typeof setTimeout>>();
  const owned = new Set<DecodedFrame>();
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let sessionId: string | null = null;
  let inFlight = 0;
  let dropped = 0;

  function disconnect(): void {
    generation += 1;
    sessionId = null;
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const frame of owned) frame.close();
    owned.clear();
  }

  function own(frame: DecodedFrame): DecodedFrame {
    let closed = false;
    const managed: DecodedFrame = {
      sessionId: frame.sessionId,
      captureId: frame.captureId,
      image: frame.image,
      width: frame.width,
      height: frame.height,
      close() {
        if (closed) return;
        closed = true;
        const timer = pending.get(managed);
        if (timer !== undefined) clearTimeout(timer);
        pending.delete(managed);
        owned.delete(managed);
        frame.close();
      },
    };
    owned.add(managed);
    return managed;
  }

  return {
    capabilities: {
      kind: "mock",
      identity: "capture32_crc32",
      controllable: true,
    },
    connect(sid, onFrame, onStatus) {
      disconnect();
      sessionId = sid;
      const activeGeneration = generation;
      const current = () =>
        sessionId === sid && generation === activeGeneration;
      onStatus?.("Mock 视频源已连接：程序绘制的机器人结构示意，非 USD 模型");
      if (!current()) return;

      async function produce(
        snapshot: FrameSnapshot,
        delayed: boolean,
      ): Promise<void> {
        inFlight += 1;
        try {
          const raw = await makeFrame(snapshot);
          // Stale conversions are still counted against the global in-flight
          // bound until they settle, then their bitmap is released immediately.
          if (!current()) {
            raw.close();
            return;
          }
          const frame = own(raw);
          if (
            frame.sessionId !== sid ||
            frame.captureId !== snapshot.capture_id
          ) {
            frame.close();
            dropped += 1;
            onStatus?.("Mock 图像身份与冻结快照不一致，已丢弃");
            return;
          }
          const deliver = () => {
            pending.delete(frame);
            if (!current()) {
              frame.close();
              return;
            }
            try {
              onFrame(frame);
            } catch (error) {
              frame.close();
              dropped += 1;
              onStatus?.(
                error instanceof Error ? error.message : "Mock 视频帧呈现失败",
              );
            }
          };
          if (delayed) {
            if (pending.size >= 32) {
              const oldest = pending.keys().next().value;
              oldest?.close();
              dropped += 1;
            }
            pending.set(frame, setTimeout(deliver, 650));
          } else deliver();
        } catch (error) {
          dropped += 1;
          if (current())
            onStatus?.(
              error instanceof Error ? error.message : "Mock 视频帧转换失败",
            );
        } finally {
          inFlight -= 1;
        }
      }

      unsubscribe = runtime.subscribeFrames(sid, (snapshot) => {
        if (!current() || snapshot.session_id !== sid) return;
        if (inFlight >= 4) {
          dropped += 1;
          return;
        }
        try {
          const immutable = freeze(structuredClone(snapshot));
          void produce(immutable, runtime.getScenario() === "video-delay");
        } catch (error) {
          dropped += 1;
          onStatus?.(error instanceof Error ? error.message : "Mock 快照无效");
        }
      });
    },
    disconnect,
    diagnostics: () => ({
      inFlight,
      pending: pending.size,
      owned: owned.size,
      dropped,
      generation,
    }),
  };
}

/** Real mode deliberately has no synthetic video fallback. */
export function createUnavailableVideoSource(): VideoSource {
  return {
    capabilities: {
      kind: "unavailable",
      identity: "capture32_crc32",
      controllable: false,
    },
    connect(_sid, _onFrame, onStatus) {
      onStatus?.("真实视频尚未连接；WHEP / WebCodecs 媒体适配将在 T15 接入");
    },
    disconnect() {
      /* This adapter never acquires media resources. */
    },
  };
}
