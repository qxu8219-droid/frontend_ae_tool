import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Schema } from '../domain/types';
import { useTelemetryStore } from './telemetry';

/** Keep rendering bounded while retaining all source records for selection and export. */
function historyPage<T>(items: readonly T[], requested: number) {
  const total = items.length, pageCount = Math.max(1, Math.ceil(total / 100));
  const page = Number.isFinite(requested) ? Math.max(1, Math.min(pageCount, Math.trunc(requested))) : 1;
  const offset = (page - 1) * 100;
  return { items: items.slice(offset, offset + 100), page, pageCount, total,
    start: total ? offset + 1 : 0, end: Math.min(total, offset + 100) };
}

export const useAnnotationStore = defineStore('annotations', () => {
  const sessionId = ref(''), logId = ref(''), loading = ref(false), error = ref('');
  const segmentPage = ref(1), eventPage = ref(1);
  const data = shallowRef<Schema['LogAnnotations'] | null>(null);
  const telemetry = useTelemetryStore();
  const currentData = computed(() => {
    const frame = telemetry.presented;
    return frame && frame.session_id === sessionId.value && frame.log_id === data.value?.log_id
      ? data.value : null;
  });
  const currentSegments = computed(() => {
    const value = currentData.value, time = telemetry.presented?.log_time_s;
    return value?.alignment === 'source_frames' && time !== undefined
      ? value.segments.filter(segment => segment.start_s <= time && time < segment.end_s)
      : [];
  });
  const segmentHistory = computed(() => historyPage(currentData.value?.segments ?? [], segmentPage.value));
  const eventHistory = computed(() => historyPage(currentData.value?.events ?? [], eventPage.value));
  function setSegmentPage(page: number) {
    segmentPage.value = historyPage(currentData.value?.segments ?? [], page).page;
  }
  function setEventPage(page: number) {
    eventPage.value = historyPage(currentData.value?.events ?? [], page).page;
  }
  function setContext(sid: string, lid: string) {
    if (sessionId.value !== sid || logId.value !== lid) {
      data.value = null; segmentPage.value = eventPage.value = 1;
    }
    sessionId.value = sid; logId.value = lid; error.value = '';
  }
  function reset() {
    sessionId.value = ''; logId.value = ''; data.value = null; loading.value = false; error.value = '';
    segmentPage.value = eventPage.value = 1;
  }
  return { sessionId, logId, data, loading, error, currentData, currentSegments, segmentHistory, eventHistory, setSegmentPage, setEventPage, setContext, reset };
});
