<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton } from "naive-ui";
import { formatUploadSize } from "../app/upload";
import type { ImportedLogDetails } from "../stores/playback";

const props = withDefaults(defineProps<{
  details: ImportedLogDetails | null;
  logId: string | null;
  role?: "active" | "candidate";
}>(), { role: "active" });
// A mismatched cache entry must never supply another log's filename or snapshot.
const retained = computed(() => props.logId && props.details?.result.log_id === props.logId ? props.details : null);
const result = computed(() => retained.value?.result ?? null);
const roleName = computed(() => props.role === "candidate" ? "候选日志" : "当前激活日志");
const severityNames = { error: "错误", warning: "警告", info: "信息" } as const;
const mappingText = computed(() => result.value?.mapping_snapshot == null ? "未提供" : JSON.stringify(result.value.mapping_snapshot, null, 2));
const copyStatus = ref("");
watch(() => [props.logId, props.details], () => { copyStatus.value = ""; });
async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    copyStatus.value = `${label}已复制`;
  } catch {
    copyStatus.value = "复制不可用，请选取下方文本手动复制。";
  }
}
</script>

<template>
  <section class="log-details" data-testid="log-details" :aria-label="`${roleName}详情`">
    <header class="log-details-heading">
      <span class="role-label" :class="{ candidate: role === 'candidate' }">{{ roleName }}</span>
      <h3 data-testid="log-details-filename">{{ retained?.fileName || (logId ? "文件名未记录" : "尚未选择日志") }}</h3>
      <dl class="identity-facts">
        <div><dt>日志 ID</dt><dd><code>{{ logId || "未提供" }}</code></dd></div>
        <template v-if="retained">
          <div><dt>会话 ID</dt><dd><code>{{ retained.sessionId }}</code></dd></div>
          <div><dt>本地文件大小</dt><dd>{{ formatUploadSize(retained.fileSize) }}</dd></div>
          <div><dt>本次导入时间</dt><dd>{{ new Date(retained.importedAt).toLocaleString() }}</dd></div>
        </template>
      </dl>
    </header>

    <p v-if="!result" class="details-unavailable" role="status">{{ logId ? "该日志详情不可用。本标签页未保留此日志的导入记录，无法显示其统计、诊断和映射快照。" : "激活或选择日志后可查看详情。" }}</p>
    <template v-else>
      <details class="detail-section" open>
        <summary>解析概览</summary>
        <dl class="details-stats">
          <div><dt>时长</dt><dd>{{ result.stats.duration_s.toFixed(3) }} s</dd></div>
          <div><dt>原始采样点</dt><dd>{{ result.stats.sample_count.toLocaleString() }}</dd></div>
          <div><dt>记录采样率（中位）</dt><dd>{{ result.stats.nominal_rate_hz == null ? "不规则 / 未知" : `${result.stats.nominal_rate_hz.toFixed(2)} Hz` }}</dd></div>
          <div><dt>已映射关节</dt><dd>{{ result.stats.joints_mapped.length }} / 28</dd></div>
          <div><dt>缺失关节</dt><dd>{{ result.stats.joints_missing.length }}</dd></div>
          <div><dt>底盘位姿</dt><dd>{{ result.stats.chassis.available ? `可用 · ${result.stats.chassis.frame || "坐标系未声明"}` : "不可用" }}</dd></div>
        </dl>
        <p class="parser-value"><span>解析器</span><code>{{ result.parser || "未提供" }}</code></p>
        <p v-if="result.stats.joints_missing.length" class="missing-joints">缺失：{{ result.stats.joints_missing.join("、") }}</p>
        <p v-if="result.parser === 'b041_bundle_v1'" class="provisional-note">暂定映射：夹爪位移与底盘轨迹采用映射快照中的暂定假设，推算结果尚非精确标定。</p>
      </details>
      <details class="detail-section" open>
        <summary>映射快照 <span class="readonly-label">只读</span></summary>
        <dl class="identity-facts"><div><dt>快照 ID</dt><dd><code>{{ result.mapping_snapshot_id || "未提供" }}</code></dd></div></dl>
        <div class="text-actions"><span>本次导入实际使用的完整映射</span><n-button size="small" text :disabled="result.mapping_snapshot == null" @click="copyText(mappingText, '映射快照')">复制快照</n-button></div>
        <pre data-testid="log-details-mapping" tabindex="0" aria-label="只读映射快照 JSON">{{ mappingText }}</pre>
        <p class="details-hint">每次上传生成独立的不可变快照；此处只读，查看不影响当前回放。</p>
      </details>
      <details class="detail-section" open>
        <summary>解析诊断 · {{ result.issues.length }}</summary>
        <p v-if="!result.issues.length" class="details-hint">此日志未返回解析诊断。</p>
        <ol v-else class="diagnostic-list">
          <li v-for="(issue, index) in result.issues" :key="index" :class="['diagnostic', `diagnostic-${issue.severity}`]">
            <div class="diagnostic-heading"><strong>{{ severityNames[issue.severity] }}</strong><code>{{ issue.code || "未提供" }}</code></div>
            <p>{{ issue.message || "未提供" }}</p>
            <dl class="diagnostic-location"><div><dt>行号</dt><dd>{{ issue.line ?? "未提供" }}</dd></div><div><dt>通道</dt><dd><code>{{ issue.channel || "未提供" }}</code></dd></div></dl>
            <details><summary>诊断详情</summary><pre>{{ issue.details == null ? "未提供" : JSON.stringify(issue.details, null, 2) }}</pre></details>
          </li>
        </ol>
      </details>
      <details class="detail-section hash-section">
        <summary>上传原文件 SHA256</summary>
        <div class="text-actions"><span>原文件内容摘要</span><n-button size="small" text :disabled="!result.raw_file_sha256" @click="copyText(result.raw_file_sha256, 'SHA256')">复制 SHA256</n-button></div>
        <pre tabindex="0" aria-label="上传原文件 SHA256">{{ result.raw_file_sha256 || "未提供" }}</pre>
        <p class="details-hint">原文件引用（仅作记录）</p>
        <code class="raw-file-reference">{{ result.raw_file_ref || "未提供" }}</code>
      </details>
      <p v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</p>
    </template>
  </section>
