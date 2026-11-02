<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton } from "naive-ui";
import type { Schema, UploadResult } from "../domain/types";
import type { ImportedLogDetails } from "../stores/playback";
import { formatUploadSize, isB041Upload, parseUploadOptions, validateUploadFile, type UploadFormOptions } from "../app/upload";

const props = withDefaults(defineProps<{
  ready: boolean;
  busy: boolean;
  mock: boolean;
  uploaded: UploadResult | null;
  activeLogId: string | null;
  issues: Schema["ParseIssue"][];
  maxBytes: number;
  candidateDetails?: ImportedLogDetails | null;
  activeDetails?: ImportedLogDetails | null;
  activationBusy?: boolean;
  canActivate?: boolean;
}>(), { candidateDetails: null, activeDetails: null, activationBusy: false, canActivate: true });
const emit = defineEmits<{
  upload: [file: File, options: UploadFormOptions];
  activate: [logId: string];
  demo: [];
}>();
const fileInput = ref<HTMLInputElement | null>(null);
const parser = ref("");
const mapping = ref("");
const fileError = ref<string | null>(null);
const fileName = ref("");
const portableBundle = ref(false);
const configuring = ref(!props.uploaded);
const options = computed(() => parseUploadOptions(parser.value, mapping.value));
const candidate = computed(() => props.candidateDetails?.result.log_id === props.uploaded?.log_id ? props.candidateDetails : null);
const result = computed(() => candidate.value?.result ?? props.uploaded);
const activeDetails = computed(() => props.activeDetails?.result.log_id === props.activeLogId ? props.activeDetails : null);
const active = computed(() => !!result.value && result.value.log_id === props.activeLogId);
const uploadDisabled = computed(() => !props.ready || props.busy || props.activationBusy || !options.value.ok);
const activateDisabled = computed(() => !props.ready || props.busy || props.activationBusy || !props.canActivate || active.value);
const allIssues = computed(() => {
  const seen = new Set<string>();
  return [...(result.value?.issues ?? []), ...props.issues].filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});
const severityNames = { error: "错误", warning: "警告", info: "信息" } as const;
watch(() => props.uploaded, (uploaded) => { configuring.value = !uploaded; });

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploadDisabled.value) return;
  fileError.value = validateUploadFile(file, props.maxBytes);
  if (fileError.value || !options.value.ok) return;
  portableBundle.value = isB041Upload(file.name);
  fileName.value = `${file.name} · ${formatUploadSize(file.size)}`;
  emit("upload", file, options.value.options);
}
function activate() {
  if (result.value && !activateDisabled.value) emit("activate", result.value.log_id);
}
function loadDemo() {
  if (!props.mock || !props.ready || props.busy || props.activationBusy) return;
  fileName.value = "";
  portableBundle.value = false;
  emit("demo");
}
</script>

