import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPair, diagnostics, type PairSample } from './oracle';
import { sourceOracle, checkB041Pair, type Bundle, type Profile } from './resilience-b041';
import { installBrowserProbe, installWsFaults, setMediaFault, startWindow, browserProbe } from './resilience-browser';

test('T17 actual B041 resilience matrix or bounded 30 minute playback soak', async ({ page, context, request }) => {
  const output = process.env.REAL_OUTPUT_DIR!, api = process.env.REAL_API_URL!;
  const mode = process.env.T17_MODE ?? 'matrix', soakSeconds = Number(process.env.T17_SOAK_SECONDS ?? 1800);
  const bundlePath = process.env.B041_OFFLINE_BUNDLE!, profilePath = process.env.B041_PROFILE!;
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Profile;
  const source = sourceOracle(JSON.parse(await readFile(bundlePath, 'utf8')) as Bundle, profile);
  const hashInputs = async () => Object.fromEntries(await Promise.all([bundlePath, profilePath].map(async file =>
    [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  await mkdir(output, { recursive: true });
  const report: Record<string, any> = {
    passed: false, mode, sourceId: source.bundle.source.id, startedAt: new Date().toISOString(),
    scope: 'Actual B041 offline bundle, SDK6.2, PhysX, HTTP/WS, H264/WHEP decoded images and independent canvas/source oracle; provisional calibration',
    coverage: {
      independentCanvasAndSource: 'Sampled at controls and approximately 5-second soak checkpoints; mismatches counts only these independent sampled checks, not every pixel throughout the 30-minute run',
      perPresentation: 'Every actual presentation contributes FPS, capture age, callback duration and buffer measurements; this probe does not independently decode pixels or validate source values',
      recording: 'Separate matrix-only recording verifies every decoded video frame within its explicitly declared active interval; the full container and startup frames are classified separately',
    },
    faultScope: 'Local browser decoded-message and WS-message delivery only; no IP/RTP packet-loss claim. SEI snapshot is inseparable from its encoded access unit; WS delay affects controls/telemetry.',
    webSocketTransport: mode === 'soak' ? 'Native browser WebSocket; no Playwright WS route or fault injector installed' : 'Playwright WS delivery proxy for explicit matrix fault injection',
    observations: 0, mismatches: 0, errors: [], sessions: [], workerPids: [], events: [], inputHashesBefore: await hashInputs(),
    healthy: { windows: 0, elapsedMs: 0, frames: 0, minimumWindowFps: Infinity, maxAgeMs: 0, maxCallbackMs: 0,
      partialWindows: 0, omittedPartialMs: 0, controlSettlingMs: 0, ageHistogram10ms: Array(201).fill(0) },
  };
  let sid = '', activeLogId = '', lastObservedCapture = -1;
  let layout: { sourceWidth: number; sourceHeight: number; markerPixels: number[][] };
  await installBrowserProbe(page);
  // The sustained baseline must use the application's native WebSocket path.
  // Even a no-fault Playwright WS route forwards every message through Node
  // and emits instrumented sendToPage calls, changing the driver workload.
  const ws: Awaited<ReturnType<typeof installWsFaults>> = mode === 'matrix'
    ? await installWsFaults(page)
    : { state: { delayMs: 0, fault: 'none', affected: 0, pending: 0, maxPending: 0 }, close() {} };
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  page.on('pageerror', error => { if (report.errors.length < 40) report.errors.push(error.message); });
  const progress = async (phase: string, values: Record<string, unknown> = {}) => {
    const file = path.join(output, 'progress.json');
    await writeFile(file + '.tmp', JSON.stringify({ mode, phase, at: new Date().toISOString(), sid, observations: report.observations, ...values }, null, 2));
    await rename(file + '.tmp', file);
  };
  const event = async (label: string, values: Record<string, unknown> = {}) => {
    const record = { kind: 'event', label, at: new Date().toISOString(), ...values };
    report.events.push(record); await appendFile(path.join(output, 'observations.jsonl'), JSON.stringify(record) + '\n');
    await progress(label);
  };
  const check = (sample: PairSample) => {
    try {
      checkB041Pair(sample, source, sid, activeLogId);
      expect(sample.source?.inFlight ?? 0).toBeLessThanOrEqual(4);
      expect(sample.source?.pending ?? 0).toBeLessThanOrEqual(8);
      expect(sample.snapshot.capture_id).toBeGreaterThanOrEqual(lastObservedCapture);
      lastObservedCapture = sample.snapshot.capture_id;
    } catch (error) { report.mismatches++; throw error; }
  };
  const observe = async (label: string, sample: PairSample) => {
    const probe = await browserProbe(page);
    expect(probe.pending).toBeLessThanOrEqual(4);
    report.observations++;
    // Append to disk, never retain snapshots for the 30 minute run.
    const wsEvidence = mode === 'matrix' ? { injectionEnabled: true, ...ws.state }
      : { injectionEnabled: false, transport: 'native-browser-websocket' };
    await appendFile(path.join(output, 'observations.jsonl'), JSON.stringify({ kind: 'pair', label, at: new Date().toISOString(), ...sample, browser: probe, ws: wsEvidence }) + '\n');
    await progress(label, { logTime: sample.snapshot.log_time_s, captureId: sample.snapshot.capture_id });
  };
  async function wait(label: string, predicate: (sample: PairSample) => boolean = () => true, record = true) {
    let found: PairSample | null = null;
    await expect.poll(async () => {
      const sample = await readPair(page, layout);
      if (!sample || sample.snapshot.session_id !== sid || sample.snapshot.log_id !== activeLogId) return false;
      check(sample);
      if (!predicate(sample)) return false;
      found = sample; return true;
    }, { timeout: 30_000, intervals: [50, 100, 150] }).toBe(true);
    if (record) await observe(label, found!);
    return found!;
  }
  async function createAndLoad(label: string) {
    await progress(label + '-creating');
    await expect(page.getByTestId('create-session')).toBeEnabled(); await page.getByTestId('create-session').click();
    await expect(page.getByTestId('import-log')).toBeEnabled({ timeout: 150_000 });
    sid = (await diagnostics(page)).session.sid!; lastObservedCapture = -1;
    const response = await request.get(`${api}/api/v1/sessions/${sid}`); expect(response.ok()).toBe(true);
    const status = await response.json();
    report.sessions.push({ label, sid, workerPid: status.worker.pid });
    report.workerPids.push(status.worker.pid);
    const runtime = JSON.parse(await readFile(path.join(output, 'service/state', sid, 'worker/runtime.json'), 'utf8'));
    layout = { sourceWidth: 1280, sourceHeight: 720, markerPixels: runtime.marker_pixels };
    const mapping = page.getByTestId('mapping-json');
    await page.getByTestId('import-log').click();
    if (await page.getByTestId('upload-reconfigure').isVisible()) await page.getByTestId('upload-reconfigure').click();
    if (!(await mapping.isVisible())) await page.getByText('解析器与映射配置').click();
    await mapping.fill(JSON.stringify(profile));
    const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && /\/logs(?:\?|$)/.test(response.url()));
    await page.getByTestId('file-input').setInputFiles(bundlePath);
    const upload = await uploaded; expect(upload.ok()).toBe(true); activeLogId = (await upload.json()).log_id;
    await expect(page.getByTestId('b041-provisional-note')).toContainText('暂定');
    await expect(page.getByTestId('activate-log')).toBeEnabled(); await page.getByTestId('activate-log').click(); await page.getByTestId('close-import').click();
    return wait(label + '-loaded-at-zero', sample => sample.snapshot.log_time_s === 0 && sample.snapshot.state === 'ready');
  }
  async function closeSession(label: string) {
    const oldSid = sid, started = performance.now();
    await page.getByTestId('close-session').click(); await page.getByTestId('confirm-close-session').click(); await expect(page.getByTestId('create-session')).toBeEnabled({ timeout: 20_000 });
    expect((await request.get(`${api}/api/v1/sessions/${oldSid}`)).status()).toBe(404);
    sid = ''; activeLogId = ''; await event(label, { oldSid, elapsedMs: performance.now() - started });
  }
  async function seek(time: number, label = 'seek') {
    await page.getByTestId('open-seek').click(); await page.getByTestId('seek-input').fill(String(time)); await page.getByTestId('seek-submit').click();
    // Playing seeks continue immediately; pause first for an exact-position assertion.
    return wait(label, sample => Math.abs(sample.snapshot.log_time_s - time) < 1e-8);
  }
  async function pause(label = 'paused') {
    await page.getByTestId('pause').click(); return wait(label, sample => sample.snapshot.state === 'paused');
  }
  async function play(label = 'playing') {
    await page.getByTestId('play').click(); return wait(label, sample => sample.snapshot.state === 'playing');
  }
  async function speed(value: string) {
    await page.getByTestId('speed-select').selectOption(value); return wait('speed-' + value, sample => sample.snapshot.speed === Number(value));
  }
  async function healthyWindow(label: string) {
    const probe = await browserProbe(page), metric = probe.window;
    const fps = metric.frames / (metric.elapsedMs / 1000);
    const qualifiesFpsWindow = metric.elapsedMs >= 2000;
    const record = { kind: 'healthy-window', label, at: new Date().toISOString(), ...metric, fps, qualifiesFpsWindow,
      exclusion: qualifiesFpsWindow ? null : 'Sub-2-second boundary window: latency/bounds checked; omitted from fps aggregation' };
    await appendFile(path.join(output, 'observations.jsonl'), JSON.stringify(record) + '\n');
    const summary = report.healthy;
    if (qualifiesFpsWindow) {
      summary.windows++; summary.elapsedMs += metric.elapsedMs; summary.frames += metric.frames;
      summary.minimumWindowFps = Math.min(summary.minimumWindowFps, fps);
    } else { summary.partialWindows++; summary.omittedPartialMs += metric.elapsedMs; }
    summary.maxAgeMs = Math.max(summary.maxAgeMs, metric.maxAgeMs);
    summary.maxCallbackMs = Math.max(summary.maxCallbackMs, metric.maxCallbackMs);
    metric.ageHistogram10ms.forEach((count: number, i: number) => { summary.ageHistogram10ms[i] += count; });
    if (qualifiesFpsWindow) {
      expect(metric.frames, label + ': whole-window real presentation count').toBeGreaterThan(0);
      expect(fps, label + ': whole-window fps').toBeGreaterThanOrEqual(15);
    }
    expect(metric.maxAgeMs, label + ': every healthy presentation age').toBeLessThan(2000);
    expect(metric.negativeAge, 'Local capture clocks must agree').toBe(0);
    expect(metric.maxFrames).toBeLessThanOrEqual(48); expect(metric.maxSnapshots).toBeLessThanOrEqual(48);
    expect(metric.maxOwned).toBeLessThanOrEqual(4); expect(metric.maxInFlight).toBeLessThanOrEqual(4);
    expect(metric.maxDecoderPending).toBeLessThanOrEqual(8);
  }
  try {
    await page.goto('/'); await expect(page.getByTestId('mode-badge')).toContainText('真实');
    expect(context.serviceWorkers()).toHaveLength(0);
    await createAndLoad('initial');
    if (mode === 'soak') {
      // Slow playback permits long uninterrupted windows; every minute a real
      // paused seek exercises barriers and resumes the same actual session.
      await speed('0.1'); await play('soak-start'); await page.waitForTimeout(1000);
      const started = performance.now(), deadline = started + soakSeconds * 1000;
      const soakStartedAt = new Date().toISOString();
      let nextCheckpoint = started + 5000, nextSeek = started + 60_000, cycles = 0, windowActive = true;
      await startWindow(page); await event('soak-measurement-start', { requestedSeconds: soakSeconds, acceptanceDuration: soakSeconds >= 1800 });
      while (performance.now() < deadline) {
        const until = Math.min(nextCheckpoint, nextSeek < deadline - 6000 ? nextSeek : Infinity, deadline);
        await page.waitForTimeout(Math.max(1, until - performance.now()));
        const dueSeek = performance.now() >= nextSeek && performance.now() < deadline - 6000;
        if (performance.now() >= nextCheckpoint || performance.now() >= deadline || dueSeek) {
          await wait('soak-checkpoint', sample => sample.snapshot.state === 'playing');
          await healthyWindow(dueSeek ? 'soak-before-seek' : 'soak-window');
          windowActive = false; nextCheckpoint = performance.now() + 5000;
          if (performance.now() < deadline && !dueSeek) { await startWindow(page); windowActive = true; }
          await progress('soak-running', { elapsedSeconds: (performance.now() - started) / 1000, requestedSeconds: soakSeconds, seekCycles: cycles });
        }
        if (dueSeek) {
          // Do not mix the explicit control/settling interval into healthy fps.
          const settlingStarted = performance.now();
          await event('soak-seek-begin', { cycle: cycles + 1 });
          await pause('soak-pause');
          const target = source.times[Math.min(source.times.length - 2, 20 + (cycles * 37) % Math.max(1, Math.floor(source.times.length / 2)))];
          await seek(target, 'soak-seek'); await play('soak-resume'); await page.waitForTimeout(1000);
          cycles++; nextSeek = performance.now() + 60_000; nextCheckpoint = performance.now() + 5000;
          await startWindow(page); windowActive = true;
          const controlSettlingMs = performance.now() - settlingStarted; report.healthy.controlSettlingMs += controlSettlingMs;
          await event('soak-seek-settled', { cycle: cycles, target, controlSettlingMs });
        }
      }
      if (windowActive) {
        await healthyWindow('soak-final-partial');
        windowActive = false;
      }
      report.soak = { requestedSeconds: soakSeconds, elapsedSeconds: (performance.now() - started) / 1000, seekCycles: cycles,
        startedAt: soakStartedAt, endedAt: new Date().toISOString(),
        sameSession: sid === report.sessions[0].sid, qualifies30Minutes: soakSeconds >= 1800, finalWindowActive: windowActive };
      expect(report.soak.elapsedSeconds).toBeGreaterThanOrEqual(soakSeconds);
      expect(report.soak.sameSession).toBe(true);
      if (soakSeconds >= 1800) expect(cycles).toBeGreaterThanOrEqual(20);
      await pause('soak-final-pause');
    } else {
      await play(); await page.waitForTimeout(1000); await startWindow(page);
      await page.waitForTimeout(6000); await wait('continuous'); await healthyWindow('matrix-continuous');
      const paused = await pause(); await page.waitForTimeout(300);
      const held = await wait('pause-new-capture', sample => sample.snapshot.capture_id > paused.snapshot.capture_id);
      expect(held.snapshot.log_time_s).toBe(paused.snapshot.log_time_s);
      for (const value of ['0.1', '1', '4', '10']) {
        await speed(value); await seek(0); const moving = await play();
        await wait('advanced-' + value, sample => sample.snapshot.log_time_s > moving.snapshot.log_time_s + .01); await pause();
      }
      await speed('1');
      const index = Math.min(100, source.times.length - 3);
      await page.getByTestId('open-seek').click(); await page.getByText('按原采样帧定位').click(); await page.getByTestId('frame-input').fill(String(index)); await page.getByTestId('frame-submit').click();
      await wait('frame-seek', sample => sample.snapshot.source_sample_index === index);
      await page.getByTestId('step-forward').click(); await wait('step-forward', sample => sample.snapshot.source_sample_index === index + 1);
      await page.getByTestId('step-backward').click(); await wait('step-backward', sample => sample.snapshot.source_sample_index === index);
      for (const fraction of [.1, .75, .2, .9, .3]) await seek(Number((source.duration * fraction).toFixed(4)), 'continuous-seek');
      await setMediaFault(page, 'delay'); await seek(0); await play();
      await wait('decoded-delivery-delay-700ms', sample => sample.captureAgeMs >= 650);
      await pause('delayed-pause'); await setMediaFault(page, 'none');
      await wait('decoded-delay-recovered', sample => sample.captureAgeMs < 500);
      ws.state.delayMs = 700; await play('ws-control-delay'); await page.waitForTimeout(1500); await wait('ws-delayed-real-pair');
      await pause('ws-delayed-pause'); ws.state.delayMs = 0; await page.waitForTimeout(900); await wait('ws-delay-recovered');
      for (const fault of ['drop', 'duplicate', 'reorder'] as const) {
        await seek(0); await play(); await setMediaFault(page, fault); await page.waitForTimeout(1600);
        await wait('decoded-' + fault); await setMediaFault(page, 'none'); await pause();
        const generation = (await diagnostics(page)).session.wsGeneration; ws.state.fault = fault;
        // A genuine API speed change guarantees a sequenced server WS message.
        await speed('4'); await expect.poll(async () => (await diagnostics(page)).session.wsGeneration).toBeGreaterThan(generation);
        await wait('ws-' + fault + '-recovered', sample => sample.session.wsState === 'open'); await speed('1');
      }
      const generation = (await diagnostics(page)).session.wsGeneration; ws.close();
      await expect.poll(async () => (await diagnostics(page)).session.wsGeneration).toBeGreaterThan(generation);
      await wait('ws-close-recovered', sample => sample.session.wsState === 'open');
      await speed('10'); await seek(Math.max(0, source.duration - .1)); await page.getByTestId('play').click();
      await wait('ended', sample => sample.snapshot.state === 'ended' && Math.abs(sample.snapshot.log_time_s - source.duration) < 1e-8);
      await play('replayed'); await wait('replay-from-beginning', sample => sample.snapshot.log_time_s < source.duration / 2);
      await page.getByTestId('stop').click(); await wait('stopped-zero', sample => sample.snapshot.state === 'ready' && sample.snapshot.log_time_s === 0);
      // Save before refresh: a fresh page correctly resets test-only counters.
      report.injection = { browser: await browserProbe(page), ws: { ...ws.state } };
      for (const name of ['delayed', 'dropped', 'duplicated', 'reordered'])
        expect(report.injection.browser.injected[name], 'Actual decoded-message fault ' + name).toBeGreaterThan(0);
      expect(ws.state.affected, 'Actual WS drop, duplicate and reorder').toBeGreaterThanOrEqual(3);
      expect(ws.state.maxPending, 'Actual independent 700ms WS delivery backlog').toBeGreaterThan(0);
      await event('matrix-controls-complete');
      // Strict worker ownership: API response PID AND exact sid-local workdir.
      const status = await (await request.get(`${api}/api/v1/sessions/${sid}`)).json();
      const cmdline = await readFile(`/proc/${status.worker.pid}/cmdline`, 'utf8');
      expect(cmdline).toContain(sid); expect(cmdline).toContain(path.join(output, 'service/state', sid, 'worker'));
      const workerStartTime = processStartTime(readFileSync(`/proc/${status.worker.pid}/stat`, 'utf8'));
      const failedSid = sid, killed = performance.now();
      // No event-loop yield between the final identity checks and the signal.
      expect(readFileSync(`/proc/${status.worker.pid}/cmdline`, 'utf8')).toBe(cmdline);
      expect(processStartTime(readFileSync(`/proc/${status.worker.pid}/stat`, 'utf8'))).toBe(workerStartTime);
      process.kill(status.worker.pid, 'SIGKILL');
      await expect(page.getByTestId('error-message')).toContainText('Worker');
      const visibleMs = performance.now() - killed; expect(visibleMs).toBeLessThan(3000);
      await wait('worker-fault-held', sample => sample.snapshot.log_time_s === 0);
      await event('worker-sigkill', { pid: status.worker.pid, visibleMs }); await closeSession('worker-close');
      await createAndLoad('worker-reload'); expect(sid).not.toBe(failedSid);
      await runGatewayFault();
      // window.open intentionally retains its opener: same-origin popup storage
      // is initially copied, unlike a blank context.newPage() test substitute.
      const ownedReceipt = await page.evaluate(currentSid => {
        for (let index = 0; index < sessionStorage.length; index++) {
          const key = sessionStorage.key(index)!;
          if (!key.startsWith('replay.owned-session.v1:')) continue;
          const value = sessionStorage.getItem(key)!;
          if (JSON.parse(value).sid === currentSid) return { key, value };
        }
        return null;
      }, sid);
      expect(ownedReceipt, 'Parent must have its own refresh cleanup receipt').not.toBeNull();
      await context.addInitScript(key => {
        (window as any).__t17OpeningOwnedReceipt = sessionStorage.getItem(key);
      }, ownedReceipt!.key);
      const opened = page.waitForEvent('popup');
      expect(await page.evaluate(() => window.open(location.href, '_blank') !== null), 'Real same-origin popup must be supported').toBe(true);
      const popup = await opened;
      try {
        await expect(popup.getByTestId('mode-badge')).toContainText('真实');
        await expect(popup.getByTestId('create-session')).toBeEnabled();
        expect(await popup.evaluate(() => (window as any).__t17OpeningOwnedReceipt)).toBe(ownedReceipt!.value);
        expect(await popup.evaluate(key => sessionStorage.getItem(key), ownedReceipt!.key)).toBeNull();
        const child = await diagnostics(popup);
        expect(child.session.sid).toBeNull(); expect(child.snapshot).toBeNull();
        expect((await request.get(`${api}/api/v1/sessions/${sid}`)).status()).toBe(200);
      } finally { await popup.close(); }
      await page.bringToFront();
      expect(await page.evaluate(key => sessionStorage.getItem(key), ownedReceipt!.key)).toBe(ownedReceipt!.value);
      expect((await request.get(`${api}/api/v1/sessions/${sid}`)).status()).toBe(200);
      const parentPosition = (await wait('parent-after-popup')).snapshot.log_time_s;
      await play('parent-play-after-popup');
      await wait('parent-progress-after-popup', sample => sample.snapshot.log_time_s > parentPosition + .01);
      await pause('parent-pause-after-popup');
      await event('duplicate-tab-owned-session-preserved', { parentSid: sid, inheritedReceiptObserved: true, childStartedEmpty: true });
      const beforeRefresh = sid; await page.reload(); await expect(page.getByTestId('mode-badge')).toContainText('真实');
      expect((await diagnostics(page)).snapshot).toBeNull();
      await expect.poll(async () => (await request.get(`${api}/api/v1/sessions/${beforeRefresh}`)).status(), { timeout: 20_000 }).toBe(404);
      await expect(page.getByTestId('create-session')).toBeEnabled();
      sid = ''; activeLogId = ''; await event('browser-refreshed-owned-session-cleaned', { beforeRefresh, cleanupBy: 'application reload lifecycle; browser test only read status' });
      await createAndLoad('refresh-reload'); expect(sid).not.toBe(beforeRefresh); await closeSession('refresh-close');
      await cancelDuringCreation();
      for (let cycle = 0; cycle < 2; cycle++) { await createAndLoad('cycle-' + cycle); await closeSession('cycle-close-' + cycle); }
    }
    report.final = await diagnostics(page); report.browser = await browserProbe(page);
    if (sid) await closeSession('final-close');
    expect(report.errors).toEqual([]); report.passed = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.stack : String(error); throw error;
  } finally {
    report.inputHashesAfter = await hashInputs();
    report.inputHashesUnchanged = JSON.stringify(report.inputHashesBefore) === JSON.stringify(report.inputHashesAfter);
    report.passed = report.passed && report.inputHashesUnchanged; report.endedAt = new Date().toISOString();
    report.healthy.wholeWindowFps = report.healthy.frames / (report.healthy.elapsedMs / 1000);
    if (report.soak) report.soak.healthy = { presentedFps: report.healthy.wholeWindowFps,
      maxCaptureAgeMs: report.healthy.maxAgeMs, ...report.healthy };
    await page.screenshot({ path: path.join(output, 'final-page.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'browser-evidence.json'), JSON.stringify(report, null, 2));
    await progress(report.passed ? 'complete' : 'failed', { passed: report.passed });
    await page.close().catch(() => {});
    if (sid) await request.delete(`${api}/api/v1/sessions/${sid}`).catch(() => {});
    expect(report.inputHashesUnchanged).toBe(true);
  }

  async function cancelDuringCreation() {
    let captured = '', intercepted = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pattern = '**/api/v1/sessions';
    await page.route(pattern, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const response = await route.fetch(); captured = (await response.json()).session_id; intercepted = true;
      await gate; await route.fulfill({ response });
    });
    try {
      await page.getByTestId('create-session').click();
      await expect.poll(() => intercepted).toBe(true);
      await page.getByTestId('close-session').click(); release();
      await expect.poll(async () => (await request.get(`${api}/api/v1/sessions/${captured}`)).status(), { timeout: 20_000 }).toBe(404);
      await expect(page.getByTestId('create-session')).toBeEnabled();
      await event('create-cancel-cleaned', { cancelledSid: captured });
    } finally { release(); await page.unroute(pattern); }
  }
  async function runGatewayFault() {
    const apiPid = Number(process.env.T17_API_PID), ownership = process.env.T17_OWNERSHIP_DIR;
    if (!Number.isInteger(apiPid) || apiPid < 2 || !ownership) {
      await event('gateway-fault-not-run', { reason: 'Launcher did not provide T17_API_PID and T17_OWNERSHIP_DIR' });
      throw new Error('Matrix requires launcher-owned gateway identity');
    }
    const findGateway = async () => {
      const descendants: number[] = [];
      const visit = async (pid: number) => {
        const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '');
        for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) { descendants.push(child); await visit(child); }
      };
      await visit(apiPid);
      for (const pid of descendants) {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        const args = cmdline.split('\0').filter(Boolean);
        if (path.basename(args[0] ?? '') !== 'mediamtx' || !args.slice(1).some(arg => path.resolve(arg).startsWith(path.resolve(ownership) + path.sep))) continue;
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        if (stat) return { pid, cmdline, stat };
      }
      return undefined;
    }
    const gateway = await findGateway();
    if (!gateway) throw new Error('No verified descendant MediaMTX with config under owned storage');
    const before = await wait('gateway-before-kill'), killed = performance.now();
    // The preceding browser wait can be long: recheck after it, synchronously,
    // immediately before signaling the originally owned process identity.
    expect(readFileSync(`/proc/${gateway.pid}/cmdline`, 'utf8')).toBe(gateway.cmdline);
    expect(processStartTime(readFileSync(`/proc/${gateway.pid}/stat`, 'utf8'))).toBe(processStartTime(gateway.stat));
    process.kill(gateway.pid, 'SIGKILL');
    await expect.poll(async () => {
      const stat = await readFile(`/proc/${gateway.pid}/stat`, 'utf8').catch(() => '');
      return !stat || processStartTime(stat) !== processStartTime(gateway.stat) || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
    }).toBe(true);
    let replacement: Awaited<ReturnType<typeof findGateway>>;
    await expect.poll(async () => {
      replacement = await findGateway(); return !!replacement && replacement.pid !== gateway.pid;
    }, { timeout: 30_000 }).toBe(true);
    const replacementObservedWallMs = await page.evaluate(() => Date.now());
    await wait('gateway-recovered-real-pair', sample => sample.snapshot.capture_id > before.snapshot.capture_id
      && sample.snapshot.captured_wall_s * 1000 >= replacementObservedWallMs
      && sample.captureAgeMs < 1000 && sample.session.wsState === 'open');
    await event('owned-gateway-sigkill-recovered', { pid: gateway.pid, replacementPid: replacement!.pid,
      replacementObservedWallMs, elapsedMs: performance.now() - killed });
  }
});

function processStartTime(stat: string) {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
