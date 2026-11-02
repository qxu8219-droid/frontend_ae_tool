import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPair, diagnostics, type PairSample } from './oracle';

// Only file-format contracts are shared: no application adapter, transform,
// protocol decoder or renderer is imported by the numeric oracle.
interface SourceQuality { valid: boolean; source_time: string | null; age_s: number | null; timing: string }
interface SourceSample { time: string; row: number; frame_index: number | null; state: number[] | null; state_quality: SourceQuality[] | null }
interface Segment { id: string; start_frame: number; end_frame: number; label: string; boundary_status: string | null; review_status: string | null; training_approved: boolean | null }
interface Bundle {
  schema: string;
  source: { id: string; format: string; time_unit: 'ns' | 's'; sha256: string; base_locked: boolean | null };
  samples: SourceSample[];
  annotations: { alignment: string; segments: Segment[]; reference: Record<string, unknown> };
  events: Array<{ time: string | null; kind: string }>;
}
interface Gripper { native_closed: number; native_open: number; zero1_m: number; zero2_m: number; travel1_m: number; travel2_m: number }
interface Profile {
  b041: {
    basis: string; status: string; left_gripper: Gripper; right_gripper: Gripper;
    max_source_age_s: number; max_interpolation_gap_s: number;
    chassis: { mode: string; velocity_frame: string; initial_pose: number[]; velocity_scale: number[]; velocity_bias: number[]; max_gap_s: number };
  };
}
interface DetailedQuality { origin: string; valid: boolean; processing?: string[]; method?: string | null; source_indices?: number[] }
const armTorso = [
  ...Array.from({ length: 7 }, (_, i) => ({ canonical: 10 + i, native: i, group: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ canonical: 19 + i, native: 7 + i, group: 1 })),
  ...Array.from({ length: 4 }, (_, i) => ({ canonical: 6 + i, native: 19 + i, group: 5 })),
];