</template>

<style scoped>
.log-details { font-size: 14px; color: var(--text, #18304e); }
.log-details-heading { padding-bottom: 14px; }
.role-label, .readonly-label { display: inline-block; border-radius: 4px; padding: 3px 8px; font-size: 12px; line-height: 1.5; background: #eaf7f0; color: #236b4e; }
.role-label.candidate { background: #fff1d6; color: #8c5b16; }
.log-details-heading h3 { font-size: 17px; line-height: 1.5; font-weight: 600; margin: 12px 0; overflow-wrap: anywhere; }
.identity-facts { display: grid; gap: 8px; margin: 12px 0 0; font-size: 12px; }
.identity-facts > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 10px; }
.identity-facts dt { color: #60748c; }
.identity-facts dd { margin: 0; overflow-wrap: anywhere; }
.details-unavailable { padding: 18px; background: #f3f6fa; border: 1px solid #dee6ef; color: #60748c; border-radius: 6px; font-size: 13px; line-height: 1.7; }
.detail-section { padding: 15px 0; border-top: 1px solid #dee6ef; }
.detail-section > summary { font-size: 16px; font-weight: 600; color: #18304e; padding: 4px 0; }
summary { cursor: pointer; }
summary:focus-visible, pre:focus-visible { outline: 2px solid #356fad; outline-offset: 3px; border-radius: 3px; }
.details-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid #dee6ef; border-radius: 6px; margin: 14px 0 0; overflow: hidden; }
.details-stats > div { padding: 12px; border-bottom: 1px solid #e4ebf3; }
.details-stats dt { color: #60748c; font-size: 12px; margin-bottom: 5px; }
.details-stats dd { margin: 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.parser-value { display: flex; gap: 14px; padding: 0 10px; font-size: 12px; overflow-wrap: anywhere; }
.parser-value span, .details-hint { color: #60748c; }
.details-hint, .missing-joints { font-size: 12px; line-height: 1.7; margin: 10px 0 0; overflow-wrap: anywhere; }
.missing-joints { color: #8c5b16; }
.provisional-note { padding: 12px; background: #fff6e7; border: 1px solid #f0d5a9; border-radius: 6px; color: #89560f; font-size: 13px; line-height: 1.6; margin: 14px 0 0; }
.readonly-label { margin-left: 7px; background: #edf4fc; color: #356fad; font-size: 11px; font-weight: 500; vertical-align: middle; }
.text-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; font-size: 12px; color: #60748c; }
pre { padding: 14px; background: #f3f6fa; color: #254568; border-radius: 6px; font-size: 12px; line-height: 1.7; max-height: 350px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
.diagnostic-list { padding: 0; margin: 12px 0 0; list-style: none; }
.diagnostic { padding: 10px 12px; margin-top: 10px; border-left: 3px solid #8ca5c0; background: #f3f7fc; border-radius: 3px; font-size: 12px; overflow-wrap: anywhere; }
.diagnostic-heading { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
.diagnostic p { line-height: 1.7; margin: 8px 0; }
.diagnostic-location { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 0; color: #60748c; }
.diagnostic-location > div { display: flex; gap: 8px; }
.diagnostic-location dd { margin: 0; }
.diagnostic > details { margin-top: 10px; }
.diagnostic > details summary { color: #356fad; }
.diagnostic-error { border-color: #c45055; background: #fff3f3; }
.diagnostic-error strong { color: #a83239; }
.diagnostic-warning { border-color: #c48a31; background: #fff8ec; }
.diagnostic-warning strong { color: #8c5b16; }
.raw-file-reference { display: block; font-size: 12px; overflow-wrap: anywhere; margin-top: 8px; }
.hash-section { border-bottom: 1px solid #dee6ef; }
.copy-status { color: #356fad; font-size: 12px; line-height: 1.6; }
@media (max-width: 520px) { .details-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
