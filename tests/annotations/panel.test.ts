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

it('renders navigation and the final source records while keeping unaligned events nonseekable', async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  const store = useAnnotationStore(); store.setContext('s', 'l');
  const original = example<Schema['LogAnnotations']>('service/log_annotations');
  store.data = { ...original, log_id: 'l',
    segments: Array.from({ length: 256 }, (_, index) => ({ ...original.segments[0]!, id: `stage-${index + 1}`,
      label: `History stage ${index + 1}`, start_s: index, end_s: index + 1, start_frame: index, end_frame: index + 1 })),
    events: Array.from({ length: 256 }, (_, index) => ({ id: `event-${index + 1}`, time_s: null,
      kind: `diagnostic-${index + 1}`, message: `History event ${index + 1}`, details: {} })),
  };
  const telemetry = useTelemetryStore(); telemetry.context('s', 1);
  telemetry.accept({ ...example('protocol/FrameSnapshot'), session_id: 's', log_id: 'l', log_time_s: .5 }, 1);
  const render = () => renderToString(createSSRApp(AnnotationPanel, { disabled: false }).use(pinia));
  const first = await render();
  expect(first).toContain('History event 100');
  expect(first).not.toContain('History event 101');
  expect(first).toMatch(/<button[^>]*disabled[^>]*>上一页<\/button>/);
  store.setEventPage(3); store.setSegmentPage(3);
  const last = await render();
  expect(last).toContain('History event 256');
  expect(last).toContain('History stage 256');
  expect(last).not.toContain('History event 200');
  expect(last).toContain('201–256 / 256');
  expect(last).toMatch(/<button[^>]*disabled[^>]*>下一页<\/button>/);
  expect(last).toMatch(/<button[^>]*disabled[^>]*>[^<]*无法对齐 · 不可定位 · diagnostic-256[^<]*<\/button>/);
});
