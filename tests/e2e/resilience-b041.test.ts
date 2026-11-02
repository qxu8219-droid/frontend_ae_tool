import { describe, expect, it } from 'vitest';
import { checkB041Pair, sourceOracle, type Bundle, type Profile } from '../../e2e/resilience-b041';
import type { PairSample } from '../../e2e/oracle';

const gripper = { native_closed: 0, native_open: 100, zero1_m: 0, zero2_m: 0, travel1_m: .05, travel2_m: -.05 };
const profile: Profile = { b041: { basis: 'state', status: 'provisional', left_gripper: gripper, right_gripper: gripper,
  max_source_age_s: .2, max_interpolation_gap_s: .25,
  chassis: { mode: 'auto', velocity_frame: 'body', initial_pose: [0, 0, 0], velocity_scale: [1, 1, 1], velocity_bias: [0, 0, 0], max_gap_s: .2 } } };
const bundle: Bundle = { schema: 'b041.recording.v1', source: { id: 'fixture', format: 'full23_parquet', time_unit: 'ns', sha256: 'fixture', base_locked: false },
  annotations: { alignment: 'exact', segments: [], reference: {} }, events: [],
  samples: [0, 50_000_000, 100_000_000].map((time, row) => ({ time: String(time), row, frame_index: row,
    state: Array.from({ length: 23 }, (_, index) => index / 100 + row / 100),
    state_quality: Array.from({ length: 6 }, () => ({ valid: true, source_time: String(time), age_s: 0, timing: 'original' })) })) };
const oracle = sourceOracle(bundle, profile);
function fixture(): PairSample {
  const wanted = oracle.expected(.025);
  return {
    snapshot: { capture_id: 12, captured_wall_s: 1000, render_seq: 12, session_id: 'sid', log_id: 'log', control_seq: 1,
      playback_epoch: 1, target_seq: 1, log_time_s: .025, duration_s: .1, progress: .25, speed: 1, state: 'playing',
      source_joints: [...wanted.values], joints: [...wanted.values],
      quality: wanted.qualities.map(value => ({ origin: value.origin, valid: value.valid,
        source_indices: value.sourceIndices, processing: value.interpolated ? ['interpolated'] : [], method: 'b041.provisional.fixture' })),
      chassis: { x: wanted.chassis![0], y: wanted.chassis![1], yaw: wanted.chassis![2],
        quality: [0, 1, 2].map(() => ({ origin: 'derived', valid: true, method: 'b041.provisional.fixture', source_indices: [0, 1] })) } },
    stamp: { confident: true, id: 12, crc: 23, expectedCrc: 23 },
    sync: { frames: 0, snapshots: 0, capacity: 48, presented: 12, lastCapture: 12 },
    session: { sid: 'sid', workerPhase: 'ready', wsGeneration: 1, wsState: 'open', mode: 'real' },
    source: { owned: 1 }, canvas: { width: 1280, height: 1080 }, robotPixelsHash: 1, captureAgeMs: 100,
    progressPixels: { filled: true, empty: true }, visibleText: { time: 0, source: 0, joints: [0, 0, 0, 0, 0, 0] }, visibleChassis: 0,
  };
}
describe('non-instrumented B041 validation oracle retains all rejection gates', () => {
  it('accepts a valid independently constructed source/pixel sample', () => {
    expect(() => checkB041Pair(fixture(), oracle, 'sid', 'log')).not.toThrow();
  });
  const mutations: Array<[string, (sample: PairSample) => void]> = [
    ['capture ID', sample => { sample.stamp.id++; }],
    ['CRC', sample => { sample.stamp.crc++; }],
    ['source value', sample => { sample.snapshot.source_joints[10] += 1e-7; }],
    ['SDK readback', sample => { sample.snapshot.joints[10] += 1e-4; }],
    ['quality origin', sample => { sample.snapshot.quality[10].origin = 'commanded'; }],
    ['quality validity', sample => { sample.snapshot.quality[10].valid = false; }],
    ['quality indices', sample => { (sample.snapshot.quality[10] as any).source_indices = [1]; }],
    ['interpolation provenance', sample => { (sample.snapshot.quality[10] as any).processing = []; }],
    ['derived method', sample => { (sample.snapshot.quality[17] as any).method = 'measured'; }],
    ['visible text', sample => { sample.visibleText.time = 1; }],
    ['visible joint text', sample => { sample.visibleText.joints[2] = 1; }],
    ['chassis value', sample => { sample.snapshot.chassis!.x += 1e-4; }],
    ['visible chassis', sample => { sample.visibleChassis = 1; }],
    ['progress pixels', sample => { sample.progressPixels.filled = false; }],
    ['buffer bound', sample => { sample.sync.frames = 49; }],
  ];
  it.each(mutations)('rejects corrupted %s', (_name, mutate) => {
    const sample = fixture(); mutate(sample);
    expect(() => checkB041Pair(sample, oracle, 'sid', 'log')).toThrow();
  });
  it('retains the strict half-unit tolerance for source values', () => {
    const below = fixture(); below.snapshot.source_joints[0] = 4.999e-9;
    expect(() => checkB041Pair(below, oracle, 'sid', 'log')).not.toThrow();
    const boundary = fixture(); boundary.snapshot.source_joints[0] = 5e-9;
    expect(() => checkB041Pair(boundary, oracle, 'sid', 'log')).toThrow();
  });
});
