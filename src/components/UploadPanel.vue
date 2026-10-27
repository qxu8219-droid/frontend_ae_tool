<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton } from "naive-ui";
import type { Schema, UploadResult } from "../domain/types";
import {
  formatUploadSize,
  isB041Upload,
  parseUploadOptions,
  validateUploadFile,
  type UploadFormOptions,
} from "../app/upload";

const props = defineProps<{
  ready: boolean;
  busy: boolean;
  mock: boolean;
  uploaded: UploadResult | null;
  activeLogId: string | null;
  issues: Schema["ParseIssue"][];
  maxBytes: number;
}>();
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
const options = computed(() => parseUploadOptions(parser.value, mapping.value));
const active = computed(
  () => !!props.uploaded && props.uploaded.log_id === props.activeLogId,
);
const allIssues = computed(() => {
  const seen = new Set<string>();
  return [...(props.uploaded?.issues ?? []), ...props.issues].filter(
    (issue) => {
      const key = JSON.stringify(issue);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
});
const severityNames = { error: "错误", warning: "警告", info: "信息" } as const;

function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !props.ready || props.busy) return;
  fileError.value = validateUploadFile(file, props.maxBytes);
  if (fileError.value || !options.value.ok) return;
  portableBundle.value = isB041Upload(file.name);
  fileName.value = `${file.name} · ${formatUploadSize(file.size)}`;
  emit("upload", file, options.value.options);
}
</script>

<template>
  <section
    class="card setup-card upload-panel"
    aria-labelledby="upload-heading"
  >
    <div class="section-heading">
      <h3 id="upload-heading">日志与映射</h3>
      <span class="step-label">02</span>
    </div>
    <p class="upload-description">
      {{
        mock
          ? "Mock 仅记录文件名、摘要和映射；生成合成轨迹，不解析或持久化文件内容。"
          : "上传日志并检查解析结果，再激活用于回放。"
      }}
    </p>
    <p class="upload-hint">支持 CSV、JSON、B041 便携包（.b041）；B041 后缀由服务端自动选择解析器。</p>
    <p v-if="portableBundle || uploaded?.parser === 'b041_bundle_v1'" class="upload-hint" data-testid="b041-provisional-note">
      B041 夹爪位移和底盘轨迹采用映射快照中的暂定假设。激活后可查看逐帧推算来源、具体假设和待审标注。
    </p>
    <details class="mapping-editor">
      <summary>解析器与映射配置</summary>
      <label class="field-label" for="upload-parser">解析器标识（可选）</label>
      <input
        id="upload-parser"
        v-model="parser"
        data-testid="upload-parser"
        type="text"
        placeholder="留空使用服务端默认值"
        :disabled="busy"
        autocomplete="off"
      />
      <label class="field-label" for="mapping-json">映射 JSON（可选）</label>
      <textarea
        id="mapping-json"
        v-model="mapping"
        data-testid="mapping-json"
        rows="6"
        spellcheck="false"
        placeholder="留空使用服务端默认映射"
        :disabled="busy"
        :aria-invalid="!options.ok"
        aria-describedby="mapping-help"
      />
      <p id="mapping-help" class="upload-hint">
        支持 JSON 对象，最多 65,536 字符。每次上传生成独立映射快照。
      </p>
    </details>
    <p
      v-if="!options.ok"
      data-testid="mapping-error"
      class="upload-error"
      role="alert"
    >
      {{ options.error }}
    </p>
    <n-button
      v-if="mock"
      block
      data-testid="demo-load"
      :disabled="!ready || busy"
      @click="emit('demo')"
      >载入示例日志</n-button
    >
    <n-button
      block
      secondary
      class="upload-button"
      data-testid="choose-file"
      :disabled="!ready || busy || !options.ok"
      @click="fileInput?.click()"
      >选择并上传
      <span class="file-limit"
        >≤ {{ formatUploadSize(maxBytes) }}</span
      ></n-button
    >
    <input
      ref="fileInput"
      data-testid="file-input"
      class="visually-hidden"
      type="file"
      accept=".csv,.json,.b041"
      aria-label="上传日志文件"
      :disabled="!ready || busy || !options.ok"
      @change="selectFile"
    />
    <p v-if="fileName" class="upload-filename">{{ fileName }}</p>
    <p
      v-if="fileError"
      data-testid="upload-file-error"
      class="upload-error"
      role="alert"
    >
      {{ fileError }}
    </p>
    <p
      v-if="busy"
      class="upload-hint"
      role="status"
      data-testid="upload-processing"
    >
      正在处理，请稍候…
    </p>
    <div v-if="uploaded" class="upload-result" data-testid="upload-result">
      <div class="upload-result-heading">
        <strong>解析结果</strong
        ><span :class="{ 'upload-active': active }">{{
          active ? "当前已激活" : "等待激活"
        }}</span>
      </div>
      <dl class="log-facts">
        <div>
          <dt>时长</dt>
          <dd>{{ uploaded.stats.duration_s.toFixed(3) }} s</dd>
        </div>
        <div>
          <dt>采样点</dt>
          <dd>{{ uploaded.stats.sample_count.toLocaleString() }}</dd>
        </div>
        <div>
          <dt>记录采样率（中位）</dt>
          <dd>
            {{
              uploaded.stats.nominal_rate_hz === null
                ? "不规则 / 未知"
                : `${uploaded.stats.nominal_rate_hz.toFixed(2)} Hz`
            }}
          </dd>
        </div>
        <div>
          <dt>有效关节</dt>
          <dd>{{ uploaded.stats.joints_mapped.length }} / 28</dd>
        </div>
        <div>
          <dt>缺失关节</dt>
          <dd>{{ uploaded.stats.joints_missing.length }}</dd>
        </div>
        <div>
          <dt>底盘位姿</dt>
          <dd>
            {{
              uploaded.stats.chassis.available
                ? `可用 · ${uploaded.stats.chassis.frame || "坐标系未声明"}`
                : "不可用"
            }}
          </dd>
        </div>
        <div>
          <dt>解析器</dt>
          <dd>{{ uploaded.parser }}</dd>
        </div>
      </dl>
      <p
        v-if="uploaded.stats.joints_missing.length"
        class="missing-channels"
        data-testid="missing-channels"
      >
        缺失：{{ uploaded.stats.joints_missing.join("、") }}
      </p>
      <p class="upload-hint mapping-id">
        映射快照
        <code data-testid="mapping-snapshot-id">{{
          uploaded.mapping_snapshot_id
        }}</code>
      </p>
      <details class="mapping-snapshot">
        <summary>查看映射快照</summary>
        <pre data-testid="mapping-snapshot">{{
          JSON.stringify(uploaded.mapping_snapshot, null, 2)
        }}</pre>
      </details>
      <n-button
        block
        type="primary"
        data-testid="activate-log"
        :disabled="!ready || busy || active"
        @click="emit('activate', uploaded.log_id)"
        >{{ active ? "已激活此日志" : "激活此日志" }}</n-button
      >
      <p v-if="!active" class="upload-hint">
        激活后从起点回放；当前画面将在对应新帧到达时更新。
      </p>
    </div>
    <section
      v-if="allIssues.length"
      class="parse-issues"
      aria-labelledby="issues-heading"
      data-testid="parse-issues"
    >
      <h4 id="issues-heading">解析诊断 · {{ allIssues.length }}</h4>
      <ol>
        <li
          v-for="(issue, index) in allIssues"
          :key="index"
          :class="['parse-issue', `issue-${issue.severity}`]"
        >
          <div>
            <strong>{{ severityNames[issue.severity] }}</strong>
            <code>{{ issue.code }}</code>
          </div>
          <p>{{ issue.message }}</p>
          <span v-if="issue.line != null || issue.channel"
            >{{ issue.line != null ? `行 ${issue.line}` : ""
            }}{{ issue.line != null && issue.channel ? " · " : ""
            }}{{ issue.channel ? `通道 ${issue.channel}` : "" }}</span
          >
          <details v-if="issue.details && Object.keys(issue.details).length">
            <summary>详情</summary>
            <pre>{{ JSON.stringify(issue.details, null, 2) }}</pre>
          </details>
        </li>
      </ol>
    </section>
  </section>
