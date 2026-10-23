<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NConfigProvider, NButton, NTag, NAlert, darkTheme } from "naive-ui";
import { createWorkbenchController, type MockBridge } from "./app/controller";
import { useSessionStore } from "./stores/session";
import { usePlaybackStore } from "./stores/playback";
import { useTelemetryStore } from "./stores/telemetry";
import { useUiStore } from "./stores/ui";
import { SCENARIOS, type ScenarioId } from "./domain/types";

const props = defineProps<{ runtime?: MockBridge }>();
const session = useSessionStore(),
  playback = usePlaybackStore(),
  telemetry = useTelemetryStore(),
  ui = useUiStore();
const canvas = ref<HTMLCanvasElement | null>(null),
  uploadInput = ref<HTMLInputElement | null>(null);
const controller = createWorkbenchController({
  runtime: props.runtime,
  getCanvas: () => canvas.value,
});
const seekTime = ref(0),
  previewTime = ref(0),
  dragging = ref(false),
  now = ref(Date.now());
const ready = computed(() => session.workerPhase === "ready");
const loaded = computed(
  () => !!playback.server?.log_id && playback.server.state !== "error",
);
const pending = computed(
  () =>
    !!playback.server &&
    playback.server.control_seq > (telemetry.presented?.control_seq ?? -1),
);
const displayed = computed(() => telemetry.presented);
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
    primaryColor: "#59d5cf",
    primaryColorHover: "#87e7df",
    primaryColorPressed: "#35bcb8",
    borderRadius: "8px",
    fontFamily: 'Inter, "Noto Sans CJK SC", system-ui, sans-serif',
  },
};
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => displayed.value?.log_time_s,
  (value) => {
    if (!dragging.value) previewTime.value = value ?? 0;
  },
);
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await controller.loadFile(file);
  input.value = "";
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
function releaseTimeline(event: Event) {
  dragging.value = false;
  void controller.control("seek", {
    time_s: Number((event.target as HTMLInputElement).value),
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
  delete (window as unknown as Record<string, unknown>).__replayDiagnostics;
});
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">R1</div>
          <div>
            <h1>机器人日志回放</h1>
            <p>ROBOT REPLAY WORKSPACE</p>
          </div>
        </div>
        <div class="top-status">
          <n-tag
            data-testid="mode-badge"
            :type="runtime ? 'warning' : 'info'"
            size="small"
            :bordered="false"
            >{{ runtime ? "MOCK · 合成数据" : "真实后端" }}</n-tag
          ><span class="version">IsaacSim 6.2 · PhysX</span>
        </div>
      </header>
      <div class="workspace-heading">
        <div>
          <span class="eyebrow">运动回放</span>
          <h2>从日志时刻，看见机器人状态</h2>
        </div>
        <span class="connection"
          ><i :class="['dot', { online: session.socket.state === 'open' }]" />{{
            session.socket.state === "open" ? "数据连接正常" : "等待数据连接"
          }}</span
        >
      </div>

      <main class="workspace">
        <aside class="setup-pane">
          <section class="card setup-card">
            <div class="section-heading">
              <h3>回放环境</h3>
              <span class="step-label">01</span>
            </div>
            <label class="field-label" for="scene">场景</label>
            <select
              id="scene"
              v-model="session.sceneId"
              :disabled="!!session.sid || busy"
            >
              <option v-if="!session.scenes.length" value="">
                等待场景列表
              </option>
              <option
                v-for="item in session.scenes"
                :key="item.id"
                :value="item.id"
              >
                {{ item.name }}
              </option>
            </select>
            <label class="field-label" for="robot">机器人</label>
            <select
              id="robot"
              v-model="session.robotId"
              :disabled="!!session.sid || busy"
            >
              <option v-if="!session.robots.length" value="">
                等待机器人列表
              </option>
              <option
                v-for="item in session.robots"
                :key="item.id"
                :value="item.id"
              >
                {{ item.name }}
              </option>
            </select>
            <div class="robot-spec">
              <span>28 自由度</span><span>固定第三人称</span>
            </div>
            <n-button
              data-testid="create-session"
              type="primary"
              block
              :disabled="
                !!session.sid || busy || !session.sceneId || !session.robotId
              "
              :loading="busy && !session.sid"
              @click="controller.create"
              >创建会话</n-button
            >
            <div class="session-row">
              <span>工作线程</span
              ><strong :class="{ danger: session.workerPhase === 'error' }">{{
                phaseNames[session.workerPhase] ?? session.workerPhase
              }}</strong>
            </div>
            <n-button
              data-testid="close-session"
              secondary
              block
              size="small"
              :disabled="!session.sid && !ui.creating"
              @click="controller.close"
              >{{ session.sid ? "关闭会话" : "取消创建" }}</n-button
            >
          </section>

          <section class="card setup-card">
            <div class="section-heading">
              <h3>日志数据</h3>
              <span class="step-label">02</span>
            </div>
            <div class="upload-area">
              <span class="file-icon">↥</span
              ><strong>{{
                playback.uploaded ? "日志已载入" : "载入一段运动日志"
              }}</strong>
              <p>
                {{
                  runtime
                    ? "演示模式使用合成轨迹，不解析真机文件内容。"
                    : "选择文件上传到真实后端。"
                }}
              </p>
            </div>
            <n-button
              v-if="runtime"
              data-testid="demo-load"
              block
              type="primary"
              secondary
              :disabled="!ready || busy"
              @click="controller.loadDemo"
              >载入示例日志</n-button
            >
            <n-button
              block
              secondary
              :disabled="!ready || busy"
              class="upload-button"
              @click="uploadInput?.click()"
              >选择文件 <span class="file-limit">≤ 1 MiB</span></n-button
            >
            <input
              ref="uploadInput"
              class="visually-hidden"
              type="file"
              accept=".json,.csv,.log"
              aria-label="上传日志文件"
              @change="upload"
            />
            <div v-if="playback.uploaded" class="log-facts">
              <div>
                <span>采样点</span
                ><b>{{
                  playback.uploaded.stats.sample_count.toLocaleString()
                }}</b>
              </div>
              <div>
                <span>时长</span
                ><b>{{ playback.uploaded.stats.duration_s.toFixed(1) }} s</b>
              </div>
              <div>
                <span>有效关节</span
                ><b>{{ playback.uploaded.stats.joints_mapped.length }} / 28</b>
              </div>
            </div>
            <p v-if="playback.uploaded?.issues.length" class="quality-note">
              {{ playback.uploaded.issues[0].message }}
            </p>
          </section>
          <section v-if="runtime" class="card scenario-card">
            <label class="field-label" for="scenario">演示场景</label
            ><select
              id="scenario"
              data-testid="scenario-select"
              :value="ui.scenario"
              @change="scenario"
            >
              <option v-for="item in SCENARIOS" :key="item.id" :value="item.id">
                {{ item.label }}
              </option>
            </select>
            <p>{{ scenarioHelp[ui.scenario] }}</p>
          </section>
        </aside>

        <section class="main-pane">
          <n-alert
            v-if="ui.error"
            data-testid="error-message"
            type="error"
            :show-icon="false"
            class="error-banner"
            >{{ ui.error }}</n-alert
          >
          <div class="card stage-card">
            <div class="stage-toolbar">
              <div>
                <h3>同步回放</h3>
                <span>{{
                  runtime
                    ? "机器人结构示意 · 20 Hz 合成帧序列"
                    : "服务器渲染画面"
                }}</span>
              </div>
              <n-tag
                :type="
                  session.workerPhase === 'error'
                    ? 'error'
                    : displayed
                      ? 'success'
                      : 'default'
                "
                :bordered="false"
                size="small"
                >{{ statusText }}</n-tag
              >
            </div>
            <div class="stage-scroll">
              <canvas
                ref="canvas"
                data-testid="paired-canvas"
                width="1280"
                height="720"
                aria-label="同帧呈现的机器人画面、28关节、底盘及日志进度"
              />
            </div>
            <div class="transport">
              <div class="timeline">
                <input
                  aria-label="回放时间轴"
                  type="range"
                  min="0"
                  :max="playback.server?.duration_s || 12"
                  step="0.001"
                  :value="previewTime"
                  :disabled="!loaded"
                  @input="
                    dragging = true;
                    previewTime = Number(
                      ($event.target as HTMLInputElement).value,
                    );
                  "
                  @change="releaseTimeline"
                /><span
                  >{{ dragging ? "定位预览" : pending ? "等待呈现" : "已呈现" }}
                  <b
                    >{{
                      (dragging
                        ? previewTime
                        : (displayed?.log_time_s ?? 0)
                      ).toFixed(3)
                    }}
                    s</b
                  ></span
                >
              </div>
              <div class="control-row">
                <div class="play-controls">
                  <n-button
                    data-testid="play"
                    type="primary"
                    :disabled="!loaded || !ready || busy"
                    @click="controller.control('play')"
                    >▶ 播放</n-button
                  ><n-button
                    data-testid="pause"
                    secondary
                    :disabled="!loaded || !ready || busy"
                    @click="controller.control('pause')"
                    >暂停</n-button
                  ><n-button
                    data-testid="stop"
                    secondary
                    :disabled="!loaded || !ready || busy"
                    @click="controller.control('stop')"
                    >停止归零</n-button
                  ><n-button
                    data-testid="step-backward"
                    secondary
                    :disabled="!loaded || !ready || busy"
                    title="上一原采样点"
                    @click="
                      controller.control('step', { direction: 'backward' })
                    "
                    >后退一帧</n-button
                  ><n-button
                    data-testid="step-forward"
                    secondary
                    :disabled="!loaded || !ready || busy"
                    title="下一原采样点"
                    @click="
                      controller.control('step', { direction: 'forward' })
                    "
                    >前进一帧</n-button
                  >
                </div>
                <div class="position-controls">
                  <label
                    >倍速<select
                      data-testid="speed-select"
                      aria-label="播放倍速"
                      :value="playback.server?.speed ?? 1"
                      :disabled="!loaded || !ready || busy"
                      @change="changeSpeed"
                    >
                      <option :value="0.1">0.1×</option>
                      <option :value="1">1×</option>
                      <option :value="4">4×</option>
                      <option :value="10">10×</option>
                    </select></label
                  >
                  <div class="seek-field">
                    <input
                      v-model.number="seekTime"
                      data-testid="seek-input"
                      aria-label="定位秒数"
                      type="number"
                      min="0"
                      :max="playback.server?.duration_s || 12"
                      step="0.001"
                      :disabled="!loaded || !ready"
                      @keydown.enter="
                        controller.control('seek', { time_s: seekTime })
                      "
                    /><span>s</span>
                  </div>
                  <n-button
                    data-testid="seek-submit"
                    secondary
                    :disabled="!loaded || !ready || busy"
                    @click="controller.control('seek', { time_s: seekTime })"
                    >定位</n-button
                  >
                </div>
              </div>
            </div>
          </div>
          <div class="bottom-row">
            <div class="card session-summary">
              <h3>当前会话</h3>
              <div class="summary-metrics">
                <div>
                  <span>数据来源</span
                  ><strong>{{ runtime ? "合成数据" : "真实后端" }}</strong>
                </div>
                <div>
                  <span>配对呈现</span
                  ><strong>{{ telemetry.count }} <small>帧</small></strong>
                </div>
                <div>
                  <span>上一帧共同延迟</span
                  ><strong
                    >{{ latency === null ? "—" : latency.toFixed(0) }}
                    <small>ms</small></strong
                  >
                </div>
              </div>
              <p class="subtle">
                {{
                  session.sid
                    ? ui.mediaStatus
                    : "创建会话后载入日志，画面与对应数据将一起呈现。"
                }}
              </p>
            </div>
            <div class="card activity-card">
              <h3>运行记录</h3>
              <ol v-if="ui.activity.length">
                <li
                  v-for="(item, i) in ui.activity.slice(0, 3)"
                  :key="`${item.at}-${i}`"
                >
                  <time>{{
                    new Date(item.at).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })
                  }}</time
                  ><span>{{ item.message }}</span>
                </li>
              </ol>
              <p v-else class="subtle">环境与播放事件会显示在这里。</p>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <span>单会话工作台 · R1 Pro</span
        ><span>{{
          runtime
            ? "Mock 演示不代表 IsaacSim 或真机日志已接入。"
            : "真实媒体适配将在正式联调时接入。"
        }}</span>
      </footer>
    </div>
  </n-config-provider>
</template>
