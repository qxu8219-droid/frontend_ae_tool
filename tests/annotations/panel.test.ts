import { expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createPinia, setActivePinia } from 'pinia';
import AnnotationPanel from '../../src/components/AnnotationPanel.vue';
import { useAnnotationStore } from '../../src/stores/annotations';
import { useTelemetryStore } from '../../src/stores/telemetry';
import { example } from '../api/fixtures';
import type { Schema } from '../../src/domain/types';

async function panel(referenceOnly = false, presented = true) {
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useAnnotationStore(); store.setContext('s', 'l');
  store.data = { ...example<Schema['LogAnnotations']>('service/log_annotations'), log_id: 'l',
    ...(referenceOnly ? { alignment: 'reference_only' as const, segments: [], reference: { label: 'earlier run' } } : {}) };
  if (presented) {
    const telemetry = useTelemetryStore(); telemetry.context('s', 1);
    telemetry.accept({ ...example('protocol/FrameSnapshot'), session_id: 's', log_id: 'l', log_time_s: .5 }, 1);
  }
  return renderToString(createSSRApp(AnnotationPanel, { disabled: false }).use(pinia));
}
it('shows provisional assumptions and unapproved review status without turning diagnostic events into current facts', async () => {
  const html = await panel();
  expect(html).toContain('Example provisional calibration');
  expect(html).toContain('暂定假设');
  expect(html).toContain('pending_review');
  expect(html).toContain('training_approved=false');
  expect(html).toContain('历史事件');
  expect(html).toContain('无法对齐');
});
it('labels reference-only history as unaligned and cannot present its labels as the current segment', async () => {
  const html = await panel(true);
  expect(html).toContain('仅供历史来源参考');
  expect(html).toContain('未对齐当前运行');
  expect(html).not.toContain('annotation-current-segment');
  expect(html).toContain('earlier run');
});
it('waits for presented telemetry even if annotation metadata arrived first', async () => {
  const html = await panel(false, false);
  expect(html).toContain('等待对应日志画面');
  expect(html).not.toContain('annotation-current-segment');
  expect(html).not.toContain('Example stage');
});
