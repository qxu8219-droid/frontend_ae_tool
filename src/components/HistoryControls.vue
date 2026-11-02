<script setup lang="ts">
import { useHistoryStore } from "../stores/history";
const history = useHistoryStore();
defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ selectionChanged: []; seek: [time: number] }>();
</script>
<template>
  <section class="history-controls" aria-label="历史曲线与事件">
    <h2>曲线与事件</h2>
    <p>
      曲线为完整日志历史；当前时间游标随实际画面更新。黄色区间接近限位，红色区间超限。
    </p>
    <p v-if="history.loading" role="status">正在加载历史数据…</p>
    <p v-else-if="history.error" role="alert">{{ history.error }}</p>
    <p v-else-if="!history.logId">激活日志后可查看曲线和预扫描限位事件。</p>
    <p v-else>
      缺失或无效样本显示断点；推导通道按来源标注，连续关节保留展开角。
    </p>
    <div class="event-filters">
      <label
        >事件范围<select v-model="history.view" data-testid="event-view">
          <option value="history">预扫描限位历史</option>
          <option value="triggered">本轮播放已触发</option>
        </select></label
      >
      <label
        >级别<select v-model="history.severity" data-testid="severity-filter">
          <option value="all">全部</option>
          <option value="info">信息</option>
          <option value="warning">警告</option>
          <option value="error">错误</option>
        </select></label
      >
    </div>
    <p>
      {{
        history.view === "history"
          ? "预扫描事件可定位到尚未播放的区间，不代表当前画面告警。"
          : "仅展示实际画面已到达的本轮事件；重新定位后按新播放轮次重新触发。"
      }}
    </p>
    <ul data-testid="history-events" class="event-list">
      <li
        v-for="event in history.filteredEvents"
        :key="event.id"
        :data-severity="event.severity"
      >
        <button
          type="button"
          :disabled="disabled"
          @click="emit('seek', event.time_s)"
        >
          {{ event.time_s.toFixed(3) }} s · {{ event.channel }} ·
          {{
            event.severity === "error"
              ? "错误"
              : event.severity === "warning"
                ? "警告"
                : "信息"
          }}</button
        ><span>{{ event.message }}</span>
      </li>
      <li v-if="!history.filteredEvents.length">当前筛选下暂无事件。</li>
    </ul>
  </section>
</template>
<style scoped>
.history-controls {
  display: grid;
  gap: 8px;
}
.history-controls h2 {
  margin: 0;
  font-size: 15px;
}
.history-controls p {
  font-size: 12px;
  color: #637b92;
  margin: 0;
  line-height: 1.5;
}
.history-controls label {
  display: grid;
  gap: 5px;
  font-size: 12px;
}
.history-controls select {
  background: #f3f7fb;
  border: 1px solid #cbd9e6;
  border-radius: 5px;
  color: #24364a;
  padding: 6px;
  min-width: 0;
}
.history-controls select[multiple] {
  height: 125px;
  width: 100%;
}
.event-filters {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.event-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 260px;
  overflow: auto;
  display: grid;
  gap: 6px;
}
.event-list li {
  padding: 6px;
  border-left: 2px solid #71849a;
  background: #f3f7fb;
  font-size: 11px;
}
.event-list li[data-severity="error"] {
  border-color: #f46270;
}
.event-list li[data-severity="warning"] {
  border-color: #f6be53;
}
.event-list button {
  display: block;
  border: 0;
  background: transparent;
  color: #356fad;
  text-align: left;
  padding: 0 0 4px;
  cursor: pointer;
  font-size: 11px;
}
.event-list span {
  color: #58718a;
  overflow-wrap: anywhere;
}
</style>
