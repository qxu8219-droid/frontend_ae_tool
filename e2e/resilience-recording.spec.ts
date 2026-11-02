import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnostics, readPair, type PairSample } from './oracle';
import { sourceOracle, checkB041Pair, type Profile } from './resilience-b041';
import { installRecordingEvidence, startLosslessScreenRecording } from './resilience-video';

// Separate context and short container: the 30 minute soak never records video.
test('T17 bounded actual B041 browser recording for independent every-frame analysis', async ({ browser, request }) => {
  test.skip(process.env.T17_MODE === 'soak', 'The long soak does not record video');
  const root = process.env.REAL_OUTPUT_DIR!, api = process.env.REAL_API_URL!;
  const output = path.join(root, 'recording'); await mkdir(output, { recursive: true });
  const report: Record<string, any> = { passed: false, mode: process.env.T17_MODE ?? 'matrix', phase: 'recording-setup',
    samples: [], errors: [], scope: '10 second declared active browser-video window; entire container is classified separately; this report does not certify the fault matrix' };
  let context!: BrowserContext, page!: Page;
  let recording!: Awaited<ReturnType<typeof installRecordingEvidence>>;
  let screenRecording: Awaited<ReturnType<typeof startLosslessScreenRecording>> | null = null;
  try {
    context = await browser.newContext({ baseURL: process.env.REAL_BASE_URL,
      viewport: { width: 1600, height: 1250 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    page = await context.newPage();
    recording = await installRecordingEvidence(page, output);
  } catch (error) {
    report.failure = error instanceof Error ? error.stack : String(error);
    await context?.close().catch(() => {});
    await writeFile(path.join(output, 'browser-recording-evidence.json'), JSON.stringify(report, null, 2));
    throw error;
  }
  const bundlePath = process.env.B041_OFFLINE_BUNDLE!, profilePath = process.env.B041_PROFILE!;
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Profile;
  const source = sourceOracle(JSON.parse(await readFile(bundlePath, 'utf8')), profile);
  let sid = '', logId = '';
  let layout: { sourceWidth: number; sourceHeight: number; markerPixels: number[][] };
  report.phase = 'recording-validation';
  page.on('pageerror', error => report.errors.push(error.message));
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  async function pair(label: string, predicate: (sample: PairSample) => boolean = () => true) {
    let found: PairSample | null = null;
    await expect.poll(async () => {
      const sample = await readPair(page, layout);
      if (!sample || sample.snapshot.session_id !== sid || sample.snapshot.log_id !== logId) return false;
      checkB041Pair(sample, source, sid, logId);
      if (!predicate(sample)) return false;
      found = sample; return true;
    }, { timeout: 30_000, intervals: [50, 100, 150] }).toBe(true);
    report.samples.push({ label, ...found! }); return found!;
  }
  try {
    await page.goto('/'); await expect(page.getByTestId('mode-badge')).toContainText('真实');
    await page.getByTestId('create-session').click(); await expect(page.getByTestId('choose-file')).toBeEnabled({ timeout: 150_000 });
    sid = (await diagnostics(page)).session.sid!;
    const status = await (await request.get(`${api}/api/v1/sessions/${sid}`)).json(); report.sid = sid; report.workerPid = status.worker.pid;
    const runtime = JSON.parse(await readFile(path.join(root, 'service/state', sid, 'worker/runtime.json'), 'utf8'));
    layout = { sourceWidth: 1280, sourceHeight: 720, markerPixels: runtime.marker_pixels };
    const mapping = page.getByTestId('mapping-json');
    if (!(await mapping.isVisible())) await page.getByText('解析器与映射配置').click();
    await mapping.fill(JSON.stringify(profile));
    const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && /\/logs(?:\?|$)/.test(response.url()));
    await page.getByTestId('file-input').setInputFiles(bundlePath);
    const upload = await uploaded; expect(upload.ok()).toBe(true); logId = (await upload.json()).log_id;
    await expect(page.getByTestId('activate-log')).toBeEnabled(); await page.getByTestId('activate-log').click();
    await pair('recording-ready', sample => sample.snapshot.state === 'ready' && sample.snapshot.log_time_s === 0);
    await page.getByTestId('speed-select').selectOption('0.1'); await pair('recording-speed', sample => sample.snapshot.speed === .1);
    await page.getByTestId('play').click(); await pair('recording-playing', sample => sample.snapshot.state === 'playing');
    // A documented 1:1 CSS display avoids additional resampling of text glyphs.
    // These test styles affect layout only, never source pixels or panel content.
    await page.addStyleTag({ content: '[data-testid="paired-canvas"]{width:1600px!important;min-width:1600px!important;height:800px!important}.stage-scroll{overflow:visible!important}' });
    await page.getByTestId('paired-canvas').evaluate(canvas => canvas.scrollIntoView({ block: 'start', inline: 'nearest' }));
    await page.getByTestId('paired-canvas').evaluate(canvas => {
      const bounds = canvas.getBoundingClientRect();
      (canvas as HTMLCanvasElement).style.transform = `translate(${Math.round(bounds.x)-bounds.x}px, ${Math.round(bounds.y)-bounds.y}px)`;
    });
    await page.waitForTimeout(400);
    const bounds = await page.getByTestId('paired-canvas').boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.width).toBe(1600); expect(bounds!.height).toBe(800);
    expect(Number.isInteger(bounds!.x)).toBe(true); expect(Number.isInteger(bounds!.y)).toBe(true);
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1600); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(1250);
    report.viewport = { width: 1600, height: 1250 }; report.canvas = bounds;
    screenRecording = await startLosslessScreenRecording(page, output);
    const before = await pair('recording-window-start');
    // The helper persists explicit browser capture anchors; the analyzer may
    // classify startup separately but must not skip any interior video frame.
    report.activeWindow = { startCapture: before.snapshot.capture_id, sessionId: sid, startedAt: new Date().toISOString() };
    report.recordingStart = await recording.start();
    const started = performance.now();
    for (let index = 0; index < 10; index++) { await page.waitForTimeout(1000); await pair('recording-checkpoint-' + index); }
    const after = await pair('recording-window-end');
    report.recordingEnd = await recording.end();
    report.screenRecording = await screenRecording.stop();
    report.video = report.screenRecording.manifest;
    report.recordingFormat = 'chromium-cdp-png/v1';
    expect(report.screenRecording.complete).toBe(true); expect(report.screenRecording.errors).toEqual([]);
    Object.assign(report.activeWindow, { endCapture: after.snapshot.capture_id, endedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000 });
    expect(report.errors).toEqual([]); report.passed = true;
  } catch (error) { report.failure = error instanceof Error ? error.stack : String(error); throw error; }
  finally {
    if (screenRecording) {
      report.screenRecording = await screenRecording.stop();
      report.video = report.screenRecording.manifest;
      report.recordingFormat = 'chromium-cdp-png/v1';
      if (!report.screenRecording.complete) report.passed = false;
    }
    report.references = await recording.stop().catch(error => ({ error: String(error) }));
    await page.close().catch(() => {}); await context.close().catch(() => {});
    if (sid) {
      const deleted = await request.delete(`${api}/api/v1/sessions/${sid}`).catch(() => null);
      report.deleteStatus = deleted?.status();
      report.cleanupAcknowledged = deleted?.ok() === true || deleted?.status() === 404;
      report.passed = report.passed && report.cleanupAcknowledged;
    }
    await writeFile(path.join(output, 'browser-recording-evidence.json'), JSON.stringify(report, null, 2));
    expect(report.cleanupAcknowledged ?? !sid).toBe(true);
  }
});
