<script setup lang="ts">
import { computed } from 'vue';
import { useAnnotationStore } from '../stores/annotations';
import { useTelemetryStore } from '../stores/telemetry';
const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ seek: [time: number] }>();
const store = useAnnotationStore(), telemetry = useTelemetryStore();
const data = computed(() => store.currentData);
const review = (value: string) => value === 'pending_review' ? 'pending_review · 待审核' : value;
const training = (value: boolean | null | undefined) => value === false
  ? 'training_approved=false · 未批准训练使用'
  : value === true ? 'training_approved=true · 源记录批准' : 'training_approved 未知';
function seek(time: number | null) {
  const frame = telemetry.presented;
  if (!props.disabled && data.value && frame && time !== null && time <= frame.duration_s) emit('seek', time);
}
</script>

<template>
  <section class="card annotation-panel" aria-labelledby="annotation-heading" data-testid="annotation-panel">
    <div class="annotation-heading">
      <h3 id="annotation-heading">标注与来源</h3>
      <span v-if="data">已呈现 {{ telemetry.presented?.log_time_s.toFixed(3) }} s</span>
    </div>
    <p v-if="store.loading" role="status" class="subtle">正在读取标注…</p>
    <p v-if="store.error" class="upload-error">标注不可用：{{ store.error }}</p>
    <p v-if="!data" class="subtle">等待对应日志画面；当前阶段只按已呈现时刻选择。</p>
    <template v-else>
      <p class="annotation-source">来源 {{ data.source_id ?? '未提供' }} · {{ data.alignment }}</p>
      <details v-if="data.source_sha256" class="annotation-source">
        <summary>来源 SHA256</summary><code>{{ data.source_sha256 }}</code>
      </details>
      <div v-if="data.provisional || data.assumptions.length" class="annotation-assumptions" data-testid="annotation-assumptions">
        <strong>{{ data.provisional ? '暂定假设 · 尚非精确标定' : '转换假设' }}</strong>
        <ul><li v-for="(item, index) in data.assumptions" :key="index">{{ item }}</li></ul>
      </div>
      <div v-if="data.alignment === 'reference_only'" data-testid="annotation-reference">
        <p>仅供历史来源参考：未对齐当前运行，不能映射为当前阶段或定位时间。</p>
        <details><summary>参考来源记录</summary><pre>{{ JSON.stringify(data.reference, null, 2) }}</pre></details>
      </div>
      <template v-else-if="data.alignment === 'source_frames'">
        <h4>当前标注阶段 · 源记录</h4>
        <p v-if="!store.currentSegments.length" class="subtle">此已呈现时刻没有对应阶段。</p>
        <article v-for="segment in store.currentSegments" :key="segment.id" class="annotation-segment" data-testid="annotation-current-segment">
          <strong>{{ segment.label }}</strong>
          <span>[{{ segment.start_s.toFixed(3) }}, {{ segment.end_s.toFixed(3) }}) s · 帧 [{{ segment.start_frame }}, {{ segment.end_frame }})</span>
          <span>审核：{{ review(segment.review_status ?? 'unknown') }} · 边界：{{ review(segment.boundary_status ?? 'unknown') }}</span>
          <span>{{ training(segment.training_approved) }}</span>
        </article>
        <details v-if="data.segments.length" class="annotation-history">
          <summary>全部历史阶段 · {{ data.segments.length }}（半开区间）</summary>
          <ol :start="store.segmentHistory.start"><li v-for="segment in store.segmentHistory.items" :key="segment.id">
            <button :disabled="disabled" @click="seek(segment.start_s)">{{ segment.start_s.toFixed(3) }} s · {{ segment.label }}</button>
            <span>{{ review(segment.review_status ?? 'unknown') }} · {{ training(segment.training_approved) }}</span>
          </li></ol>
          <nav v-if="store.segmentHistory.pageCount > 1" aria-label="历史阶段分页">
            <button type="button" :disabled="store.segmentHistory.page === 1" @click="store.setSegmentPage(store.segmentHistory.page - 1)">上一页</button>
            <span>{{ store.segmentHistory.start }}–{{ store.segmentHistory.end }} / {{ store.segmentHistory.total }} · 第 {{ store.segmentHistory.page }} / {{ store.segmentHistory.pageCount }} 页</span>
            <button type="button" :disabled="store.segmentHistory.page === store.segmentHistory.pageCount" @click="store.setSegmentPage(store.segmentHistory.page + 1)">下一页</button>
          </nav>
        </details>
      </template>
      <p v-else class="subtle">此日志没有对齐到源帧的阶段标注。</p>
      <details v-if="data.events.length" class="annotation-history">
        <summary>历史事件 · {{ data.events.length }} · 诊断记录，不代表当前状态</summary>
        <ol :start="store.eventHistory.start"><li v-for="event in store.eventHistory.items" :key="event.id">
          <button :disabled="disabled || event.time_s === null" @click="seek(event.time_s)">
            {{ event.time_s === null ? '无法对齐 · 不可定位' : `${event.time_s.toFixed(3)} s` }} · {{ event.kind }}
          </button>
          <span>{{ event.message }}</span>
          <details v-if="Object.keys(event.details ?? {}).length"><summary>源事件详情</summary><pre>{{ JSON.stringify(event.details, null, 2) }}</pre></details>
        </li></ol>
        <nav v-if="store.eventHistory.pageCount > 1" aria-label="历史事件分页">
          <button type="button" :disabled="store.eventHistory.page === 1" @click="store.setEventPage(store.eventHistory.page - 1)">上一页</button>
          <span>{{ store.eventHistory.start }}–{{ store.eventHistory.end }} / {{ store.eventHistory.total }} · 第 {{ store.eventHistory.page }} / {{ store.eventHistory.pageCount }} 页</span>
          <button type="button" :disabled="store.eventHistory.page === store.eventHistory.pageCount" @click="store.setEventPage(store.eventHistory.page + 1)">下一页</button>
        </nav>
      </details>
    </template>
  </section>
</template>

<style scoped>
.annotation-panel { padding: 20px; }
.annotation-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.annotation-heading span, .annotation-source { color: #637b92; font-size: 12px; }
.annotation-source code, pre { overflow-wrap: anywhere; white-space: pre-wrap; }
.annotation-assumptions { margin: 14px 0; padding: 12px 14px; border-left: 3px solid #f2bd63; background: #fff8eb; color: #805c24; }
.annotation-assumptions ul { margin-bottom: 0; padding-left: 20px; }
.annotation-segment { display: grid; gap: 5px; border: 1px solid #d7e2ec; border-radius: 8px; padding: 12px; margin: 10px 0; }
.annotation-segment span, .annotation-history span { font-size: 12px; color: #637b92; }
.annotation-history { margin-top: 14px; }
.annotation-history li { margin: 10px 0; }
.annotation-history li > span { display: block; margin-top: 4px; }
.annotation-history button { border: 1px solid #d7e2ec; background: #f3f7fb; color: #356fad; border-radius: 5px; padding: 5px 8px; cursor: pointer; }
.annotation-history button:disabled { cursor: default; opacity: .6; }
summary { cursor: pointer; }
</style>
