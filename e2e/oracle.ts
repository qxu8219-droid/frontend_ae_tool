import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import type { BrowserEvidence } from "./fixtures";

// Deliberately independent of application stamp, renderer, runtime, and store modules.
export interface Snapshot {
  chassis?: { x: number; y: number; yaw: number; quality?: Array<{ origin: string; valid: boolean; method?: string | null; processing?: string[] }> | null } | null;
  capture_id: number;
  captured_wall_s: number;
  render_seq: number;
  session_id: string;
  log_id: string;
  control_seq: number;
  playback_epoch: number;
  target_seq: number;
  log_time_s: number;
  duration_s: number;
  progress: number;
  speed: number;
  source_sample_index?: number | null;
  state: string;
  source_joints: number[];
  joints: number[];
  quality: Array<{ origin: string; valid: boolean }>;
}

interface Diagnostics {
  snapshot(): Snapshot | null;
  sync(): {
    frames: number;
    snapshots: number;
    capacity: number;
    presented: number;
    lastCapture: number;
    sessionId?: string;
    generation?: number;
  };
  session(): {
    sid: string | null;
    workerPhase: string;
    wsGeneration: number;
    wsState: string;
    mode: "mock" | "real";
  };
  layout(): {
    sourceWidth: number;
    sourceHeight: number;
    markerPixels: [number, number][];
    imageRect: { x: number; y: number; width: number; height: number };
  };
  source(): {
    inFlight?: number;
    pending?: number;
    owned?: number;
    dropped?: number;
    generation?: number;
  } | null;
}

export interface PairSample {
  snapshot: Snapshot;
  stamp: { id: number; crc: number; expectedCrc: number; confident: boolean };
  sync: ReturnType<Diagnostics["sync"]>;
  session: ReturnType<Diagnostics["session"]>;
  source: ReturnType<Diagnostics["source"]>;
  canvas: { width: number; height: number };
  robotPixelsHash: number;
  captureAgeMs: number;
  progressPixels: { filled: boolean; empty: boolean };
  visibleText: { time: number; source: number; joints: number[] };
  visibleChassis: number;
}

export async function diagnostics(page: Page) {
  return page.evaluate(() => {
    const diagnostic = (
      window as unknown as { __replayDiagnostics: Diagnostics }
    ).__replayDiagnostics;
    return {
      snapshot: diagnostic.snapshot(),
      sync: diagnostic.sync(),
      session: diagnostic.session(),
      source: diagnostic.source(),
    };
  });
}

