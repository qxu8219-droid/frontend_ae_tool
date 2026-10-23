export type SeekScheduler = {
  request(time: number): void;
  flush(time?: number): void;
  cancel(): void;
  dispose(): void;
};

export function createSeekScheduler(
  send: (time: number) => void | Promise<void>,
  options: {
    delayMs?: number;
    deduplicate?: boolean;
    onError?: (error: unknown) => void;
  } = {},
): SeekScheduler {
  let pending: number | undefined;
  let lastSent: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let inFlight = false;
  let generation = 0;
  let disposed = false;
  const delayMs = options.delayMs ?? 100;
  const valid = (time: number) => Number.isFinite(time) && time >= 0;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  function dispatch() {
    if (disposed || inFlight || !ready || pending === undefined) return;
    const time = pending;
    pending = undefined;
    ready = false;
    if (options.deduplicate !== false && time === lastSent) return;
    lastSent = time;
    inFlight = true;
    const token = generation;
    const complete = (failed: boolean, error?: unknown) => {
      if (disposed || token !== generation) return;
      inFlight = false;
      if (failed) {
        lastSent = undefined;
        options.onError?.(error);
      }
      dispatch();
    };
    try {
      const result = send(time);
      if (result)
        result.then(
          () => complete(false),
          (error: unknown) => complete(true, error),
        );
      else complete(false);
    } catch (error) {
      complete(true, error);
    }
  }

  function cancel() {
    generation += 1;
    clearTimer();
    pending = undefined;
    lastSent = undefined;
    ready = false;
    inFlight = false;
  }

  return {
    request(time) {
      if (disposed || !valid(time)) return;
      pending = time;
      ready = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        ready = true;
        dispatch();
      }, delayMs);
    },
    flush(time) {
      if (disposed || (time !== undefined && !valid(time))) return;
      if (time !== undefined) pending = time;
      clearTimer();
      ready = true;
      dispatch();
    },
    cancel,
    dispose() {
      cancel();
      disposed = true;
    },
  };
}