function oracle(bundle: Bundle, profile: Profile) {
  const config = profile.b041;
  if (bundle.schema !== 'b041.recording.v1' || config.basis !== 'state' || config.status !== 'provisional') throw new Error('Expected provisional state-basis B041 inputs');
  const samples = bundle.samples.filter((sample): sample is SourceSample & { state: number[]; state_quality: SourceQuality[] } => sample.state !== null && sample.state_quality !== null);
  if (samples.length < 2) throw new Error('Expected a recorded motion series');
  const relative = (time: string) => bundle.source.time_unit === 'ns'
    ? Number(BigInt(time) - BigInt(samples[0].time)) / 1e9
    : Number(time) - Number(samples[0].time);
  const times = samples.map(sample => relative(sample.time));
  if (times.some((time, i) => i > 0 && time <= times[i - 1])) throw new Error('Expected strictly ordered state samples');
  const valid = (index: number, group: number) => {
    const quality = samples[index].state_quality[group];
    return quality.valid && (quality.age_s === null || quality.age_s >= 0 && quality.age_s <= config.max_source_age_s)
      && (quality.source_time === null || bundle.source.time_unit !== 'ns' || BigInt(quality.source_time) >= 0n && BigInt(quality.source_time) <= BigInt(samples[index].time));
  };
  const brackets = (time: number) => {
    const exact = times.findIndex(value => Math.abs(value - time) < 1e-9);
    if (exact >= 0) return [exact, exact] as const;
    const right = times.findIndex(value => value > time);
    return [right < 0 ? times.length - 1 : Math.max(0, right - 1), right < 0 ? times.length - 1 : right] as const;
  };
  const scalar = (time: number, native: number, group: number) => {
    const [left, right] = brackets(time);
    if (left === right && valid(left, group)) return { value: samples[left].state[native], valid: true, interpolated: false, held: false, sourceIndices: [left] };
    if (left !== right && valid(left, group) && valid(right, group) && times[right] - times[left] <= config.max_interpolation_gap_s) {
      const alpha = (time - times[left]) / (times[right] - times[left]);
      return { value: samples[left].state[native] * (1 - alpha) + samples[right].state[native] * alpha, valid: true, interpolated: true, held: false, sourceIndices: [left, right] };
    }
    let previous = left;
    while (previous >= 0 && !valid(previous, group)) previous--;
    return { value: previous < 0 ? 0 : samples[previous].state[native], valid: false, interpolated: false, held: previous >= 0, sourceIndices: previous < 0 ? [] : [previous] };
  };
  // Independent midpoint-rotation/sinc exponential of a held body Twist.
  const poses: Array<number[] | null> = [];
  const integrate = bundle.source.format === 'full23_parquet' && bundle.source.base_locked !== true && config.chassis.mode !== 'unavailable';
  if (integrate && config.chassis.velocity_frame !== 'body') throw new Error('This validation oracle requires explicitly assumed body-frame velocity');
  if (integrate) {
    poses.push(valid(0, 4) ? [...config.chassis.initial_pose] : null);
    for (let index = 1; index < samples.length; index++) {
      const previous = poses[index - 1], dt = times[index] - times[index - 1];
      if (!previous || !valid(index - 1, 4) || !valid(index, 4) || dt > config.chassis.max_gap_s) { poses.push(null); continue; }
      const velocity = samples[index - 1].state.slice(16, 19).map((value, axis) => value * config.chassis.velocity_scale[axis] + config.chassis.velocity_bias[axis]);
      const halfTurn = velocity[2] * dt / 2;
      const distanceScale = dt * (Math.abs(halfTurn) < 1e-10 ? 1 - halfTurn * halfTurn / 6 : Math.sin(halfTurn) / halfTurn);
      const angle = previous[2] + halfTurn, c = Math.cos(angle), s = Math.sin(angle);
      poses.push([previous[0] + distanceScale * (c * velocity[0] - s * velocity[1]), previous[1] + distanceScale * (s * velocity[0] + c * velocity[1]), previous[2] + 2 * halfTurn]);
    }
  }
  function expected(time: number) {
    const values = Array<number>(28).fill(0), qualities: Array<{ valid: boolean; origin: string; interpolated: boolean; held: boolean; sourceIndices: number[] }> = Array.from({ length: 28 }, () => ({ valid: false, origin: 'missing', interpolated: false, held: false, sourceIndices: [] }));
    for (const channel of armTorso) {
      const sample = scalar(time, channel.native, channel.group);
      values[channel.canonical] = sample.value; qualities[channel.canonical] = { ...sample, origin: 'measured' };
    }
    for (const [native, group, canonical, setting] of [[14, 2, 17, config.left_gripper], [15, 3, 26, config.right_gripper]] as const) {
      const sample = scalar(time, native, group), alpha = (sample.value - setting.native_closed) / (setting.native_open - setting.native_closed);
      values[canonical] = setting.zero1_m + alpha * setting.travel1_m;
      values[canonical + 1] = setting.zero2_m + alpha * setting.travel2_m;
      qualities[canonical] = qualities[canonical + 1] = { ...sample, origin: 'derived' };
    }
    const [left, right] = brackets(time), a = poses[left], b = poses[right];
    const alpha = left === right ? 0 : (time - times[left]) / (times[right] - times[left]);
    const chassis = a && b && (left === right || times[right] - times[left] <= config.max_interpolation_gap_s)
      ? a.map((value, axis) => value * (1 - alpha) + b[axis] * alpha) : null;
    return { values, qualities, chassis, left, right };
  }
  return { bundle, samples, times, duration: times.at(-1)!, relative, expected };
}