/** Snapshot and actual canvas pixels are read in one synchronous browser evaluation. */
export async function readPair(page: Page, expectedLayout?: { sourceWidth: number; sourceHeight: number; markerPixels: number[][] }): Promise<PairSample | null> {
  return page.evaluate((expectedLayout) => {
    const diagnostic = (
      window as unknown as { __replayDiagnostics?: Diagnostics }
    ).__replayDiagnostics;
    if (!diagnostic) return null;
    const snapshot = diagnostic.snapshot();
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="paired-canvas"]',
    );
    if (!snapshot || !canvas) return null;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Missing paired-canvas 2D context");
    const { sourceWidth, sourceHeight, markerPixels, imageRect } =
      diagnostic.layout();
    if (
      markerPixels.length !== 64 ||
      sourceWidth !== (expectedLayout?.sourceWidth ?? 640) ||
      sourceHeight !== (expectedLayout?.sourceHeight ?? 360) ||
      expectedLayout && JSON.stringify(markerPixels) !== JSON.stringify(expectedLayout.markerPixels)
    ) {
      throw new Error("Unexpected documented capture32_crc32 layout");
    }
    let id = 0;
    let crc = 0;
    let confident = true;
    markerPixels.forEach(([x, y], bit) => {
      const pixel = context.getImageData(
        Math.floor(imageRect.x + (x * imageRect.width) / sourceWidth),
        Math.floor(imageRect.y + (y * imageRect.height) / sourceHeight),
        1,
        1,
      ).data;
      if (Math.abs(pixel[1]! - pixel[0]!) < 30 || pixel[3] !== 255)
        confident = false;
      if (pixel[1]! > pixel[0]!) {
        if (bit < 32) id += 2 ** bit;
        else crc += 2 ** (bit - 32);
      }
    });
    // Independent IEEE CRC32 implementation: generate a lookup table and feed
    // all four big-endian ID bytes. No production decoder is imported/called.
    const table = Array.from({ length: 256 }, (_, entry) => {
      let value = entry;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
    let remainder = 0xffffffff;
    for (let power = 3; power >= 0; power--) {
      const byte = Math.floor(id / 256 ** power) % 256;
      remainder = table[(remainder ^ byte) & 255]! ^ (remainder >>> 8);
    }
    const expectedCrc = (remainder ^ 0xffffffff) >>> 0;
    // Exclude the identity strip and textual footer: this samples actual robot
    // geometry, which must move during play and remain stable during pause.
    const robotPixels = context.getImageData(
      Math.ceil(imageRect.x + .1875 * imageRect.width),
      Math.ceil(imageRect.y + .2 * imageRect.height),
      Math.floor(.65625 * imageRect.width),
      Math.floor(.72 * imageRect.height),
    ).data;
    let robotPixelsHash = 2166136261;
    for (const byte of robotPixels)
      robotPixelsHash = Math.imul(robotPixelsHash ^ byte, 16777619) >>> 0;
    const isColor = (x: number, rgb: [number, number, number]) => {
      const pixel = context.getImageData(x, 678, 1, 1).data;
      return rgb.every((value, i) => Math.abs(value - pixel[i]!) <= 2);
    };
    const fillWidth = 900 * snapshot.progress;
    const filled =
      fillWidth < 3 || isColor(20 + Math.floor(fillWidth / 2), [69, 216, 232]);
    const empty =
      fillWidth > 897 ||
      isColor(20 + Math.ceil((fillWidth + 900) / 2), [38, 55, 75]);
    // Rasterize only the documented numeric labels on an independent canvas.
    // Pixel comparison includes glyph shape and blank background, so stale or
    // extra digits cannot pass merely because the diagnostic value is correct.
    const expectedCanvas = document.createElement("canvas");
    expectedCanvas.width = 1280;
    expectedCanvas.height = 1080;
    const expected = expectedCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;
    expected.fillStyle = "#0b1523";
    expected.fillRect(20, 592, 900, 74);
    expected.fillRect(936, 70, 324, 584);
    expected.textBaseline = "alphabetic";
    expected.font = "15px ui-monospace, SFMono-Regular, Menlo, monospace";
    expected.fillStyle = "#e5edf6";
    expected.fillText(
      `LOG TIME  ${snapshot.log_time_s.toFixed(3)} / ${snapshot.duration_s.toFixed(3)} s`,
      20,
      612,
    );
    const pose = snapshot.chassis;
    // Independent provenance oracle: use captured per-axis quality, including legacy unknowns.
    const origins: Record<string, string> = { measured: '实测', commanded: '指令', derived: '推算', missing: '缺失' };
    const transforms: Record<string, string> = { original: '', unit_converted: '换算', interpolated: '插值', forward_filled: '前填', defaulted: '默认', derived: '推算' };
    (['x', 'y', 'yaw'] as const).forEach((axis, index) => {
      const quality = pose?.quality?.[index];
      const available = !!pose && (!quality || quality.valid && quality.origin !== 'missing');
      const labels = quality ? [origins[quality.origin]] : [pose ? '来源未知' : '不可用'];
      for (const operation of quality?.processing ?? []) {
        const name = transforms[operation]; if (name && !labels.includes(name)) labels.push(name);
      }
      if (quality?.method?.startsWith('b041.provisional.')) labels.push('暂定');
      if (quality && !quality.valid && quality.origin !== 'missing') labels.push('无效');
      expected.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
      expected.fillStyle = available ? '#e5edf6' : '#738092';
      expected.fillText(`${index === 0 ? 'CHASSIS ' : ''}${axis} ${available ? pose![axis].toFixed(3) : '—'} ${axis === 'yaw' ? 'rad' : 'm'} · ${labels.join('·')}`,
        20 + index * 260, 637, 250);
    });
    expected.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
    expected.fillStyle = "#8297af";
    expected.fillText(
      `Wheel source rad: ${[1, 3, 5].map((index) => snapshot.source_joints[index]!.toFixed(3)).join(" / ")} (unwrapped)`,
      20,
      660,
    );
    const mismatches = (
      x: number,
      y: number,
      width: number,
      height: number,
    ) => {
      const actual = context.getImageData(x, y, width, height).data;
      const wanted = expected.getImageData(x, y, width, height).data;
      let different = 0;
      for (let channel = 0; channel < actual.length; channel++)
        if (Math.abs(actual[channel]! - wanted[channel]!) > 2) different++;
      return different;
    };
    const selectedJoints = [0, 1, 17, 25, 26, 27];
    const jointMismatches = selectedJoints.map((index) => {
      const y = 137 + index * 17.5;
      if (index % 2 === 0) {
        expected.fillStyle = "#0f1c2c";
        expected.fillRect(942, y - 13, 312, 17.5);
      }
      const quality = snapshot.quality[index]!;
      expected.fillStyle =
        !quality.valid || quality.origin === "missing" ? "#738092" : "#e5edf6";
      expected.textAlign = "right";
      const value = snapshot.joints[index]!;
      expected.fillText(
        !quality.valid || quality.origin === "missing"
          ? "—"
          : Math.abs(value) >= 10000
            ? value.toExponential(1)
            : value.toFixed(3),
        1093,
        y,
      );
      return mismatches(1020, Math.ceil(y - 13), 75, 16);
    });
    return {
      snapshot,
      stamp: { id, crc, expectedCrc, confident },
      sync: diagnostic.sync(),
      session: diagnostic.session(),
      source: diagnostic.source(),
      canvas: { width: canvas.width, height: canvas.height },
      robotPixelsHash,
      captureAgeMs: Date.now() - snapshot.captured_wall_s * 1000,
      visibleChassis: mismatches(20, 621, 780, 21),
      progressPixels: { filled, empty },
      visibleText: {
        time: mismatches(20, 593, 450, 24),
        source: mismatches(20, 644, 700, 22),
        joints: jointMismatches,
      },
    };
  }, expectedLayout);
}

