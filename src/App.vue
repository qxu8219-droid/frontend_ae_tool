<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NConfigProvider, NButton, NTag, NAlert, NDrawer, NDrawerContent, NModal } from "naive-ui";
import { createWorkbenchController, type MockBridge } from "./app/controller";
import { useSessionStore } from "./stores/session";
import { usePlaybackStore } from "./stores/playback";
import { useTelemetryStore } from "./stores/telemetry";
import { useUiStore } from "./stores/ui";
import { SCENARIOS, type ScenarioId } from "./domain/types";
import { PRESENTATION_GROUP_RECTS, PRESENTATION_WIDTH, PRESENTATION_HEIGHT } from "./media/renderer";
import LogDetailsPanel from "./components/LogDetailsPanel.vue";
import PresentedData from "./components/PresentedData.vue";
import UploadPanel from "./components/UploadPanel.vue";
import TimelineControl from "./components/TimelineControl.vue";
import HistoryControls from "./components/HistoryControls.vue";
import AnnotationPanel from "./components/AnnotationPanel.vue";
import { useAnnotationStore } from "./stores/annotations";
import { useHistoryStore } from "./stores/history";
import { createHistoryChart } from "./media/historyChart";
const history = useHistoryStore();
const annotations = useAnnotationStore();
const chart = createHistoryChart();

const props = defineProps<{ runtime?: MockBridge }>();
const session = useSessionStore(),
  playback = usePlaybackStore(),
  telemetry = useTelemetryStore(),
  ui = useUiStore();
const canvas = ref<HTMLCanvasElement | null>(null);
const controller = createWorkbenchController({
  runtime: props.runtime,
  getCanvas: () => canvas.value,
  getPresentation: () => ({
    collapsedGroups: ui.collapsedGroups,
    historyCanvas: chart.getCanvas(),
    historyLogId: chart.getState().logId,
    historyRange: chart.getState().ready
      ? { from: chart.getState().from, to: chart.getState().to }
      : undefined,
  }),
});
const importOpen = ref(false), detailsOpen = ref(false), closeOpen = ref(false), seekOpen = ref(false), channelOpen = ref(false), healthOpen = ref(false), annotationOpen = ref(false);
const analysisTab = ref<"stages" | "limits" | "activity">("stages");
const seekMode = ref<"time" | "frame">("time"), seekText = ref<string | number>("0"), channelDraft = ref<string[]>([]);
const activeDetails = computed(() => playback.getLogDetails(session.sid ?? "", playback.server?.log_id));
const displayedDetails = computed(() => playback.getLogDetails(session.sid ?? "", telemetry.presented?.log_id));
const candidateDetails = computed(() => playback.getLogDetails(session.sid ?? "", playback.uploaded?.log_id));
const seekValid = computed(() => String(seekText.value).trim() !== "" && Number.isFinite(Number(seekText.value)) && Number(seekText.value) >= 0 && (seekMode.value === "time" || Number.isInteger(Number(seekText.value))));
function submitSeek() { if (!canControl.value || busy.value || !seekValid.value) return; void controller.control("seek", seekMode.value === "time" ? {time_s: Number(seekText.value)} : {frame_index: Number(seekText.value)}); seekOpen.value = false; }
function openChannels() { channelDraft.value = [...history.selected]; channelOpen.value = true; }
function applyChannels() { history.setSelected(channelDraft.value); channelOpen.value = false; }
const chartError = ref<string | null>(null),
  now = ref(Date.now());