test('real B041 state replay preserves measured joints, provisional mapping, gaps and source annotations', async ({ page, context, request }) => {
  const output = process.env.REAL_OUTPUT_DIR!, api = process.env.REAL_API_URL!;
  const offlinePath = process.env.B041_OFFLINE_BUNDLE!, runtimePath = process.env.B041_RUNTIME_BUNDLE!, profilePath = process.env.B041_PROFILE!;
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Profile;
  const offline = oracle(JSON.parse(await readFile(offlinePath, 'utf8')), profile);
  const runtime = oracle(JSON.parse(await readFile(runtimePath, 'utf8')), profile);
  const inputHashes = async () => Object.fromEntries(await Promise.all([offlinePath, runtimePath, profilePath].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  const report: Record<string, any> = { passed: false, scope: 'Actual SDK6.2 / HTTP / WS / WHEP / browser canvas with selected recorded B041 samples; provisional assumptions, not physical calibration or measured world pose', samples: [], handCheckpoints: [], errors: [], workerPids: [], inputHashesBefore: await inputHashes(), sourceIds: [offline.bundle.source.id, runtime.bundle.source.id] };
  let sid = '', activeLogId = '', current = offline;
  let layout: { sourceWidth: number; sourceHeight: number; markerPixels: number[][] };
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  page.on('pageerror', error => report.errors.push(error.message));
  function check(sample: PairSample) {
    const frame = sample.snapshot, wanted = current.expected(frame.log_time_s);
    expect(sample.stamp.confident).toBe(true); expect(sample.stamp.crc).toBe(sample.stamp.expectedCrc);
    expect(sample.stamp.id).toBe(frame.capture_id); expect(frame.render_seq).toBe(frame.capture_id); expect(sample.sync.lastCapture).toBe(frame.capture_id);
    expect(frame.session_id).toBe(sid); expect(frame.log_id).toBe(activeLogId);
    expect(frame.duration_s).toBeCloseTo(current.duration, 9); expect(frame.progress).toBeCloseTo(frame.log_time_s / current.duration, 10);
    expect(sample.visibleText).toEqual({ time: 0, source: 0, joints: [0, 0, 0, 0, 0, 0] });
    expect(sample.visibleChassis).toBe(0); expect(sample.progressPixels).toEqual({ filled: true, empty: true });
    expect(frame.source_joints).toHaveLength(28);
    frame.source_joints.forEach((value, index) => {
      expect(value, `native-derived canonical joint ${index}`).toBeCloseTo(wanted.values[index], 8);
      expect(Math.abs(frame.joints[index] - value)).toBeLessThan(1e-5);
      const actual = frame.quality[index] as DetailedQuality, quality = wanted.qualities[index];
      expect(actual.origin).toBe(quality.origin); expect(actual.valid).toBe(quality.valid);
      expect(actual.source_indices).toEqual(quality.sourceIndices);
      if (quality.interpolated) expect(actual.processing).toContain('interpolated');
      if (quality.held) expect(actual.processing).toContain('forward_filled');
      if (quality.origin === 'derived' && quality.valid) expect(actual.method).toMatch(/^b041\.provisional\./);
    });
    if (wanted.chassis) {
      expect(frame.chassis).not.toBeNull(); expect(frame.chassis?.quality).toHaveLength(3);
      (['x', 'y', 'yaw'] as const).forEach((axis, index) => {
        expect(frame.chassis![axis]).toBeCloseTo(wanted.chassis![index], 5);
        const quality = frame.chassis!.quality![index] as DetailedQuality;
        expect(quality.origin).toBe('derived'); expect(quality.valid).toBe(true); expect(quality.method).toMatch(/^b041\.provisional\./);
        expect(quality.source_indices).toEqual(wanted.left === wanted.right ? [wanted.left] : [wanted.left, wanted.right]);
      });
    } else expect(frame.chassis).toBeNull();
    expect(sample.sync.frames).toBeLessThanOrEqual(48); expect(sample.sync.snapshots).toBeLessThanOrEqual(48);
    expect(sample.source?.owned ?? 0).toBeLessThanOrEqual(4);
  }
  async function wait(label: string, condition: (sample: PairSample) => boolean = () => true) {
    let found: PairSample | null = null;
    await expect.poll(async () => {
      const sample = await readPair(page, layout);
      if (!sample || sample.snapshot.log_id !== activeLogId) return false;
      check(sample);
      if (!condition(sample)) return false;
      found = sample; return true;
    }, { timeout: 30_000, intervals: [40, 80, 120] }).toBe(true);
    report.samples.push({ label, ...found! }); return found!;
  }
  async function seekFrame(index: number, label: string) {
    if (await page.getByTestId('close-annotations').isVisible()) await page.getByTestId('close-annotations').click();
    await page.getByTestId('open-seek').click(); await page.getByText('按原采样帧定位').click(); await page.getByTestId('frame-input').fill(String(index)); await page.getByTestId('frame-submit').click();
    const found = await wait(label, sample => Math.abs(sample.snapshot.log_time_s - current.times[index]) < 1e-8 && sample.snapshot.source_sample_index === index);
    report.handCheckpoints.push({ label, sourceId: current.bundle.source.id, sourceRow: current.samples[index].row, originalFrame: current.samples[index].frame_index,
      sourceClock: current.samples[index].time, nativeState: current.samples[index].state, expected: current.expected(current.times[index]), captureId: found.snapshot.capture_id });
    return found;
  }
  async function seekTime(time: number, label: string) {
    if (await page.getByTestId('close-annotations').isVisible()) await page.getByTestId('close-annotations').click();
    await page.getByTestId('open-seek').click(); await page.getByTestId('seek-input').fill(String(time)); await page.getByTestId('seek-submit').click();
    return wait(label, sample => Math.abs(sample.snapshot.log_time_s - time) < 1e-8);
  }
  async function load(file: string, source: ReturnType<typeof oracle>) {
    if (await page.getByTestId('close-annotations').isVisible()) await page.getByTestId('close-annotations').click();
    const mapping = page.getByTestId('mapping-json');
    await page.getByTestId('import-log').click();
    if (await page.getByTestId('upload-reconfigure').isVisible()) await page.getByTestId('upload-reconfigure').click();
    if (!(await mapping.isVisible())) await page.getByText('解析器与映射配置').click();
    await mapping.fill(JSON.stringify(profile));
    const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && /\/logs(?:\?|$)/.test(response.url()));
    await page.getByTestId('file-input').setInputFiles(file);
    const response = await uploaded; expect(response.ok()).toBe(true);
    const data = await response.json(); activeLogId = data.log_id; current = source;
    report.uploads ??= []; report.uploads.push({ sourceId: source.bundle.source.id, ...data });
    await expect(page.getByTestId('b041-provisional-note')).toContainText('暂定');
    await expect(page.getByTestId('activate-log')).toBeEnabled(); await page.getByTestId('activate-log').click(); await page.getByTestId('close-import').click();
    await wait('loaded-' + source.bundle.source.id, sample => sample.snapshot.log_time_s === 0 && sample.snapshot.state === 'ready');
    await page.getByTestId('open-annotations').click();
    await expect(page.getByTestId('annotation-assumptions')).toContainText('尚非精确标定');
    const annotations = await (await request.get(`${api}/api/v1/sessions/${sid}/logs/${activeLogId}/annotations`)).json();
    expect(annotations.alignment).toBe(source.bundle.annotations.alignment);
    expect(annotations.provisional).toBe(true); return annotations;
  }
  async function verifySegments(index: number) {
    if (!(await page.getByTestId('close-annotations').isVisible())) await page.getByTestId('open-annotations').click();
    const original = current.samples[index].frame_index!;
    const expected = current.bundle.annotations.segments.filter(segment => segment.start_frame <= original && original < segment.end_frame);
    const panels = page.getByTestId('annotation-current-segment');
    await expect(panels).toHaveCount(expected.length);
    for (const [position, segment] of expected.entries()) {
      await expect(panels.nth(position)).toContainText(segment.label);
      await expect(panels.nth(position)).toContainText(`帧 [${segment.start_frame}, ${segment.end_frame})`);
      if (segment.boundary_status) await expect(panels.nth(position)).toContainText(segment.boundary_status);
      if (segment.training_approved === false) await expect(panels.nth(position)).toContainText('training_approved=false');
    }
    report.annotationCheckpoints ??= []; report.annotationCheckpoints.push({ originalFrame: original, expectedSegmentIds: expected.map(segment => segment.id), renderedText: await panels.allTextContents() });
  }
  try {
    await page.goto('/'); await expect(page.getByTestId('mode-badge')).toContainText('真实');
    expect(context.serviceWorkers()).toHaveLength(0);
    await page.getByTestId('create-session').click(); await expect(page.getByTestId('import-log')).toBeEnabled({ timeout: 150_000 });
    sid = (await diagnostics(page)).session.sid!;
    const status = await (await request.get(`${api}/api/v1/sessions/${sid}`)).json(); report.workerPids.push(status.worker.pid); report.sessionId = sid;
    const runtimeInfo = JSON.parse(await readFile(path.join(output, 'service/state', sid, 'worker/runtime.json'), 'utf8'));
    layout = { sourceWidth: 1280, sourceHeight: 720, markerPixels: runtimeInfo.marker_pixels };
    await load(offlinePath, offline);
    for (const index of [0, Math.floor(offline.samples.length / 2), offline.samples.length - 1]) { await seekFrame(index, 'offline-handcheck-' + index); await verifySegments(index); }
    const boundary = offline.bundle.annotations.segments.find(segment => segment.start_frame > 0 && segment.boundary_status?.includes('pending_review'));
    expect(boundary).toBeDefined();
    for (const index of [boundary!.start_frame - 1, boundary!.start_frame]) { await seekFrame(index, 'annotation-boundary-' + index); await verifySegments(index); }
    await expect(page.getByTestId('annotation-current-segment')).toContainText('pending_review');
    await page.screenshot({ path: path.join(output, 'offline-boundary.png'), fullPage: true });
    await seekFrame(0, 'before-controls');
    await page.getByTestId('play').click(); await wait('playing', sample => sample.snapshot.state === 'playing' && sample.snapshot.log_time_s > .15);
    await page.getByTestId('pause').click(); const paused = await wait('paused', sample => sample.snapshot.state === 'paused');
    const held = await wait('pause-fresh-image', sample => sample.snapshot.capture_id > paused.snapshot.capture_id);
    expect(held.snapshot.log_time_s).toBe(paused.snapshot.log_time_s);
    for (const speed of ['0.1', '10']) {
      await page.getByTestId('speed-select').selectOption(speed); await wait('speed-' + speed, sample => sample.snapshot.speed === Number(speed));
      await page.getByTestId('play').click();
      const start = await wait('play-' + speed, sample => sample.snapshot.state === 'playing');
      await wait('advanced-' + speed, sample => sample.snapshot.log_time_s > start.snapshot.log_time_s + .01);
      await page.getByTestId('pause').click(); await wait('pause-' + speed, sample => sample.snapshot.state === 'paused');
    }
    await seekFrame(100, 'original-frame-100');
    await page.getByTestId('step-forward').click(); await wait('step-forward-101', sample => sample.snapshot.source_sample_index === 101);
    await page.getByTestId('step-backward').click(); await wait('step-backward-100', sample => sample.snapshot.source_sample_index === 100);
    await page.getByTestId('stop').click(); await wait('stopped', sample => sample.snapshot.log_time_s === 0 && sample.snapshot.state === 'ready');
    await page.screenshot({ path: path.join(output, 'offline-stopped.png'), fullPage: true });
    const offlineLogId = activeLogId, onlineAnnotations = await load(runtimePath, runtime);
    expect(activeLogId).not.toBe(offlineLogId); expect((await diagnostics(page)).session.sid).toBe(sid);
    await expect(page.getByTestId('annotation-current-segment')).toHaveCount(0);
    if (runtime.bundle.annotations.alignment === 'reference_only') {
      await expect(page.getByTestId('annotation-reference')).toContainText('未对齐当前运行');
      await expect(page.getByTestId('annotation-reference').getByRole('button')).toHaveCount(0);
      report.referenceOnlyExercised = true;
    } else {
      await expect(page.getByTestId('annotation-reference')).toHaveCount(0);
      report.referenceOnlyExercised = false;
      report.referenceOnlyScope = 'Selected live run has no reference sidecar; no historical reference was fabricated.';
    }
    for (const index of [0, Math.floor(runtime.samples.length / 2), runtime.samples.length - 1]) await seekFrame(index, 'runtime-handcheck-' + index);
    await seekFrame(0, 'runtime-before-play');
    await page.getByTestId('speed-select').selectOption('1'); await wait('runtime-speed-one', sample => sample.snapshot.speed === 1);
    await page.getByTestId('play').click(); await wait('runtime-playing', sample => sample.snapshot.state === 'playing' && sample.snapshot.log_time_s > .05);
    await page.getByTestId('pause').click(); await wait('runtime-paused', sample => sample.snapshot.state === 'paused');
    const gap = runtime.times.findIndex((time, index) => index > 0 && time - runtime.times[index - 1] > profile.b041.max_interpolation_gap_s);
    expect(gap).toBeGreaterThan(0);
    const gapTime = (runtime.times[gap - 1] + runtime.times[gap]) / 2;
    const missing = await seekTime(gapTime, 'runtime-gap-invalid-hold');
    for (const index of [...armTorso.map(channel => channel.canonical), 17, 18, 26, 27]) expect(missing.snapshot.quality[index].valid).toBe(false);
    expect(missing.snapshot.chassis).toBeNull(); report.gap = { before: runtime.times[gap - 1], after: runtime.times[gap], checked: gapTime, noPredictionFill: true };
    await page.getByTestId('open-annotations').click();
    await expect(page.getByText(/历史事件 · \d+ · 诊断记录，不代表当前状态/)).toBeVisible();
    await page.getByText(/历史事件 · \d+ · 诊断记录，不代表当前状态/).click();
    if (onlineAnnotations.events.some((event: { time_s: number | null }) => event.time_s === null)) {
      const inert = page.getByRole('button', { name: /无法对齐 · 不可定位/ });
      expect(await inert.count()).toBeGreaterThan(0); await expect(inert.first()).toBeDisabled();
    }
    if (onlineAnnotations.events.length > 100) {
      const navigation = page.getByRole('navigation', { name: '历史事件分页' });
      const next = navigation.getByRole('button', { name: '下一页' });
      while (await next.isEnabled()) await next.click();
      const count = onlineAnnotations.events.length, last = onlineAnnotations.events.at(-1);
      await expect(navigation).toContainText(`${count} / ${count}`);
      const history = navigation.locator('..');
      await expect(history.getByText(last.message, { exact: true }).last()).toBeVisible();
      expect(await history.locator(':scope > ol > li').count()).toBeLessThanOrEqual(100);
      report.historyPagination = { total: count, lastEventId: last.id, lastPage: Math.ceil(count / 100) };
    }
    await page.screenshot({ path: path.join(output, 'runtime-gap.png'), fullPage: true });
    await page.getByTestId('close-annotations').click();
    await page.getByTestId('stop').click(); await wait('runtime-stopped', sample => sample.snapshot.log_time_s === 0 && sample.snapshot.state === 'ready');
    await page.getByTestId('close-session').click(); await page.getByTestId('confirm-close-session').click(); await expect(page.getByTestId('create-session')).toBeEnabled();
    expect(report.errors).toEqual([]); report.passed = true;
  } finally {
    report.final = await diagnostics(page).catch(() => null);
    await page.screenshot({ path: path.join(output, 'final-page.png'), fullPage: true }).catch(() => {});
    await page.close().catch(() => {});
    if (sid) await request.delete(`${api}/api/v1/sessions/${sid}`).catch(() => {});
    report.inputHashesAfter = await inputHashes();
    report.inputHashesUnchanged = JSON.stringify(report.inputHashesBefore) === JSON.stringify(report.inputHashesAfter);
    report.passed = report.passed && report.inputHashesUnchanged;
    await writeFile(path.join(output, 'browser-evidence.json'), JSON.stringify(report, null, 2));
    expect(report.inputHashesUnchanged).toBe(true);
  }
});
