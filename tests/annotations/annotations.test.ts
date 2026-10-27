import { beforeEach, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAnnotationStore } from '../../src/stores/annotations';
import { createAnnotationLoader } from '../../src/app/annotations';
import { useTelemetryStore } from '../../src/stores/telemetry';
import { example } from '../api/fixtures';
import { deferred } from '../history/fixtures';
import type { Schema, FrameSnapshot } from '../../src/domain/types';

function annotations(logId = 'l'): Schema['LogAnnotations'] {
  return { log_id: logId, source_id: 'episode', source_sha256: 'a'.repeat(64), alignment: 'source_frames',
    provisional: true, assumptions: ['temporary travel'], reference: {}, events: [], segments: [
      { id: 'first', start_s: 0, end_s: 1, start_frame: 0, end_frame: 10, label: 'grasp', review_status: 'pending_review', boundary_status: 'pending_review', training_approved: false, details: {} },
      { id: 'second', start_s: 1, end_s: 2, start_frame: 10, end_frame: 20, label: 'release', review_status: 'unknown', boundary_status: 'unknown', training_approved: null, details: {} },
    ] };
}
function present(time: number, logId = 'l', generation = 1) {
  const t = useTelemetryStore();
  t.context('s', generation);
  const frame = example<FrameSnapshot>('protocol/FrameSnapshot');
  t.accept({ ...frame, session_id: 's', log_id: logId, capture_id: t.count + 1, render_seq: t.count + 1, log_time_s: time }, generation);
}
beforeEach(() => setActivePinia(createPinia()));

it('selects stages only from presented log/time using half-open intervals', async () => {
  const store = useAnnotationStore();
  const loader = createAnnotationLoader({ annotations: async () => annotations() });
  await loader.load('s', 'l');
  expect(store.currentSegments).toEqual([]);
  present(.999);
  expect(store.currentSegments.map(segment => segment.id)).toEqual(['first']);
  expect(store.currentSegments[0]?.training_approved).toBe(false);
  present(1);
  expect(store.currentSegments.map(segment => segment.id)).toEqual(['second']);
  present(2);
  expect(store.currentSegments).toEqual([]);
  present(.2, 'other');
  expect(store.currentData).toBeNull();
});

it('ignores an old log response even if cancellation arrives too late', async () => {
  const old = deferred<Schema['LogAnnotations']>();
  let signal: AbortSignal | undefined;
  const loader = createAnnotationLoader({ annotations: async (_s, l, opts) => {
    if (l === 'old') { signal = opts?.signal; return old.promise; }
    return annotations(l);
  } });
  const pending = loader.load('s', 'old');
  await loader.load('s', 'new');
  present(.5, 'new');
  old.resolve(annotations('old'));
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(useAnnotationStore().currentData?.log_id).toBe('new');
  expect(useAnnotationStore().currentSegments[0]?.id).toBe('first');
});

it('reconnection preserves the displayed position while superseding stale queries', async () => {
  const old = deferred<Schema['LogAnnotations']>();
  let calls = 0;
  const loader = createAnnotationLoader({ annotations: async () => ++calls === 1 ? old.promise : annotations() });
  const pending = loader.load('s', 'l');
  present(.5);
  useTelemetryStore().context('s', 2);
  await loader.load('s', 'l');
  old.resolve({ ...annotations(), assumptions: ['obsolete'] });
  await pending;
  expect(useAnnotationStore().currentSegments[0]?.id).toBe('first');
  expect(useAnnotationStore().currentData?.assumptions).toEqual(['temporary travel']);
});

it('keeps reference-only material distinct and handles missing older client capability', async () => {
  const loader = createAnnotationLoader({ annotations: async () => ({ ...annotations(), alignment: 'reference_only', segments: [], reference: { source: 'earlier run' } }) });
  await loader.load('s', 'l'); present(.5);
  expect(useAnnotationStore().currentData?.alignment).toBe('reference_only');
  expect(useAnnotationStore().currentSegments).toEqual([]);
  await createAnnotationLoader({}).load('s', 'unsupported');
  expect(useAnnotationStore().error).toContain('标注');
});

it('does not revive cleared state or accept another log identity', async () => {
  const pending = deferred<Schema['LogAnnotations']>();
  const loader = createAnnotationLoader({ annotations: async () => pending.promise });
  const work = loader.load('s', 'l'); loader.cancel(); useAnnotationStore().reset();
  pending.resolve(annotations()); await work;
  expect(useAnnotationStore().data).toBeNull();
  await createAnnotationLoader({ annotations: async () => annotations('wrong') }).load('s', 'l');
  expect(useAnnotationStore().data).toBeNull();
  expect(useAnnotationStore().error).toContain('日志');
});
