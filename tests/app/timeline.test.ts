import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeekScheduler } from "../../src/app/timeline";

afterEach(() => vi.useRealTimers());

describe("timeline seeks", () => {
  it("sends only the latest preview after 100 ms without dragging activity", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
    });
    scheduler.request(1);
    vi.advanceTimersByTime(60);
    scheduler.request(2);
    vi.advanceTimersByTime(99);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([2]);
    scheduler.dispose();
  });

  it("flushes immediately and deduplicates change plus pointerup for the same target", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
    });
    scheduler.request(4.25);
    scheduler.flush(4.25);
    scheduler.flush(4.25);
    vi.runAllTimers();
    expect(sent).toEqual([4.25]);
    scheduler.dispose();
  });

  it("keeps only the newest final target while a previous request is in flight", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    let release!: () => void;
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
      return sent.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    });
    scheduler.flush(1);
    scheduler.flush(2);
    scheduler.flush(3);
    expect(sent).toEqual([1]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1, 3]);
    scheduler.dispose();
  });

  it("does not send a newer preview early just because the previous request finished", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    let release!: () => void;
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
      return sent.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    });
    scheduler.flush(1);
    scheduler.request(2);
    expect(sent).toEqual([1]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 2]);
    scheduler.dispose();
  });

  it("cancels queued targets on context change and permits the same target in the next context", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    let release!: () => void;
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
      return sent.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined;
    });
    scheduler.flush(1);
    scheduler.flush(2);
    scheduler.cancel();
    scheduler.flush(1);
    expect(sent).toEqual([1, 1]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    vi.runAllTimers();
    expect(sent).toEqual([1, 1]);
    scheduler.dispose();
  });

  it("disposal prevents a delayed request and ignores subsequent events", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
    });
    scheduler.request(5);
    scheduler.dispose();
    scheduler.flush(6);
    scheduler.request(7);
    vi.runAllTimers();
    expect(sent).toEqual([]);
  });

  it("ignores invalid targets without replacing a valid pending target", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const scheduler = createSeekScheduler((time) => {
      sent.push(time);
    });
    scheduler.request(4);
    scheduler.request(Number.NaN);
    scheduler.request(Number.POSITIVE_INFINITY);
    scheduler.request(-1);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([4]);
    scheduler.dispose();
  });

  it("allows an explicit retry after an unsuccessful request", async () => {
    const sent: number[] = [],
      errors: unknown[] = [];
    const scheduler = createSeekScheduler(
      (time) => {
        sent.push(time);
        return sent.length === 1
          ? Promise.reject(new Error("offline"))
          : undefined;
      },
      { onError: (error) => errors.push(error) },
    );
    scheduler.flush(2);
    await Promise.resolve();
    await Promise.resolve();
    scheduler.flush(2);
    expect(sent).toEqual([2, 2]);
    expect(errors).toHaveLength(1);
    scheduler.dispose();
  });

  it("allows a controller to seek to the same target again after playback advances", async () => {
    const sent: number[] = [];
    const scheduler = createSeekScheduler(
      async (time) => {
        sent.push(time);
      },
      { deduplicate: false },
    );
    scheduler.flush(5);
    await Promise.resolve();
    scheduler.flush(5);
    expect(sent).toEqual([5, 5]);
    scheduler.dispose();
  });
});