export function assertPair(sample: PairSample, sid?: string): void {
  const { snapshot, stamp, sync, source } = sample;
  expect(sample.canvas).toEqual({ width: 1280, height: 1080 });
  expect(
    stamp.confident,
    "All 64 stamp pixels must have readable red/green contrast",
  ).toBe(true);
  expect(stamp.id).toBeGreaterThan(0);
  expect(stamp.id).toBeLessThanOrEqual(0xffffffff);
  expect(stamp.crc, "CRC over all 32 capture-ID bits").toBe(stamp.expectedCrc);
  expect(stamp.id, "Actual canvas identity must match selected metadata").toBe(
    snapshot.capture_id,
  );
  expect(
    snapshot.render_seq,
    "Mock render sequence must identify the same actual frame",
  ).toBe(stamp.id);
  expect(sync.lastCapture).toBe(stamp.id);
  expect(snapshot.session_id).toBe(sid ?? sample.session.sid);
  expect(snapshot.duration_s).toBe(12);
  expect(snapshot.progress).toBeCloseTo(snapshot.log_time_s / 12, 10);
  expect(snapshot.source_joints).toHaveLength(28);
  expect(snapshot.joints).toHaveLength(28);
  expect(snapshot.quality).toHaveLength(28);
  // Independent documented synthetic fixture oracle, using vendor bounds for
  // steering [-3.1416,3.1416], wheel winding, and gripper [0,.05].
  const t = snapshot.log_time_s;
  expect(snapshot.source_joints[0]).toBeCloseTo(
    6.2832 * 0.56 * Math.sin((t * Math.PI) / 6),
    10,
  );
  expect(snapshot.source_joints[1]).toBeCloseTo(-(2.4 * t + 0.1), 10);
  expect(snapshot.source_joints[17]).toBeCloseTo(
    0.025 + 0.05 * 0.56 * Math.sin((t * Math.PI) / 6 + 17 * 0.17),
    10,
  );
  expect(snapshot.joints[0]).toBeCloseTo(snapshot.source_joints[0]!, 10);
  expect(snapshot.joints[17]).toBeCloseTo(snapshot.source_joints[17]!, 10);
  expect(Math.sin(snapshot.joints[1]!)).toBeCloseTo(
    Math.sin(snapshot.source_joints[1]!),
    10,
  );
  expect(snapshot.joints[1]).toBeGreaterThanOrEqual(-Math.PI);
  expect(snapshot.joints[1]).toBeLessThan(Math.PI);
  expect(
    sample.progressPixels,
    "Canvas progress fill must correspond to the same snapshot",
  ).toEqual({ filled: true, empty: true });
  expect(
    sample.visibleText,
    "Actual canvas time, source angles, and six joint values must match the selected frame",
  ).toEqual({
    time: 0,
    source: 0,
    joints: [0, 0, 0, 0, 0, 0],
  });
  expect(sync.frames).toBeLessThanOrEqual(sync.capacity);
  expect(sync.snapshots).toBeLessThanOrEqual(sync.capacity);
  expect(sync.capacity).toBeLessThanOrEqual(128);
  if (source?.inFlight !== undefined)
    expect(source.inFlight).toBeLessThanOrEqual(4);
  if (source?.pending !== undefined)
    expect(source.pending).toBeLessThanOrEqual(32);
  if (source?.owned !== undefined) expect(source.owned).toBeLessThanOrEqual(84);
}

