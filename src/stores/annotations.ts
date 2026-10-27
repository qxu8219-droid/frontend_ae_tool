import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { Schema } from '../domain/types';
import { useTelemetryStore } from './telemetry';

export const useAnnotationStore = defineStore('annotations', () => {
  const sessionId = ref(''), logId = ref(''), loading = ref(false), error = ref('');
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
  function setContext(sid: string, lid: string) {
    if (sessionId.value !== sid || logId.value !== lid) data.value = null;
    sessionId.value = sid; logId.value = lid; error.value = '';
  }
  function reset() {
    sessionId.value = ''; logId.value = ''; data.value = null; loading.value = false; error.value = '';
  }
  return { sessionId, logId, data, loading, error, currentData, currentSegments, setContext, reset };
});