<template>
  <section class="upload-panel" aria-label="日志导入与解析结果">
    <ol class="import-steps" aria-label="导入步骤">
      <li :class="{ current: configuring || busy }" :aria-current="configuring || busy ? 'step' : undefined"><span>1</span>配置并上传</li>
      <li :class="{ current: !configuring && !busy }" :aria-current="!configuring && !busy ? 'step' : undefined"><span>2</span>核对解析</li>
      <li :class="{ completed: active }"><span>3</span>激活回放</li>
    </ol>
    <div class="import-notice">
      <template v-if="activeLogId">当前激活日志保持回放，激活新日志后才切换。</template>
      <template v-else>上传只生成候选日志，核对解析后再激活回放。</template>
    </div>
    <p v-if="mock" class="upload-hint mock-import-note">Mock 仅记录文件名、摘要和映射；生成合成轨迹，不解析或持久化文件内容。</p>
    <div v-if="configuring || busy" class="upload-configuration">
      <div class="configuration-heading">
        <h3>配置本次上传</h3>
        <n-button v-if="result && !busy" text data-testid="upload-review-return" @click="configuring = false">返回候选结果</n-button>
      </div>
      <details class="mapping-editor" open>
        <summary>解析器与映射配置</summary>
        <label class="field-label" for="upload-parser">解析器标识（可选）</label>
        <input id="upload-parser" v-model="parser" data-testid="upload-parser" type="text" placeholder="留空使用服务端默认值" :disabled="busy || activationBusy" autocomplete="off" aria-describedby="parser-help" />
        <p id="parser-help" class="upload-hint">最多 128 字符；.b041 后缀由服务端选择对应解析器。</p>
        <label class="field-label" for="mapping-json">映射 JSON（可选）</label>
        <textarea id="mapping-json" v-model="mapping" data-testid="mapping-json" rows="9" spellcheck="false" placeholder="留空使用服务端默认映射" :disabled="busy || activationBusy" :aria-invalid="!options.ok" aria-describedby="mapping-help mapping-validation" />
        <p id="mapping-help" class="upload-hint">支持 JSON 对象，最多 65,536 字符。配置仅用于新上传，每次生成独立的只读映射快照；格式正确不代表标定正确。</p>
      </details>
      <p v-if="!options.ok" id="mapping-validation" data-testid="mapping-error" class="upload-error" role="alert">{{ options.error }}</p>
      <h3 class="file-heading">选择日志文件</h3>
      <div class="file-choice">
        <strong>{{ fileName || "尚未选择文件" }}</strong>
        <p>CSV / JSON / .b041 · 当前上限 {{ formatUploadSize(maxBytes) }}</p>
        <n-button type="primary" data-testid="choose-file" :disabled="uploadDisabled" @click="fileInput?.click()">选择并上传</n-button>
      </div>
      <n-button v-if="mock" block secondary class="demo-button" data-testid="demo-load" :disabled="!ready || busy || activationBusy" @click="loadDemo">载入示例日志</n-button>
      <p v-if="!ready" class="upload-hint">会话环境就绪后才能上传。</p>
    </div>
    <input ref="fileInput" data-testid="file-input" class="visually-hidden" type="file" accept=".csv,.json,.b041" aria-label="上传日志文件" :disabled="uploadDisabled" @change="selectFile" />
    <p v-if="fileError" data-testid="upload-file-error" class="upload-error" role="alert">{{ fileError }}</p>
    <p v-if="busy" class="processing-note" role="status" data-testid="upload-processing">正在处理，请稍候… 当前激活日志与画面保持。关闭抽屉仅隐藏此面板。</p>
    <div v-if="result && !configuring && !busy" class="upload-result" data-testid="upload-result">
      <div class="review-status" :class="{ 'is-active': active }">
        <strong>{{ active ? "解析完成" : "上传并解析完成" }}</strong>
        <span class="review-badge">{{ active ? "当前已激活" : "等待激活" }}</span>
        <p>{{ active ? "此日志已激活，画面与数据仍以对应帧的共同呈现为准。" : "本次日志尚未激活，当前回放来源保持不变。" }}</p>
      </div>
      <dl class="import-identities">
        <div><dt>本次上传</dt><dd>{{ candidate?.fileName || fileName || "文件名未记录" }}<code>{{ result.log_id }}</code></dd></div>
        <div><dt>当前激活</dt><dd>{{ activeLogId ? (activeDetails?.fileName || "文件名未记录") : "无激活日志" }}<code v-if="activeLogId">{{ activeLogId }}</code></dd></div>
      </dl>
      <section class="review-section" aria-label="候选解析统计">
        <h3>解析结果</h3>
        <dl class="log-facts">
          <div><dt>时长</dt><dd>{{ result.stats.duration_s.toFixed(3) }} s</dd></div>
          <div><dt>原始采样点</dt><dd>{{ result.stats.sample_count.toLocaleString() }}</dd></div>
          <div><dt>记录采样率（中位）</dt><dd>{{ result.stats.nominal_rate_hz === null ? "不规则 / 未知" : `${result.stats.nominal_rate_hz.toFixed(2)} Hz` }}</dd></div>
          <div><dt>已映射关节</dt><dd>{{ result.stats.joints_mapped.length }} / 28</dd></div>
          <div><dt>缺失关节</dt><dd>{{ result.stats.joints_missing.length }}</dd></div>
          <div><dt>底盘位姿</dt><dd>{{ result.stats.chassis.available ? `可用 · ${result.stats.chassis.frame || "坐标系未声明"}` : "不可用" }}</dd></div>
        </dl>
        <p class="parser-line"><span>解析器</span><code>{{ result.parser || "未提供" }}</code></p>
        <p v-if="result.stats.joints_missing.length" class="missing-channels" data-testid="missing-channels">缺失：{{ result.stats.joints_missing.join("、") }}</p>
      </section>
      <p v-if="portableBundle || result.parser === 'b041_bundle_v1'" class="provisional-note" data-testid="b041-provisional-note">暂定映射：B041 夹爪位移和底盘轨迹采用映射快照中的暂定假设。激活后可查看逐帧推算来源、具体假设和待审标注。</p>
      <section class="review-section">
        <div class="snapshot-heading"><h3>本次映射快照 <span class="readonly-label">只读</span></h3><n-button text data-testid="upload-reconfigure" :disabled="busy || activationBusy" @click="configuring = true">重新配置并上传</n-button></div>
        <p class="upload-hint mapping-id">快照 ID <code data-testid="mapping-snapshot-id">{{ result.mapping_snapshot_id || "未提供" }}</code></p>
        <details class="mapping-snapshot" open><summary>查看映射快照</summary><pre data-testid="mapping-snapshot">{{ result.mapping_snapshot == null ? "未提供" : JSON.stringify(result.mapping_snapshot, null, 2) }}</pre></details>
        <p class="upload-hint">此处展示已解析日志使用的配置。重新配置须上传新文件，不会修改这份快照。</p>
      </section>
      <details class="hash-details"><summary>上传原文件 SHA256</summary><code>{{ result.raw_file_sha256 || "未提供" }}</code></details>
    </div>
    <section v-if="allIssues.length && !busy" class="parse-issues review-section" aria-labelledby="issues-heading" data-testid="parse-issues">
      <h3 id="issues-heading">解析诊断 · {{ allIssues.length }}</h3>
      <ol>
        <li v-for="(issue, index) in allIssues" :key="index" :class="['parse-issue', `issue-${issue.severity}`]">
          <div class="issue-heading"><strong>{{ severityNames[issue.severity] }}</strong><code>{{ issue.code }}</code></div>
          <p>{{ issue.message }}</p>
          <span>行 {{ issue.line ?? "未提供" }} · 通道 {{ issue.channel || "未提供" }}</span>
          <details v-if="issue.details && Object.keys(issue.details).length"><summary>诊断详情</summary><pre>{{ JSON.stringify(issue.details, null, 2) }}</pre></details>
        </li>
      </ol>
    </section>
    <div v-if="result && !configuring && !busy" class="activation-actions">
      <p class="upload-hint">激活后从起点加载，画面与数据在对应帧到达后共同更新；首帧后手动播放。</p>
      <n-button block type="primary" data-testid="activate-log" :loading="activationBusy" :disabled="activateDisabled" @click="activate">{{ activationBusy ? "正在激活" : active ? "已激活此日志" : "激活此日志" }}</n-button>
      <p v-if="!active && !activationBusy && (!ready || !canActivate)" class="upload-hint">请等待会话、连接和当前操作就绪后激活。</p>
    </div>
  </section>
