<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { createSeekScheduler } from "../app/timeline";

const props = defineProps<{
  duration: number;
  presentedTime: number;
  disabled: boolean;
  context: string;
}>();
const emit = defineEmits<{ seek: [time: number] }>();
const duration = computed(() =>
  Number.isFinite(props.duration) ? Math.max(0, props.duration) : 0,
);
const clamp = (time: number) =>
  Math.min(duration.value, Math.max(0, Number.isFinite(time) ? time : 0));
const previewTime = ref(clamp(props.presentedTime));
const editing = ref(false);
const scheduler = createSeekScheduler((time) => emit("seek", time));

function input(event: Event) {
  if (props.disabled) return;
  // A new gesture can seek to a previously submitted target again after playback moved.
  if (!editing.value) scheduler.cancel();
  editing.value = true;
  previewTime.value = clamp(Number((event.target as HTMLInputElement).value));
  scheduler.request(previewTime.value);
}
function finish() {
  if (props.disabled || !editing.value) return;
  scheduler.flush(previewTime.value);
  editing.value = false;
}
function cancel() {
  scheduler.cancel();
  editing.value = false;
  previewTime.value = clamp(props.presentedTime);
}
watch(
  () => props.presentedTime,
  (time) => {
    if (!editing.value) previewTime.value = clamp(time);
  },
);
watch(() => props.context, cancel, { flush: "sync" });
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) cancel();
  },
);
watch(duration, () => {
  if (!editing.value) previewTime.value = clamp(props.presentedTime);
});
onBeforeUnmount(() => scheduler.dispose());
</script>

<template>
  <div class="timeline timeline-control">
    <input
      data-testid="timeline"
      aria-label="回放时间轴"
      type="range"
      min="0"
      :max="duration"
      step="0.001"
      :value="previewTime"
      :disabled="disabled || duration <= 0"
      :aria-valuetext="`定位预览 ${previewTime.toFixed(3)} 秒，共 ${duration.toFixed(3)} 秒`"
      @input="input"
      @change="finish"
      @pointerup="finish"
      @pointercancel="cancel"
      @blur="finish"
    />
    <span class="timeline-caption"
      ><span>定位预览</span>
      <b data-testid="preview-time">{{ previewTime.toFixed(3) }} s</b
      ><span class="timeline-duration">
        / {{ duration.toFixed(3) }} s</span
      ></span
    >
  </div>
</template>

<style scoped>
.timeline-control {
  display: flex;
  align-items: center;
  gap: 16px;
}
.timeline-control input {
  min-width: 0;
  flex: 1;
  cursor: pointer;
  accent-color: #59d5cf;
}
.timeline-control input:disabled {
  cursor: default;
}
.timeline-caption {
  white-space: nowrap;
  font-size: 12px;
  color: #95a9bb;
}
.timeline-caption b {
  color: #d7e4ed;
  font-variant-numeric: tabular-nums;
}
.timeline-duration {
  color: #72899c;
}
@media (max-width: 760px) {
  .timeline-control {
    flex-wrap: wrap;
    gap: 8px;
  }
  .timeline-control input {
    flex-basis: 100%;
  }
}
</style>
