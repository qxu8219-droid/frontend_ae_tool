import { it, expect, vi, afterEach } from "vitest";
import {
  createMockVideoSource,
  createUnavailableVideoSource,
} from "../../src/media/source";
import type { FrameSnapshot, ScenarioId } from "../../src/domain/types";
import type { DecodedFrame } from "../../src/media/types";
afterEach(() => vi.useRealTimers());
it("closes an asynchronous old-generation image instead of delivering it after disconnect", async () => {
  let listener: (s: FrameSnapshot) => void = () => {},
    resolve!: (f: DecodedFrame) => void;
  const unsubscribe = vi.fn(),
    output = vi.fn(),
    close = vi.fn();
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return unsubscribe;
      },
      getScenario: () => "normal",
    },
    { makeFrame: () => new Promise((r) => (resolve = r)) },
  );
  source.connect("s", output);
  listener({ session_id: "s" } as FrameSnapshot);
  source.disconnect();
  resolve({
    sessionId: "s",
    captureId: 1,
    image: {} as CanvasImageSource,
    width: 640,
    height: 360,
    close,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(output).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("bounds delayed image ownership and releases it on disconnect", async () => {
  vi.useFakeTimers();
  let listener: (s: FrameSnapshot) => void = () => {};
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return () => {};
      },
      getScenario: () => "video-delay" as ScenarioId,
    },
    {
      makeFrame: async (data) => {
        const close = vi.fn();
        closes.push(close);
        return {
          sessionId: "s",
          captureId: data.capture_id,
          image: {} as CanvasImageSource,
          width: 640,
          height: 360,
          close,
        };
      },
    },
  );
  const output = vi.fn();
  source.connect("s", output);
  for (let i = 1; i <= 40; i++) {
    listener({ session_id: "s", capture_id: i } as FrameSnapshot);
    await Promise.resolve();
    await Promise.resolve();
  }
  expect(source.diagnostics().pending).toBeLessThanOrEqual(32);
  source.disconnect();
  vi.runAllTimers();
  expect(output).not.toHaveBeenCalled();
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
});
it("real-mode placeholder reports unavailability without emitting synthetic frames", () => {
  const output = vi.fn(),
    status = vi.fn();
  const source = createUnavailableVideoSource();
  source.connect("s", output, status);
  expect(status).toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(source.capabilities.kind).toBe("unavailable");
  source.disconnect();
});
it("never has more than four image creations in flight and freezes the captured snapshot", async () => {
  let listener: (snapshot: FrameSnapshot) => void = () => {};
  const pending: Array<(frame: DecodedFrame) => void> = [];
  const captured: FrameSnapshot[] = [];
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return () => {};
      },
      getScenario: () => "normal",
    },
    {
      makeFrame: (snapshot) => {
        captured.push(snapshot);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  );
  const output = vi.fn();
  source.connect("s", output);
  const input = {
    session_id: "s",
    capture_id: 1,
    joints: [1],
  } as unknown as FrameSnapshot;
  listener(input);
  input.joints[0] = 99;
  for (let i = 2; i <= 10; i++)
    listener({ session_id: "s", capture_id: i } as FrameSnapshot);
  expect(source.diagnostics().inFlight).toBe(4);
  expect(captured).toHaveLength(4);
  expect(captured[0]?.joints[0]).toBe(1);
  expect(Object.isFrozen(captured[0]?.joints)).toBe(true);
  source.disconnect();
  for (const [index, resolve] of pending.entries())
    resolve({
      sessionId: "s",
      captureId: index + 1,
      image: {} as CanvasImageSource,
      width: 640,
      height: 360,
      close: vi.fn(),
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(source.diagnostics().inFlight).toBe(0);
  expect(output).not.toHaveBeenCalled();
});
it("delivers delayed frames after 650ms and transfers an idempotently released image", async () => {
  vi.useFakeTimers();
  let listener: (snapshot: FrameSnapshot) => void = () => {};
  const close = vi.fn(),
    output = vi.fn();
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return () => {};
      },
      getScenario: () => "video-delay",
    },
    {
      makeFrame: async (snapshot) => ({
        sessionId: "s",
        captureId: snapshot.capture_id,
        image: {} as CanvasImageSource,
        width: 640,
        height: 360,
        close,
      }),
    },
  );
  source.connect("s", output);
  listener({ session_id: "s", capture_id: 11 } as FrameSnapshot);
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(649);
  expect(output).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(output).toHaveBeenCalledOnce();
  expect(output.mock.calls[0]![0].captureId).toBe(11);
  expect(source.diagnostics().pending).toBe(0);
  expect(source.diagnostics().owned).toBe(1);
  const delivered = output.mock.calls[0]![0] as DecodedFrame;
  delivered.close();
  delivered.close();
  expect(source.diagnostics().owned).toBe(0);
  source.disconnect();
  expect(close).toHaveBeenCalledOnce();
});
it("discards mismatched decoded identity and reports a failed image conversion", async () => {
  let listener: (snapshot: FrameSnapshot) => void = () => {};
  const close = vi.fn(),
    output = vi.fn(),
    status = vi.fn();
  let attempts = 0;
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return () => {};
      },
      getScenario: () => "normal",
    },
    {
      makeFrame: async () => {
        if (attempts++ === 0)
          return {
            sessionId: "other",
            captureId: 1,
            image: {} as CanvasImageSource,
            width: 640,
            height: 360,
            close,
          };
        throw new Error("Decode failed");
      },
    },
  );
  source.connect("s", output, status);
  listener({ session_id: "s", capture_id: 1 } as FrameSnapshot);
  await Promise.resolve();
  await Promise.resolve();
  listener({ session_id: "s", capture_id: 2 } as FrameSnapshot);
  await Promise.resolve();
  await Promise.resolve();
  expect(output).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(
    status.mock.calls.some(([message]) =>
      String(message).includes("Decode failed"),
    ),
  ).toBe(true);
  expect(source.diagnostics().inFlight).toBe(0);
  source.disconnect();
});
it("switches sessions without delivering prior pending or asynchronous images", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, (snapshot: FrameSnapshot) => void>();
  const pending: Array<(frame: DecodedFrame) => void> = [],
    closes = [vi.fn(), vi.fn()];
  const output = vi.fn();
  const source = createMockVideoSource(
    {
      subscribeFrames: (sid, fn) => {
        listeners.set(sid, fn);
        return () => listeners.delete(sid);
      },
      getScenario: () => "video-delay",
    },
    { makeFrame: () => new Promise((resolve) => pending.push(resolve)) },
  );
  source.connect("old", output);
  listeners.get("old")!({ session_id: "old", capture_id: 1 } as FrameSnapshot);
  source.connect("new", output);
  listeners.get("new")!({ session_id: "new", capture_id: 2 } as FrameSnapshot);
  pending[0]!({
    sessionId: "old",
    captureId: 1,
    image: {} as CanvasImageSource,
    width: 640,
    height: 360,
    close: closes[0]!,
  });
  pending[1]!({
    sessionId: "new",
    captureId: 2,
    image: {} as CanvasImageSource,
    width: 640,
    height: 360,
    close: closes[1]!,
  });
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(650);
  expect(output).toHaveBeenCalledOnce();
  expect(output.mock.calls[0]![0].sessionId).toBe("new");
  expect(closes[0]).toHaveBeenCalledOnce();
  source.disconnect();
  expect(closes[1]).toHaveBeenCalledOnce();
});
it("keeps retired conversions within the four-image global bound until they finish", async () => {
  let listener: (snapshot: FrameSnapshot) => void = () => {};
  const pending: Array<(frame: DecodedFrame) => void> = [];
  const source = createMockVideoSource(
    {
      subscribeFrames: (_sid, fn) => {
        listener = fn;
        return () => {};
      },
      getScenario: () => "normal",
    },
    { makeFrame: () => new Promise((resolve) => pending.push(resolve)) },
  );
  source.connect("old", vi.fn());
  for (let i = 1; i <= 4; i++)
    listener({ session_id: "old", capture_id: i } as FrameSnapshot);
  source.connect("new", vi.fn());
  listener({ session_id: "new", capture_id: 5 } as FrameSnapshot);
  expect(pending).toHaveLength(4);
  expect(source.diagnostics().inFlight).toBe(4);
  for (const [index, resolve] of pending.entries())
    resolve({
      sessionId: "old",
      captureId: index + 1,
      image: {} as CanvasImageSource,
      width: 640,
      height: 360,
      close: vi.fn(),
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(source.diagnostics().inFlight).toBe(0);
  listener({ session_id: "new", capture_id: 6 } as FrameSnapshot);
  expect(pending).toHaveLength(5);
  source.disconnect();
  pending[4]!({
    sessionId: "new",
    captureId: 6,
    image: {} as CanvasImageSource,
    width: 640,
    height: 360,
    close: vi.fn(),
  });
  await Promise.resolve();
  await Promise.resolve();
});