const ready = computed(() => session.workerPhase === "ready");
const loaded = computed(
  () => !!playback.server?.log_id && playback.server.state !== "error",
);
const pending = computed(
  () =>
    session.waitingForControl ||
    !!playback.server &&
    playback.server.control_seq > (telemetry.presented?.control_seq ?? -1),
);
const displayed = computed(() => telemetry.presented);
const pendingText = computed(() => {
  if (session.waitingForControl) return '正在提交操作，图像与数据共同保持';
  const state = playback.server;
  if (state?.rendered_identity?.control_seq === state?.control_seq) return '仿真已渲染，等待同帧画面与数据共同呈现';
  if (state?.target_position && state.applied_position && state.applied_position.target_seq >= state.target_position.target_seq)
    return '仿真已应用目标，等待同帧画面与数据共同呈现';
  return '操作已接受，等待仿真应用目标与同帧画面';
});
const busy = computed(() => ui.busy > 0);
const phaseNames: Record<string, string> = {
  disconnected: "未创建",
  booting: "启动中",
  loading_scene: "加载场景",
  loading_robot: "加载机器人",
  rtsp_publishing: "准备画面",
  ready: "已就绪",
  error: "已故障",
  stopped: "已停止",
};
const statusText = computed(() =>
  session.workerPhase === "error"
    ? "故障 · 共同保持"
    : !displayed.value
      ? "等待首帧"
      : session.socket.state !== "open"
        ? "连接重建中"
        : session.syncState === 'stalled'
          ? '媒体中断 · 共同保持'
        : pending.value
          ? '等待目标画面'
        : now.value - telemetry.wallMs > 1000
          ? "等待配对"
          : "同步呈现",
);
const latency = computed(() =>
  displayed.value
    ? Math.max(0, telemetry.wallMs - displayed.value.captured_wall_s * 1000)
    : null,
);
const scenarioHelp: Record<ScenarioId, string> = {
  normal: "正常合成轨迹；图像与对应数据一起呈现。",
  "no-log": "清空当前激活日志，载入前不可播放。",
  "parse-error": "下一次载入日志将返回解析错误。",
  "missing-channels": "重新载入示例日志，查看缺失通道和补值标记。",
  "worker-error": "关闭故障会话，重新创建并从起点载入日志。",
  "video-delay": "画面额外迟到 650 ms，图像与面板仍按同一帧呈现。",
  "data-delay": "数据额外迟到 650 ms，匹配前共同保持画面。",
  "ws-reconnect": "中断并重建数据连接，恢复后继续当前播放进度。",
};
const themeOverrides = {
  common: {
    primaryColor: "#356fad",
    primaryColorHover: "#528ac1",
    primaryColorPressed: "#245789",
    borderRadius: "8px",
    fontFamily: 'Inter, "Noto Sans CJK SC", system-ui, sans-serif',
  },
};
let timer: ReturnType<typeof setInterval> | undefined;
watch([() => history.curve, () => [...history.selected]], async () => {
  chartError.value = null;
  await chart.update(history.curve, history.selected);
  chartError.value = chart.getState().error;
});
const canControl = computed(
  () => loaded.value && ready.value && session.socket.state === "open",
);
const canPlay = computed(
  () => canControl.value && !busy.value && playback.server?.state !== "playing",
);
const canPause = computed(
  () => canControl.value && !busy.value && playback.server?.state === "playing",
);
const stagePreview = computed(() => {
  const data = annotations.currentData;
  if (!data || data.alignment !== 'source_frames') return [];
  const time = displayed.value?.log_time_s ?? 0;
  const nearest: { segment: typeof data.segments[number]; index: number; distance: number }[] = [];
  data.segments.forEach((segment, index) => {
    const distance = segment.start_s <= time && time < segment.end_s
      ? 0 : Math.min(Math.abs(segment.start_s - time), Math.abs(segment.end_s - time));
    nearest.push({ segment, index, distance });
    nearest.sort((a, b) => a.distance - b.distance || a.index - b.index);
    if (nearest.length > 8) nearest.pop();
  });
  return nearest.sort((a, b) => a.index - b.index).map(item => item.segment);
});
const groups = [
  { id: "left", label: "左臂与夹爪 · 9" },
  { id: "right", label: "右臂与夹爪 · 9" },
  { id: "torso", label: "躯干 · 4" },
  { id: "base", label: "底盘 · 6" },
];
function toggleGroup(id: string) {
  ui.collapsedGroups = ui.collapsedGroups.includes(id)
    ? ui.collapsedGroups.filter((value) => value !== id)
    : [...ui.collapsedGroups, id];
}
function scenario(event: Event) {
  controller.setScenario(
    (event.target as HTMLSelectElement).value as ScenarioId,
  );
}
function changeSpeed(event: Event) {
  void controller.control("speed", {
    speed: Number((event.target as HTMLSelectElement).value),
  });
}
onMounted(() => {
  controller.empty();
  void controller.initialize();
  timer = setInterval(() => {
    now.value = Date.now();
  }, 250);
  // Read-only diagnostics for local testing; no mutation or mock controls exposed.
  Object.defineProperty(window, "__replayDiagnostics", {
    value: controller.diagnostics,
    configurable: true,
  });
});
onBeforeUnmount(() => {
  clearInterval(timer);
  controller.dispose();
  chart.dispose();
  delete (window as unknown as Record<string, unknown>).__replayDiagnostics;
});
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">R</div>
          <div>
            <h1>机器人日志回放</h1>
            <p>ROBOT REPLAY WORKSPACE</p>
          </div>
        </div>
        <n-tag data-testid="mode-badge" :type="runtime ? 'warning' : 'info'" size="small">{{ runtime ? 'MOCK · 合成数据' : '真实后端' }}</n-tag>
        <n-button
          data-testid="import-log"
          type="primary"
          size="small"
          :disabled="!ready || !!ui.cleanupSessionId"
          @click="importOpen = true">导入日志</n-button>
      </header>
      <div class="environment-toolbar">
        <div class="environment-controls">
          <label>场景 <select id="scene" v-model="session.sceneId" :disabled="!!session.sid || busy">
              <option v-if="!session.scenes.length" value="">等待场景列表</option>
              <option v-for="item in session.scenes" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <label>机器人 <select id="robot" v-model="session.robotId" :disabled="!!session.sid || busy">
              <option v-if="!session.robots.length" value="">等待机器人列表</option>
              <option v-for="item in session.robots" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
          <n-button
            data-testid="create-session"
            type="primary"
            :disabled="!!session.sid || !!ui.cleanupSessionId || busy || !session.sceneId || !session.robotId"
            :loading="busy && !session.sid"
            @click="controller.create">创建会话</n-button>
          <span class="worker-status">{{ phaseNames[session.workerPhase] ?? session.workerPhase }}</span>
          <n-button
            data-testid="close-session"
            :disabled="(!session.sid && !ui.creating && !ui.cleanupSessionId) || (busy && !!ui.cleanupSessionId)"
            @click="session.sid ? closeOpen = true : controller.close()">{{ session.sid ? '关闭会话' : ui.cleanupSessionId ? '重试关闭' : '取消创建' }}</n-button>
        </div>
        <div class="toolbar-actions">
          <span>{{ activeDetails?.fileName ?? (playback.server?.log_id ? playback.server.log_id : '尚未激活日志') }}</span>
          <n-button
            data-testid="open-log-details"
            size="small"
            :disabled="!playback.server?.log_id"
            @click="detailsOpen = true">日志详情</n-button>
          <span class="sync-status">{{ statusText }}</span>
          <span class="connection">
            <i
              :class="['dot', { online: session.socket.state === 'open' }]" />{{ session.socket.state === 'open' ? '数据连接正常' : '等待数据连接' }}</span>
        </div>
      </div>
      <main class="workspace">
        <section class="main-pane">
          <n-alert v-if="ui.error" data-testid="error-message" type="error" :show-icon="false" class="error-banner">{{ ui.error }}</n-alert>
          <section class="card stage-card">
            <p
              v-if="displayed && playback.server?.log_id && displayed.log_id !== playback.server.log_id"
              class="hold-notice"
              data-testid="previous-frame-notice">当前画面仍为 {{ displayedDetails?.fileName ?? displayed.log_id }}，等待新日志首帧。</p>
            <div class="stage-scroll">
              <div class="canvas-wrap">
                <canvas ref="canvas" data-testid="paired-canvas" :width="PRESENTATION_WIDTH" :height="PRESENTATION_HEIGHT" aria-label="同帧呈现的机器人画面、28关节、底盘及日志进度" />
                <button
                  v-for="group in groups"
                  :key="group.id"
                  class="group-overlay"
                  :style="{left: (PRESENTATION_GROUP_RECTS[group.id as keyof typeof PRESENTATION_GROUP_RECTS].x / PRESENTATION_WIDTH * 100) + '%', top: (PRESENTATION_GROUP_RECTS[group.id as keyof typeof PRESENTATION_GROUP_RECTS].y / PRESENTATION_HEIGHT * 100) + '%', width: (PRESENTATION_GROUP_RECTS[group.id as keyof typeof PRESENTATION_GROUP_RECTS].width / PRESENTATION_WIDTH * 100) + '%', height: (30 / PRESENTATION_HEIGHT * 100) + '%'}"
                  :data-testid="`group-${group.id}`"
                  :aria-label="`${group.label} ${ui.collapsedGroups.includes(group.id) ? '展开' : '收起'}`"
                  :aria-expanded="!ui.collapsedGroups.includes(group.id)"
                  @click="toggleGroup(group.id)">
                  <span>{{ ui.collapsedGroups.includes(group.id) ? '＋' : '－' }}</span>
                </button>
                <div class="channel-toolbar" :style="{ top: (530 / PRESENTATION_HEIGHT * 100) + '%', height: (34 / PRESENTATION_HEIGHT * 100) + '%' }">
                  <strong>历史曲线</strong>
                  <span
                    v-for="name in history.selected"
                    :key="name"
                    class="channel-chip">{{ name }} <button
                    :aria-label="`移除 ${name}`"
                    @click="history.setSelected(history.selected.filter(n => n !== name))">×</button>
                  </span>
                  <button
                    data-testid="open-channel-picker"
                    :disabled="!history.channels.length"
                    @click="openChannels">选择通道 ({{ history.selected.length }}/4)</button>
                  <span class="legend">黄色 临界 · 红色 越限 · 缺失为断点</span>
                </div>
              </div>
            </div>
            <PresentedData :snapshot="displayed" :metadata="session.jointMeta" />
            <div class="transport">
              <div class="control-row">
                <div class="play-controls">
                  <n-button
                    data-testid="play"
                    type="primary"
                    :disabled="!canPlay"
                    @click="controller.control('play')">{{ playback.server?.state === 'ended' ? '▶ 从头重播' : '▶ 播放' }}</n-button>
                  <n-button data-testid="pause" :disabled="!canPause" @click="controller.control('pause')">暂停</n-button>
                  <n-button data-testid="stop" :disabled="!canControl || busy" @click="controller.control('stop')">停止归零</n-button>
                  <n-button
                    data-testid="step-backward"
                    :disabled="!canControl || busy"
                    title="上一原采样点，会暂停"
                    @click="controller.control('step', {direction:'backward'})">上一原采样点</n-button>
                  <n-button
                    data-testid="step-forward"
                    :disabled="!canControl || busy"
                    title="下一原采样点，会暂停"
                    @click="controller.control('step', {direction:'forward'})">下一原采样点</n-button>
                </div>
                <TimelineControl
                  :duration="playback.server?.duration_s ?? 0"
                  :presented-time="displayed?.log_time_s ?? 0"
                  :disabled="!canControl || busy"
                  :context="`${session.sid}:${playback.server?.log_id}:${ui.intentRevision}`"
                  @seek="controller.seek" />
                <div class="position-controls">
                  <label>倍速 <select
                    data-testid="speed-select"
                    aria-label="播放倍速"
                    :value="playback.server?.speed ?? 1"
                    :disabled="!canControl || busy"
                    @change="changeSpeed">
                      <option v-for="speed in [0.1,0.25,0.5,1,2,4,10]" :key="speed" :value="speed">{{ speed }}×</option>
                    </select>
                  </label>
                  <n-button
                    data-testid="open-seek"
                    :disabled="!canControl || busy"
                    @click="seekMode = 'time'; seekOpen = true">精确定位</n-button>
                </div>
              </div>
              <p v-if="pending" class="pending-note">{{ pendingText }}</p>
            </div>
          </section>
          <n-alert v-if="chartError" type="error">历史曲线绘制失败：{{ chartError }}</n-alert>
          <nav class="analysis-tabs" aria-label="回放分析">
            <button :aria-pressed="analysisTab === 'stages'" @click="analysisTab = 'stages'">阶段与来源</button>
            <button data-testid="limits-tab" :aria-pressed="analysisTab === 'limits'" @click="analysisTab = 'limits'">限位事件</button>
            <button :aria-pressed="analysisTab === 'activity'" @click="analysisTab = 'activity'">运行记录</button>
          </nav>
          <section v-show="analysisTab === 'stages'" class="card stage-summary">
            <div>
              <h3>当前阶段</h3>
              <p v-if="annotations.currentData?.alignment === 'reference_only'">仅供历史来源参考，未对齐当前运行。</p>
              <p
                v-else-if="annotations.currentSegments.length">{{ annotations.currentSegments.slice(0, 8).map(segment => segment.label).join(' · ') }}{{ annotations.currentSegments.length > 8 ? ` · 另有 ${annotations.currentSegments.length - 8} 个当前阶段` : '' }}</p>
              <p v-else>当前已呈现时刻没有对应阶段。</p>
              <small>来源 {{ annotations.currentData?.source_id ?? '未提供' }} · {{ annotations.currentData?.alignment ?? '等待对应日志画面' }}</small>
              <div v-if="annotations.currentData?.alignment === 'source_frames' && annotations.currentData.segments.length" class="phase-timeline" aria-label="源记录阶段">
                <button v-for="segment in stagePreview" :key="segment.id" :aria-current="annotations.currentSegments.some(current => current.id === segment.id) ? 'true' : undefined" :disabled="!canControl || busy || !displayed || segment.start_s > displayed.duration_s" :title="`${segment.start_s.toFixed(3)}–${segment.end_s.toFixed(3)} s`" @click="controller.seek(segment.start_s)">{{ segment.label }} <small>{{ segment.start_s.toFixed(3) }} s</small></button>
              </div>
            </div>
            <n-button data-testid="open-annotations" @click="annotationOpen = true">全部阶段与来源</n-button>
          </section>
          <HistoryControls v-show="analysisTab === 'limits'" :disabled="!canControl || busy" @seek="controller.seek" />
          <section v-show="analysisTab === 'activity'" class="card activity-card">
            <h3>运行记录</h3>
            <ol v-if="ui.activity.length">
              <li v-for="(item,i) in ui.activity" :key="`${item.at}-${i}`">
                <time>{{ new Date(item.at).toLocaleTimeString('zh-CN', {hour12:false}) }}</time> {{ item.message }}</li>
            </ol>
            <p v-else class="subtle">环境与播放事件会显示在这里。</p>
          </section>
          <section v-if="runtime" class="card scenario-card">
            <label for="scenario">Mock 专属 · 演示场景</label>
            <select id="scenario" data-testid="scenario-select" :value="ui.scenario" @change="scenario">
              <option v-for="item in SCENARIOS" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
            <p>{{ scenarioHelp[ui.scenario] }}</p>
          </section>
        </section>
      </main>
      <footer data-testid="health-panel">
        <span>系统健康 · {{ session.health?.worker_alive == null ? '等待健康信息' : session.health.worker_alive ? 'Worker 存活' : 'Worker 未运行' }} · CPU {{ session.health?.cpu_percent == null ? '—' : session.health.cpu_percent.toFixed(1) + '%' }} · 采集端渲染 {{ session.health?.render_fps?.toFixed(1) ?? '—' }} fps · 配对 {{ telemetry.count }} · 延迟 {{ latency === null ? '—' : latency.toFixed(0) }} ms</span>
        <button @click="healthOpen = true">健康详情</button>
        <span>IsaacSim 6.2 · PhysX</span>
      </footer>
      <n-drawer v-model:show="importOpen" :width="520" display-directive="show" placement="right">
        <n-drawer-content title="导入日志" closable>
          <template #header>导入日志 <button data-testid="close-import" @click="importOpen = false">关闭</button>
          </template>
          <div data-testid="import-drawer">
            <UploadPanel
              :key="session.sid ?? 'none'"
              :ready="ready && !ui.creating"
              :busy="ui.uploading"
              :mock="!!runtime"
              :uploaded="playback.uploaded"
              :active-log-id="playback.server?.log_id ?? null"
              :issues="ui.uploadIssues"
              :max-bytes="controller.maxUploadBytes"
              :candidate-details="candidateDetails"
              :active-details="activeDetails"
              :activation-busy="busy"
              :can-activate="ready && session.socket.state === 'open' && !busy"
              @upload="controller.loadFile"
              @activate="(logId) => controller.control('load', {log_id: logId})"
              @demo="controller.loadDemo" />
            </div>
          </n-drawer-content>
        </n-drawer>
        <n-drawer v-model:show="annotationOpen" :width="600" placement="right">
          <n-drawer-content closable>
            <template #header>全部阶段与来源 <button data-testid="close-annotations" @click="annotationOpen = false">关闭</button>
            </template>
            <AnnotationPanel :disabled="!canControl || busy" @seek="controller.seek" />
          </n-drawer-content>
        </n-drawer>
        <n-drawer v-model:show="detailsOpen" :width="520" placement="right">
          <n-drawer-content title="日志详情" closable>
            <template #header>日志详情 <button data-testid="close-log-details" @click="detailsOpen = false">关闭</button>
            </template>
            <LogDetailsPanel :details="activeDetails" :log-id="playback.server?.log_id ?? null" role="active" />
          </n-drawer-content>
        </n-drawer>
        <n-modal v-model:show="closeOpen" preset="card" title="关闭会话" class="dialog">
          <div data-testid="close-confirmation">
            <p>关闭将结束环境并删除本会话的上传副本，本地原文件会保留。</p>
            <div class="dialog-actions">
              <n-button data-testid="cancel-close-session" @click="closeOpen = false">取消</n-button>
              <n-button data-testid="confirm-close-session" type="primary" @click="closeOpen = false; controller.close()">确认关闭</n-button>
            </div>
          </div>
        </n-modal>
        <n-modal v-model:show="seekOpen" preset="card" title="精确定位" class="dialog">
          <div class="dialog-tabs">
            <button @click="seekMode = 'time'">按秒定位</button>
            <button @click="seekMode = 'frame'">按原采样帧定位</button>
          </div>
          <label
            v-if="seekMode === 'time'">秒数（时长 {{ playback.server?.duration_s ?? 0 }} s）<input
            v-model="seekText"
            data-testid="seek-input"
            type="number" min="0" step="any"
            @keydown.enter="submitSeek" />
          </label>
          <label v-else>原始采样点序号，从 0 开始<input
            v-model="seekText"
            data-testid="frame-input"
            type="number" min="0" step="1"
            @keydown.enter="submitSeek" />
          </label>
          <p v-if="!seekValid" role="alert">请输入有效的非负{{ seekMode === 'frame' ? '整数' : '数值' }}。</p>
          <div class="dialog-actions">
            <n-button @click="seekOpen = false">取消</n-button>
            <n-button
              :data-testid="seekMode === 'time' ? 'seek-submit' : 'frame-submit'"
              type="primary"
              :disabled="!seekValid || !canControl || busy"
              @click="submitSeek">定位</n-button>
          </div>
        </n-modal>
        <n-modal v-model:show="channelOpen" preset="card" title="选择曲线通道" class="dialog">
          <p>已选 {{ channelDraft.length }} / 4；选择只影响历史展示。</p>
          <div class="channel-options">
            <label v-for="channel in history.channels" :key="channel.name">
              <input
                v-model="channelDraft"
                type="checkbox"
                :value="channel.name"
                :disabled="channelDraft.length >= 4 && !channelDraft.includes(channel.name)" />{{ channel.name }} · {{ channel.unit }} · {{ channel.quality.origin }}</label>
          </div>
          <div class="dialog-actions">
            <n-button data-testid="cancel-channels" @click="channelOpen = false">取消</n-button>
            <n-button data-testid="apply-channels" type="primary" @click="applyChannels">应用</n-button>
          </div>
        </n-modal>
        <n-modal v-model:show="healthOpen" preset="card" title="系统健康" class="dialog">
          <p>Worker：{{ session.health?.worker_alive == null ? '未提供' : session.health.worker_alive ? '存活' : '未运行' }}</p>
          <p>采集端渲染 FPS {{ session.health?.render_fps?.toFixed(1) ?? '—' }} · CPU {{ session.health?.cpu_percent == null ? '—' : session.health.cpu_percent.toFixed(1) + '%' }} · 配对 {{ telemetry.count }} · 延迟 {{ latency?.toFixed(0) ?? '—' }} ms</p>
          <p>CPU {{ session.health?.cpu_percent == null ? '—' : session.health.cpu_percent.toFixed(1) + '%' }} · 内存 {{ session.health?.memory_bytes == null ? '—' : (session.health.memory_bytes / 1048576).toFixed(1) }} MiB · GPU {{ session.health?.gpu_percent == null ? '—' : session.health.gpu_percent.toFixed(1) + '%' }}</p>
          <p>健康信息更新时间：{{ session.healthWallTime ? new Date(session.healthWallTime).toLocaleTimeString('zh-CN', {hour12:false}) : '—' }}</p>
        </n-modal>
      </div>
    </n-config-provider>
  </template>
