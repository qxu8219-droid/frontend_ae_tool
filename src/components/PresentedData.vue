<script setup lang="ts">
import { computed } from 'vue';
import type { FrameSnapshot, JointMetadata } from '../domain/types';
import { chassisPanelAxes, jointPanelGroups, type LimitState } from '../media/panelModel';

const props = defineProps<{ snapshot: FrameSnapshot | null; metadata: JointMetadata | null }>();
const rows = computed(() => props.snapshot ? jointPanelGroups(props.snapshot, props.metadata).flatMap(group => group.rows) : []);
const chassis = computed(() => props.snapshot ? chassisPanelAxes(props.snapshot) : []);
const limitLabels: Record<LimitState, string> = {
  unavailable: '不可用', unlimited: '无限位', unknown: '限位未知', unassessed: '未评估',
  normal: '正常', warning: '临界', exceeded: '越限',
};
</script>

<template>
  <details class="presented-data">
    <summary data-testid="presented-data-toggle">查看当前画面的完整数据</summary>
    <p v-if="!snapshot">等待图像与数据共同呈现。</p>
    <template v-else>
      <p data-testid="presented-data-time">已呈现日志时间 {{ snapshot.log_time_s.toFixed(3) }} s · 日志 {{ snapshot.log_id }}</p>
      <table>
        <caption>同帧 28 个关节的完整名称与状态</caption>
        <thead><tr><th scope="col">关节</th><th scope="col">数值</th><th scope="col">单位</th><th scope="col">来源与处理</th><th scope="col">限位状态</th></tr></thead>
        <tbody><tr v-for="row in rows" :key="row.index" data-testid="presented-joint-row"><th scope="row">{{ row.name }}</th><td>{{ row.valueText }}</td><td>{{ row.unit }}</td><td>{{ row.quality.text }}</td><td>{{ limitLabels[row.limitState] }}</td></tr></tbody>
      </table>
      <div data-testid="presented-chassis"><h4>底盘位姿</h4><ul><li v-for="axis in chassis" :key="axis.axis">{{ axis.axis }}：{{ axis.valueText }} {{ axis.unit }} · {{ axis.qualityText }}</li></ul></div>
    </template>
  </details>
</template>

<style scoped>
.presented-data { padding: 10px 16px; border-top: 1px solid #e0e7ef; }
summary { color: #356fad; cursor: pointer; }
table { width: 100%; border-collapse: collapse; text-align: left; }
caption { text-align: left; font-weight: 600; margin: 8px 0; }
th, td { padding: 5px 8px; border-bottom: 1px solid #e0e7ef; }
tbody tr:nth-child(odd) { background: #f5f8fb; }
</style>
