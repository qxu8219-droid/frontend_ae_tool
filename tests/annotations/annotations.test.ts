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

function longAnnotations(logId = 'l'): Schema['LogAnnotations'] {
  const value = annotations(logId);
  value.events = Array.from({ length: 256 }, (_, index) => ({ id: `event-${index + 1}`, time_s: null,
    kind: 'diagnostic', message: `Recorded event ${index + 1}`, details: {} }));
  value.segments = Array.from({ length: 256 }, (_, index) => ({ ...value.segments[0]!,
    id: `stage-${index + 1}`, label: `Stage ${index + 1}`, start_s: index, end_s: index + 1,
    start_frame: index, end_frame: index + 1 }));
  return value;
}

it('pages the complete event and stage histories through the last record without narrowing current-stage matching', async () => {
  const store = useAnnotationStore();
  await createAnnotationLoader({ annotations: async () => longAnnotations() }).load('s', 'l');
  present(255.5);
  expect(store.eventHistory.items).toHaveLength(100);
  expect(store.eventHistory.items[0]?.id).toBe('event-1');
  expect(store.eventHistory.items[99]?.id).toBe('event-100');
  expect(store.eventHistory.pageCount).toBe(3);
  expect(store.segmentHistory.items[0]?.id).toBe('stage-1');
  expect(store.currentSegments[0]?.id).toBe('stage-256');
  store.setEventPage(3); store.setSegmentPage(3);
  expect(store.eventHistory.items).toHaveLength(56);
  expect(store.eventHistory.items[0]?.id).toBe('event-201');
  expect(store.eventHistory.items[55]?.id).toBe('event-256');
  expect(store.segmentHistory.items[55]?.id).toBe('stage-256');
  expect(store.currentSegments[0]?.id).toBe('stage-256');
  expect(store.data?.events).toHaveLength(256);
});

it('bounds invalid page requests and shrinks pages when the presented source has fewer entries', async () => {
  const store = useAnnotationStore();
  await createAnnotationLoader({ annotations: async () => longAnnotations() }).load('s', 'l'); present(0);
  store.setEventPage(999); expect(store.eventHistory.page).toBe(3);
  store.setEventPage(-5); expect(store.eventHistory.page).toBe(1);
  store.setEventPage(2.9); expect(store.eventHistory.page).toBe(2);
  store.setEventPage(Number.NaN); expect(store.eventHistory.page).toBe(1);
  store.setSegmentPage(Number.POSITIVE_INFINITY); expect(store.segmentHistory.page).toBe(1);
  store.setSegmentPage(999); expect(store.segmentHistory.page).toBe(3);
  store.data = annotations();
  expect(store.segmentHistory.page).toBe(1);
  expect(store.segmentHistory.items).toHaveLength(2);
  expect(store.eventHistory).toMatchObject({ page: 1, pageCount: 1, items: [], start: 0, end: 0 });
});

it('resets both history pages for another session or log and keeps same-source reconnect pagination', async () => {
  const store = useAnnotationStore();
  const loader = createAnnotationLoader({ annotations: async (_s, lid) => longAnnotations(lid) });
  await loader.load('s', 'l'); present(0);
  store.setEventPage(3); store.setSegmentPage(2);
  await loader.load('s', 'l');
  expect(store.eventHistory.page).toBe(3); expect(store.segmentHistory.page).toBe(2);
  await loader.load('s', 'new'); present(0, 'new');
  expect(store.eventHistory.page).toBe(1); expect(store.segmentHistory.page).toBe(1);
  store.setEventPage(3); store.setSegmentPage(3);
  store.setContext('replacement-session', 'new');
  store.data = longAnnotations('new');
  const t = useTelemetryStore(); t.context('replacement-session', 1);
  t.accept({ ...example<FrameSnapshot>('protocol/FrameSnapshot'), session_id: 'replacement-session', log_id: 'new' }, 1);
  expect(store.eventHistory.page).toBe(1); expect(store.segmentHistory.page).toBe(1);
  store.setEventPage(3); store.reset();
  expect(store.eventHistory).toMatchObject({ page: 1, items: [] });
});