export function recordPair(
  evidence: BrowserEvidence,
  label: string,
  sample: PairSample,
): void {
  const { snapshot, ...rest } = sample;
  evidence.samples.push({
    label,
    ...rest,
    snapshot: {
      capture_id: snapshot.capture_id,
      captured_wall_s: snapshot.captured_wall_s,
      render_seq: snapshot.render_seq,
      session_id: snapshot.session_id,
      log_id: snapshot.log_id,
      control_seq: snapshot.control_seq,
      playback_epoch: snapshot.playback_epoch,
      state: snapshot.state,
      log_time_s: snapshot.log_time_s,
      source_sample_index: snapshot.source_sample_index,
      progress: snapshot.progress,
      speed: snapshot.speed,
      source_joints: snapshot.source_joints,
      joints: snapshot.joints,
      quality: snapshot.quality,
    },
  });
}

export async function waitPair(
  page: Page,
  predicate: (sample: PairSample) => boolean = () => true,
): Promise<PairSample> {
  let selected: PairSample | null = null;
  await expect
    .poll(
      async () => {
        selected = await readPair(page);
        if (selected) assertPair(selected);
        return selected !== null && predicate(selected);
      },
      { intervals: [25, 50, 100] },
    )
    .toBe(true);
  return selected!;
}

export async function collectPairs(
  page: Page,
  evidence: BrowserEvidence,
  label: string,
  count = 3,
): Promise<PairSample[]> {
  const samples: PairSample[] = [];
  for (let index = 0; index < count; index++) {
    const previous = samples.at(-1)?.snapshot.capture_id ?? -1;
    const sample = await waitPair(
      page,
      (candidate) => candidate.snapshot.capture_id > previous,
    );
    recordPair(evidence, label, sample);
    samples.push(sample);
    if (index + 1 < count) await page.waitForTimeout(65);
  }
  return samples;
}

export async function createReadySession(page: Page): Promise<string> {
  await page.getByTestId("create-session").click();
  await expect
    .poll(async () => (await diagnostics(page)).session.workerPhase)
    .toBe("ready");
  const state = await diagnostics(page);
  expect(state.session.sid).toBeTruthy();
  expect(state.snapshot).toBeNull();
  return state.session.sid!;
}

export async function loadDemo(page: Page): Promise<PairSample> {
  await page.getByTestId("demo-load").click();
  return waitPair(
    page,
    ({ snapshot }) => snapshot.state === "ready" && snapshot.log_time_s === 0,
  );
}

export async function seek(page: Page, time: number): Promise<PairSample> {
  const before = await diagnostics(page);
  await page.getByTestId("seek-input").fill(String(time));
  await page.getByTestId("seek-submit").click();
  return waitPair(
    page,
    ({ snapshot }) =>
      snapshot.log_time_s === time &&
      snapshot.control_seq > (before.snapshot?.control_seq ?? -1),
  );
}
