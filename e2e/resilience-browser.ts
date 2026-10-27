import type { Page, WebSocketRoute } from '@playwright/test';

export type MediaFault = 'none' | 'delay' | 'drop' | 'duplicate' | 'reorder';

/** Test-only interception of real native delivery. No synthetic pixels/poses. */
export async function installBrowserProbe(page: Page) {
  await page.addInitScript(() => {
    const host = window as any;
    const metric = () => ({ frames: 0, maxAgeMs: 0, minAgeMs: Infinity, ageSumMs: 0,
      over2s: 0, negativeAge: 0, ageHistogram10ms: Array(201).fill(0), callbackMs: 0, maxCallbackMs: 0,
      maxFrames: 0, maxSnapshots: 0, maxOwned: 0, maxInFlight: 0, maxDecoderPending: 0 });
    const probe = host.__t17 = {
      fault: 'none', injected: { delayed: 0, dropped: 0, duplicated: 0, reordered: 0 }, pending: 0, maxPending: 0,
      lifetime: metric(), window: metric(), windowStart: performance.now(),
      startWindow() { this.window = metric(); this.windowStart = performance.now(); },
      getWindow() { return { ...this.window, elapsedMs: performance.now() - this.windowStart }; },
    };
    // Measure every actual presentation, not just whichever frames polling sees.
    // Duration includes the complete synchronous presentation callback and store update.
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => {
      const before = host.__replayDiagnostics?.sync().presented ?? 0;
      const start = performance.now(); callback(time); const duration = performance.now() - start;
      const diag = host.__replayDiagnostics;
      if (!diag || diag.sync().presented === before) return;
      const frame = diag.snapshot(); if (!frame) return;
      const age = Date.now() - frame.captured_wall_s * 1000;
      const buffers = diag.sync(), media = diag.source();
      for (const item of [probe.lifetime, probe.window]) {
        item.frames++; item.maxAgeMs = Math.max(item.maxAgeMs, age); item.minAgeMs = Math.min(item.minAgeMs, age);
        item.ageSumMs += age; item.over2s += Number(age >= 2000); item.negativeAge += Number(age < -10);
        item.ageHistogram10ms[Math.min(200, Math.max(0, Math.floor(age / 10)))]++;
        item.callbackMs += duration; item.maxCallbackMs = Math.max(item.maxCallbackMs, duration);
        item.maxFrames = Math.max(item.maxFrames, buffers.frames); item.maxSnapshots = Math.max(item.maxSnapshots, buffers.snapshots);
        item.maxOwned = Math.max(item.maxOwned, media?.owned ?? 0); item.maxInFlight = Math.max(item.maxInFlight, media?.inFlight ?? 0);
        item.maxDecoderPending = Math.max(item.maxDecoderPending, media?.pending ?? 0);
      }
    });
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, { construct(Target, args) {
      const worker = new Target(...args as [string | URL, WorkerOptions?]);
      let handler: ((event: MessageEvent) => void) | null = null, sequence = 0, terminated = false;
      const pending = new Map<ReturnType<typeof setTimeout>, MessageEvent>();
      Object.defineProperty(worker, 'onmessage', { get: () => handler, set: value => { handler = value; } });
      const release = (event: MessageEvent) => { event.data.frame?.close(); worker.postMessage({ type: 'release', id: event.data.id }); };
      function delayed(event: MessageEvent, ms: number) {
        const timer = setTimeout(() => { pending.delete(timer); probe.pending--; if (!terminated) handler?.(event); }, ms);
        pending.set(timer, event); probe.pending++; probe.maxPending = Math.max(probe.maxPending, probe.pending);
      }
      worker.addEventListener('message', event => {
        if (terminated) { event.data.frame?.close(); return; }
        if (event.data.type !== 'pair') { handler?.(event); return; }
        sequence++;
        if (probe.fault === 'delay') { probe.injected.delayed++; delayed(event, 700); return; }
        if (probe.fault === 'drop' && sequence % 3 === 0) { probe.injected.dropped++; release(event); return; }
        if (probe.fault === 'reorder' && sequence % 3 === 0) { probe.injected.reordered++; delayed(event, 180); return; }
        if (probe.fault === 'duplicate' && sequence % 3 === 0) {
          probe.injected.duplicated++;
          const copy = new MessageEvent('message', { data: { ...event.data, frame: event.data.frame.clone() } });
          handler?.(event); handler?.(copy); return;
        }
        handler?.(event);
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated = true;
        for (const [timer, event] of pending) { clearTimeout(timer); event.data.frame?.close(); probe.pending--; }
        pending.clear(); terminate();
      };
      return worker;
    } });
  });
}

export async function setMediaFault(page: Page, fault: MediaFault) {
  await page.evaluate(value => { (window as any).__t17.fault = value; }, fault);
}
export async function startWindow(page: Page) {
  await page.evaluate(() => (window as any).__t17.startWindow());
}
export async function browserProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as any).__t17;
    return { window: probe.getWindow(), lifetime: probe.lifetime, injected: probe.injected,
      pending: probe.pending, maxPending: probe.maxPending, memory: (performance as any).memory
        ? { usedJSHeapSize: (performance as any).memory.usedJSHeapSize, totalJSHeapSize: (performance as any).memory.totalJSHeapSize } : null };
  });
}

/** WS ordering is preserved for delay; single message faults trigger real resync. */
export async function installWsFaults(page: Page) {
  const state = { delayMs: 0, fault: 'none', affected: 0, pending: 0, maxPending: 0 };
  const connections = new Set<WebSocketRoute>();
  await page.routeWebSocket(/\/ws\/sessions\//, socket => {
    connections.add(socket);
    const server = socket.connectToServer();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let closed = false, held: string | Buffer | undefined, due = 0;
    const send = (message: string | Buffer) => {
      if (closed) return;
      // Keep messages sent after delay disable behind the already queued backlog.
      due = Math.max(Date.now() + state.delayMs, due);
      if (due <= Date.now()) { socket.send(message); return; }
      if (state.pending >= 256) throw new Error('WS injector exceeded its 256-message bound');
      state.pending++; state.maxPending = Math.max(state.maxPending, state.pending);
      const timer = setTimeout(() => { timers.delete(timer); state.pending--; if (!closed) socket.send(message); }, due - Date.now());
      timers.add(timer);
    };
    server.onMessage(message => {
      const type = typeof message === 'string' ? JSON.parse(message).type : '';
      if (type !== 'connection_snapshot' && state.fault !== 'none') {
        const fault = state.fault; state.fault = 'none'; state.affected++;
        if (fault === 'drop') return;
        if (fault === 'duplicate') { send(message); send(message); return; }
        if (fault === 'reorder') { held = message; return; }
      }
      send(message);
      if (held !== undefined) { send(held); held = undefined; }
    });
    const clear = () => { closed = true; connections.delete(socket); for (const timer of timers) { clearTimeout(timer); state.pending--; } timers.clear(); };
    socket.onClose(() => { clear(); server.close(); });
    server.onClose(() => { clear(); socket.close(); });
  });
  return { state, close() { for (const connection of connections) connection.close({ code: 1012, reason: 'T17 owned transport interruption' }); } };
}
