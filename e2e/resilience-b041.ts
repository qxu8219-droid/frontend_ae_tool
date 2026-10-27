import assert from 'node:assert/strict';
import type { PairSample } from './oracle';

// Only file-format contracts are shared: no application adapter, transform,
// protocol decoder or renderer is imported by the numeric oracle.
interface SourceQuality { valid: boolean; source_time: string | null; age_s: number | null; timing: string }
interface SourceSample { time: string; row: number; frame_index: number | null; state: number[] | null; state_quality: SourceQuality[] | null }
interface Segment { id: string; start_frame: number; end_frame: number; label: string; boundary_status: string | null; review_status: string | null; training_approved: boolean | null }
export interface Bundle {
  schema: string;
  source: { id: string; format: string; time_unit: 'ns' | 's'; sha256: string; base_locked: boolean | null };
  samples: SourceSample[];
  annotations: { alignment: string; segments: Segment[]; reference: Record<string, unknown> };
  events: Array<{ time: string | null; kind: string }>;
}
interface Gripper { native_closed: number; native_open: number; zero1_m: number; zero2_m: number; travel1_m: number; travel2_m: number }
export interface Profile {
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

export function sourceOracle(bundle: Bundle, profile: Profile) {
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

export function checkB041Pair(sample: PairSample, current: ReturnType<typeof sourceOracle>, sid: string, activeLogId: string) {
    const frame = sample.snapshot, wanted = current.expected(frame.log_time_s);
    assert.equal(sample.stamp.confident, true); assert.equal(sample.stamp.crc, sample.stamp.expectedCrc);
    assert.equal(sample.stamp.id, frame.capture_id); assert.equal(frame.render_seq, frame.capture_id); assert.equal(sample.sync.lastCapture, frame.capture_id);
    assert.equal(frame.session_id, sid); assert.equal(frame.log_id, activeLogId);
    closeTo(frame.duration_s, current.duration, 9); closeTo(frame.progress, frame.log_time_s / current.duration, 10);
    assert.deepEqual(sample.visibleText, { time: 0, source: 0, joints: [0, 0, 0, 0, 0, 0] });
    assert.equal(sample.visibleChassis, 0); assert.deepEqual(sample.progressPixels, { filled: true, empty: true });
    assert.equal(frame.source_joints.length, 28);
    frame.source_joints.forEach((value, index) => {
      closeTo(value, wanted.values[index], 8, `native-derived canonical joint ${index}`);
      assert(Math.abs(frame.joints[index] - value) < 1e-5);
      const actual = frame.quality[index] as DetailedQuality, quality = wanted.qualities[index];
      assert.equal(actual.origin, quality.origin); assert.equal(actual.valid, quality.valid);
      assert.deepEqual(actual.source_indices, quality.sourceIndices);
      if (quality.interpolated) assert(actual.processing?.includes('interpolated'));
      if (quality.held) assert(actual.processing?.includes('forward_filled'));
      if (quality.origin === 'derived' && quality.valid) assert.match(actual.method!, /^b041\.provisional\./);
    });
    if (wanted.chassis) {
      assert.notEqual(frame.chassis, null); assert.equal(frame.chassis?.quality?.length, 3);
      (['x', 'y', 'yaw'] as const).forEach((axis, index) => {
        closeTo(frame.chassis![axis], wanted.chassis![index], 5);
        const quality = frame.chassis!.quality![index] as DetailedQuality;
        assert.equal(quality.origin, 'derived'); assert.equal(quality.valid, true); assert.match(quality.method!, /^b041\.provisional\./);
        assert.deepEqual(quality.source_indices, wanted.left === wanted.right ? [wanted.left] : [wanted.left, wanted.right]);
      });
    } else assert.equal(frame.chassis, null);
    assert(sample.sync.frames <= 48); assert(sample.sync.snapshots <= 48);
    assert((sample.source?.owned ?? 0) <= 4);
  }

/** Same strict half-unit decimal tolerance as Playwright/Jest toBeCloseTo. */
function closeTo(actual: number, expected: number, digits: number, label = 'numeric oracle') {
  const sameInfinity = actual === expected && !Number.isFinite(actual);
  assert(sameInfinity || Math.abs(actual - expected) < 0.5 * 10 ** -digits,
    `${label}: ${actual} differs from ${expected} at ${digits} decimal places`);
}