</template>

<style scoped>
.upload-panel { color: var(--text, #18304e); font-size: 14px; }
.upload-panel h3 { font-size: 16px; line-height: 1.5; margin: 0; }
.import-steps { display: flex; justify-content: space-between; gap: 12px; list-style: none; padding: 0; margin: 0 0 24px; }
.import-steps li { display: flex; align-items: center; gap: 7px; color: #60748c; font-size: 12px; font-weight: 600; }
.import-steps span { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid #c8d7e8; border-radius: 50%; background: #fff; }
.import-steps .current { color: #356fad; }
.import-steps .current span { color: #fff; background: #356fad; border-color: #356fad; }
.import-steps .completed span { color: #236e56; background: #eaf7f0; border-color: #a8d6bf; }
.import-notice, .processing-note { border: 1px solid #d2e1f3; background: #edf4fc; color: #285a8e; border-radius: 6px; padding: 12px 14px; line-height: 1.6; font-size: 13px; margin-bottom: 20px; }
.upload-hint { color: var(--muted, #60748c); font-size: 12px; line-height: 1.6; margin: 8px 0; }
.mock-import-note { margin-bottom: 18px; }
.configuration-heading, .snapshot-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.mapping-editor { margin: 12px 0; }
summary { cursor: pointer; color: #356fad; font-size: 13px; padding: 9px 0; }
.field-label { display: block; margin: 15px 0 8px; color: #18304e; font-weight: 600; font-size: 14px; }
input[type="text"], textarea { width: 100%; box-sizing: border-box; color: #18304e; border: 1px solid #cbd8e6; background: #fff; border-radius: 6px; padding: 10px 12px; font: inherit; font-size: 13px; }
input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid #356fad; outline-offset: 2px; }
input:disabled, textarea:disabled { background: #f3f6fa; color: #60748c; }
textarea { resize: vertical; min-height: 180px; font-family: ui-monospace, monospace; }
textarea[aria-invalid="true"] { border-color: #b83f43; }
.upload-error { color: #a62e35; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.file-heading { margin-top: 24px !important; margin-bottom: 10px !important; }
.file-choice { text-align: center; padding: 24px 16px; border: 1px dashed #b8cce3; border-radius: 6px; background: #fbfcfe; }
.file-choice strong { display: block; overflow-wrap: anywhere; }
.file-choice p { color: #60748c; font-size: 12px; margin: 10px 0 16px; }
.demo-button { margin-top: 12px; }
.review-status { padding: 14px; background: #edf8f2; border: 1px solid #cee8dc; border-radius: 6px; }
.review-status strong { color: #225b46; }
.review-badge { display: inline-block; margin-left: 12px; padding: 3px 8px; border-radius: 4px; background: #fff1d6; color: #92590f; font-size: 12px; font-weight: 600; }
.is-active .review-badge { background: #d9f2e5; color: #256548; }
.review-status p { color: #526d63; font-size: 12px; line-height: 1.6; margin: 8px 0 0; }
.import-identities { margin: 12px 0; border: 1px solid #dee6ef; border-radius: 6px; overflow: hidden; }
.import-identities > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); }
.import-identities > div + div { border-top: 1px solid #dee6ef; }
.import-identities dt { padding: 10px; background: #f3f7fc; color: #526e8e; font-size: 12px; }
.import-identities dd { margin: 0; padding: 9px 12px; font-size: 13px; overflow-wrap: anywhere; }
.import-identities code { display: block; margin-top: 4px; color: #60748c; font-size: 11px; }
.review-section { border: 1px solid #dee6ef; border-radius: 6px; padding: 14px; margin-top: 12px; }
.log-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 12px -14px 0; }
.log-facts > div { padding: 10px 12px; border-top: 1px solid #e4ebf3; }
.log-facts dt { font-size: 12px; color: #60748c; margin-bottom: 4px; }
.log-facts dd { margin: 0; font-weight: 600; font-size: 14px; color: #18304e; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.parser-line { display: flex; gap: 14px; border-top: 1px solid #e4ebf3; padding-top: 10px; font-size: 12px; overflow-wrap: anywhere; }
.parser-line span { color: #60748c; }
.missing-channels, .mapping-id { overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
.missing-channels { color: #926017; }
.provisional-note { color: #89560f; background: #fff6e7; border: 1px solid #f0d5a9; padding: 12px; font-size: 12px; line-height: 1.6; border-radius: 6px; }
.readonly-label { display: inline-block; padding: 1px 6px; margin-left: 4px; color: #356fad; background: #edf4fc; font-size: 11px; font-weight: 500; border-radius: 3px; }
pre { max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.65; color: #254568; background: #f3f6fa; padding: 12px; border-radius: 6px; }
.hash-details { border: 1px solid #dee6ef; border-radius: 6px; margin-top: 12px; padding: 0 14px 8px; }
.hash-details code { font-size: 12px; overflow-wrap: anywhere; }
.parse-issues ol { list-style: none; padding: 0; margin: 12px 0 0; }
.parse-issue { border-left: 3px solid #8ca5c0; padding: 8px 10px; margin-top: 8px; font-size: 12px; overflow-wrap: anywhere; background: #f3f7fc; border-radius: 3px; }
.issue-heading { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.parse-issue p { margin: 6px 0; line-height: 1.6; }
.parse-issue > span { color: #60748c; }
.issue-error { border-color: #c45055; background: #fff3f3; }
.issue-error strong { color: #a83239; }
.issue-warning { border-color: #c48a31; background: #fff8ec; }
.issue-warning strong { color: #8c5b16; }
.activation-actions { margin-top: 20px; border-top: 1px solid #dee6ef; padding-top: 10px; }
@media (max-width: 520px) { .import-steps { gap: 6px; } .import-steps li { font-size: 11px; gap: 4px; } .import-steps span { width: 23px; height: 23px; } .log-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
