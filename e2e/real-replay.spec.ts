import { test, expect, type WebSocketRoute } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readPair, diagnostics, type PairSample } from './oracle';

test('real SDK workbench presents verified frames through controls, transport loss and worker reload', async ({ page, context, request }) => {
  const output = process.env.REAL_OUTPUT_DIR!, api = process.env.REAL_API_URL!;
  const sourcePath = path.join(output, 'synthetic.csv');
  const source = (await readFile(sourcePath, 'utf8')).trim().split(/\r?\n/).slice(1).map(row => row.split(',').map(Number));
  const report: Record<string, any> = { scope: 'Real configured UI / HTTP / WS / WHEP / SDK6.2; synthetic commands only', samples: [], errors: [], workerPids: [] };
  let route: WebSocketRoute | undefined;
  // Fault injection delays native worker delivery only; it never changes image,
  // catalog, decoder or frame identity. No test controls enter production code.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    (window as any).__t15DeliveryDelayMs = 0;
    window.Worker = new Proxy(NativeWorker, { construct(Target, args) {
      const worker = new Target(...args as [string | URL, WorkerOptions?]);
      const pending = new Map<ReturnType<typeof setTimeout>, MessageEvent>();
      let handler: ((event: MessageEvent) => void) | null = null;
      Object.defineProperty(worker, 'onmessage', { get: () => handler, set: value => { handler = value; } });
      worker.addEventListener('message', event => {
        const delay = (window as any).__t15DeliveryDelayMs;
        if (event.data.type === 'pair' && delay > 0) {
          const timer = setTimeout(() => { pending.delete(timer); handler?.(event); }, delay);
          pending.set(timer, event);
        } else handler?.(event);
      });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        for (const [timer, event] of pending) { clearTimeout(timer); event.data.frame?.close(); }
        pending.clear(); terminate();
      };
      return worker;
    } });
  });
  await page.routeWebSocket(/\/ws\/sessions\//, socket => { route = socket; socket.connectToServer(); });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  page.on('pageerror', error => report.errors.push(error.message));
  let layout: { sourceWidth: number; sourceHeight: number; markerPixels: number[][] };
  let sid = '';
  // Numeric checks run for every sampled frame. Plain assertions preserve the
  // oracle without recording thousands of Playwright steps during measurement.
  const check = (sample: PairSample) => {
    const frame = sample.snapshot, t = frame.log_time_s;
    assert.equal(sample.stamp.confident, true); assert.equal(sample.stamp.crc, sample.stamp.expectedCrc);
    assert.equal(sample.stamp.id, frame.capture_id); assert.equal(sample.sync.lastCapture, frame.capture_id);
    assert.equal(frame.session_id, sid); assert.ok(Math.abs(frame.progress - t / 12) < 0.5e-10);
    assert.deepEqual(sample.visibleText, { time: 0, source: 0, joints: [0, 0, 0, 0, 0, 0] });
    assert.equal(sample.visibleChassis, 0); assert.deepEqual(sample.progressPixels, { filled: true, empty: true });
    const right = Math.min(source.length - 1, Math.floor(t * 20) + 1), left = Math.max(0, right - 1);
    const weight = (t - source[left][0]) / (source[right][0] - source[left][0]);
    const expected = source[left].map((a, index) => a + (source[right][index] - a) * weight);
    frame.source_joints.forEach((value, index) => {
      assert.ok(Math.abs(value - expected[index + 1]) < 0.5e-8, `source joint ${index}`);
      let difference = frame.joints[index] - value;
      if ([1, 3, 5].includes(index)) difference = Math.atan2(Math.sin(difference), Math.cos(difference));
      assert.ok(Math.abs(difference) < 1e-5, `readback joint ${index}`);
      assert.equal(frame.quality[index].origin, 'commanded');
    });
    for (const [index, key] of ['x', 'y', 'yaw'].entries()) assert.ok(Math.abs(frame.chassis![key as 'x' | 'y' | 'yaw'] - expected[29 + index]) < 0.5e-5, `chassis ${key}`);
    const bounded = (value: number, maximum: number) => assert.ok(Number.isFinite(value) && value <= maximum);
    bounded(sample.sync.frames, 48); bounded(sample.sync.snapshots, 48);
    bounded(sample.source?.owned ?? 0, 4); bounded(sample.source?.inFlight ?? 0, 4);
  };
  async function wait(label: string, condition: (sample: PairSample) => boolean = () => true) {
    let found: PairSample | null = null;
    await expect.poll(async () => {
      const sample = await readPair(page, layout);
      if (sample) { check(sample); if (condition(sample)) { found = sample; return true; } }
      return false;
    }, { timeout: 25000, intervals: [40, 80, 120] }).toBe(true);
    report.samples.push({ label, ...found! }); return found!;
  }
  async function createAndLoad() {
    await expect(page.getByTestId('create-session')).toBeEnabled(); await page.getByTestId('create-session').click();
    await expect(page.getByTestId('choose-file')).toBeEnabled({ timeout: 150000 });
    sid = (await diagnostics(page)).session.sid!;
    const status = await (await request.get(api + '/api/v1/sessions/' + sid)).json(); report.workerPids.push(status.worker.pid);
    const runtime = JSON.parse(await readFile(path.join(output, 'service/state', sid, 'worker/runtime.json'), 'utf8'));
    layout = { sourceWidth: 1280, sourceHeight: 720, markerPixels: runtime.marker_pixels };
    const mapping = page.getByTestId('mapping-json');
    if (!(await mapping.isVisible())) await page.getByText('解析器与映射配置').click();
    await mapping.fill(JSON.stringify({ joints: { origin: 'commanded' }, chassis: { available: true, origin: 'commanded', yaw_semantics: 'angular_unwrapped' } }));
    await page.getByTestId('file-input').setInputFiles(sourcePath);
    await expect(page.getByTestId('upload-result')).toBeVisible();
    await expect(page.getByTestId('activate-log')).toBeEnabled(); await page.getByTestId('activate-log').click();
    return wait('loaded', sample => sample.snapshot.log_time_s === 0 && sample.snapshot.state === 'ready');
  }
  async function seek(time: number) {
    await page.getByTestId('seek-input').fill(String(time)); await page.getByTestId('seek-submit').click();
    return wait('seek-' + time, sample => sample.snapshot.log_time_s === time);
  }
  try {
    await page.goto('/'); await expect(page.getByTestId('mode-badge')).toContainText('真实');
    expect(context.serviceWorkers()).toHaveLength(0);
    const first = await createAndLoad(); report.initialSid = sid!;
    await expect(page.getByTestId('history-events').locator('li[data-severity]')).not.toHaveCount(0);
    await page.getByTestId('event-view').selectOption('triggered');
    await expect(page.getByTestId('history-events').locator('li[data-severity]')).toHaveCount(0);
    await page.getByTestId('event-view').selectOption('history');
    report.staticHistoryDoesNotImplyCurrentAlert = true;
    await page.getByTestId('play').click(); await wait('playing', sample => sample.snapshot.state === 'playing' && sample.snapshot.log_time_s > .2);
    const start = await page.evaluate(() => ({ at: performance.now(), count: (window as any).__replayDiagnostics.sync().presented }));
    const ages: number[] = [], hashes = new Set<number>();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const sample = await readPair(page, layout!); if (sample) { check(sample); ages.push(sample.captureAgeMs); hashes.add(sample.robotPixelsHash); report.samples.push({ label: 'healthy', ...sample }); }
      await page.waitForTimeout(80);
    }
    const end = await page.evaluate(() => ({ at: performance.now(), count: (window as any).__replayDiagnostics.sync().presented }));
    const fps = (end.count - start.count) * 1000 / (end.at - start.at);
    report.healthy = { presentedFps: fps, maxCaptureAgeMs: Math.max(...ages), sampleCount: ages.length };
    expect(fps).toBeGreaterThanOrEqual(15); expect(Math.max(...ages)).toBeLessThan(2000); expect(hashes.size).toBeGreaterThan(1);
    await page.getByTestId('pause').click(); const paused = await wait('paused', sample => sample.snapshot.state === 'paused');
    await page.waitForTimeout(400); const held = await wait('paused-fresh-capture', sample => sample.snapshot.capture_id > paused.snapshot.capture_id);
    expect(held.snapshot.log_time_s).toBe(paused.snapshot.log_time_s);
    await seek(3); await page.getByTestId('step-forward').click(); await wait('step-forward', sample => sample.snapshot.log_time_s === 3.05);
    await page.getByTestId('step-backward').click(); await wait('step-backward', sample => sample.snapshot.log_time_s === 3);
    for (const speed of ['0.1', '10']) {
      await page.getByTestId('speed-select').selectOption(speed); await wait('speed-' + speed, sample => sample.snapshot.speed === Number(speed));
      await page.getByTestId('play').click(); await wait('moving-' + speed, sample => sample.snapshot.state === 'playing');
      await page.waitForTimeout(250); await page.getByTestId('pause').click(); await wait('paused-' + speed, sample => sample.snapshot.state === 'paused');
    }
    await page.getByTestId('speed-select').selectOption('1'); await wait('speed-one-for-delay', sample => sample.snapshot.speed === 1);
    await seek(1);
    await page.evaluate(() => { (window as any).__t15DeliveryDelayMs = 700; });
    await page.getByTestId('play').click();
    let delayedId = 0;
    for (let index = 0; index < 5; index++) {
      const sample = await wait('delayed-real-video', sample => sample.snapshot.state === 'playing' && sample.captureAgeMs >= 650 && sample.snapshot.capture_id > delayedId);
      delayedId = sample.snapshot.capture_id;
    }
    await page.getByTestId('pause').click(); await wait('delayed-pause', sample => sample.snapshot.state === 'paused');
    // Real input events: 100ms previews plus final release; request count is independently observed.
    const seeks: number[] = [];
    page.on('request', request => { if (request.url().endsWith('/playback/seek')) seeks.push(request.postDataJSON().time_s); });
    await page.getByTestId('timeline').evaluate((element: HTMLInputElement) => { element.value = '2'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(120);
    await page.getByTestId('timeline').evaluate((element: HTMLInputElement) => { element.value = '7'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(120);
    await page.getByTestId('timeline').evaluate((element: HTMLInputElement) => {
      element.value = '4'; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await wait('drag-final-four', sample => sample.snapshot.log_time_s === 4);
    expect(seeks.at(-1)).toBe(4); report.dragTargets = [...seeks];
    await page.evaluate(() => { (window as any).__t15DeliveryDelayMs = 0; });
    await wait('delay-recovered', sample => sample.snapshot.log_time_s === 4 && sample.captureAgeMs < 500);
    report.delayedPairDeliveryMs = 700;
    await expect.poll(() => page.evaluate(() => {
      const frame = (window as any).__replayDiagnostics.snapshot(); const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="paired-canvas"]')!;
      const pixel = canvas.getContext('2d')!.getImageData(Math.floor(80 + frame.log_time_s / 12 * 1160), 900, 1, 1).data;
      return Math.abs(pixel[0] - 69) < 3 && Math.abs(pixel[1] - 216) < 3 && Math.abs(pixel[2] - 232) < 3;
    })).toBe(true);
    report.historyCursorPixelsVerified = true;
    const generation = (await diagnostics(page)).session.wsGeneration;
    await route!.close({ code: 1013, reason: 'T15 transport interruption' });
    await expect.poll(async () => (await diagnostics(page)).session.wsGeneration).toBeGreaterThan(generation);
    await wait('ws-reconnected', sample => sample.session.wsState === 'open' && sample.snapshot.log_time_s === 4);
    await page.getByTestId('speed-select').selectOption('10'); await wait('speed-ten-for-end', sample => sample.snapshot.speed === 10);
    await seek(11.9); await page.getByTestId('play').click(); await wait('ended', sample => sample.snapshot.state === 'ended' && sample.snapshot.log_time_s === 12);
    await page.getByTestId('play').click(); await wait('replayed-from-start', sample => sample.snapshot.state === 'playing' && sample.snapshot.log_time_s < 6);
    await page.getByTestId('stop').click(); await wait('stopped', sample => sample.snapshot.state === 'ready' && sample.snapshot.log_time_s === 0);
    await page.screenshot({ path: path.join(output, 'workbench.png'), fullPage: true });
    const beforeFailure = (await diagnostics(page)).snapshot!;
    const status = await (await request.get(api + '/api/v1/sessions/' + sid!)).json();
    const cmdline = await readFile('/proc/' + status.worker.pid + '/cmdline', 'utf8');
    expect(cmdline).toContain(sid!); expect(cmdline).toContain(path.join(output, 'service/state', sid!, 'worker'));
    const killAt = Date.now(); process.kill(status.worker.pid, 'SIGKILL');
    await expect(page.getByTestId('error-message')).toContainText('Worker');
    report.workerErrorVisibleMs = Date.now() - killAt; expect(report.workerErrorVisibleMs).toBeLessThan(3000);
    await page.waitForTimeout(300); const frozen = await readPair(page, layout!); check(frozen!);
    expect(frozen!.snapshot.log_time_s).toBe(beforeFailure.log_time_s);
    await page.getByTestId('close-session').click(); await expect(page.getByTestId('create-session')).toBeEnabled();
    const reloaded = await createAndLoad(); expect(sid!).not.toBe(first.snapshot.session_id);
    expect(reloaded.snapshot.log_time_s).toBe(0); report.reloadedSid = sid!;
    await page.getByTestId('close-session').click(); await expect(page.getByTestId('create-session')).toBeEnabled();
    expect(report.errors).toEqual([]); report.passed = true;
  } finally {
    report.final = await diagnostics(page).catch(() => null);
    await page.screenshot({ path: path.join(output, 'final-page.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'browser-evidence.json'), JSON.stringify(report, null, 2));
    // Failed assertions can leave the real WS proxy and SDK session open. Close
    // both before Playwright context teardown, including early-test failures.
    await page.close().catch(() => {});
    if (sid) await request.delete(api + '/api/v1/sessions/' + sid).catch(() => {});
  }
});