</template>

<style scoped>
.upload-description,
.upload-hint {
  color: var(--muted, #9caaba);
  font-size: 12px;
  line-height: 1.6;
}
.upload-description {
  margin: 0 0 12px;
}
.mapping-editor {
  margin-bottom: 12px;
}
summary {
  cursor: pointer;
  color: #b9d5dc;
  font-size: 12px;
  padding: 7px 0;
}
input[type="text"],
textarea {
  width: 100%;
  box-sizing: border-box;
  color: #e7eef5;
  border: 1px solid #354452;
  background: #101922;
  border-radius: 6px;
  padding: 9px;
  font: inherit;
  font-size: 12px;
}
textarea {
  resize: vertical;
  min-height: 100px;
  font-family: ui-monospace, monospace;
}
textarea[aria-invalid="true"] {
  border-color: #ec797f;
}
.upload-error {
  color: #ff969b;
  font-size: 12px;
  line-height: 1.5;
}
.upload-filename,
.missing-channels,
.mapping-id {
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.5;
}
.missing-channels {
  color: #e8bb75;
}
.upload-result {
  border-top: 1px solid #2c3b49;
  margin-top: 15px;
  padding-top: 14px;
}
.upload-result-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: #a5b6c5;
}
.upload-result-heading strong {
  color: #dfe9f1;
}
.upload-active {
  color: #65d4b6;
}
.log-facts {
  margin: 12px 0;
}
.log-facts dt {
  color: #98a8b8;
}
.log-facts dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
.mapping-snapshot {
  margin-bottom: 12px;
}
pre {
  max-height: 210px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  line-height: 1.5;
  color: #b9cad8;
  background: #101821;
  padding: 9px;
  border-radius: 6px;
}
.parse-issues {
  margin-top: 15px;
}
.parse-issues h4 {
  font-size: 12px;
  margin: 0 0 8px;
}
.parse-issues ol {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 260px;
  overflow: auto;
}
.parse-issue {
  border-left: 2px solid #618fa9;
  padding: 5px 0 6px 8px;
  margin-bottom: 9px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.parse-issue p {
  margin: 4px 0;
  color: #b8c8d6;
  line-height: 1.5;
}
.parse-issue span {
  color: #9aaebe;
}
.issue-error {
  border-color: #f1858a;
}
.issue-error strong {
  color: #f1858a;
}
.issue-warning {
  border-color: #e8bb75;
}
.issue-warning strong {
  color: #e8bb75;
}
</style>
