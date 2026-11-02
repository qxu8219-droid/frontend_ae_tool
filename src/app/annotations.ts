import type { ApiClient } from '../api/client';
import { useAnnotationStore } from '../stores/annotations';

/** Metadata is historical context. Current stage selection belongs to presented telemetry. */
export function createAnnotationLoader(api: Partial<Pick<ApiClient, 'annotations'>>) {
  const store = useAnnotationStore();
  let generation = 0, controller: AbortController | null = null;
  function cancel() {
    generation++; controller?.abort(); controller = null; store.loading = false;
  }
  async function load(sid: string, lid: string) {
    cancel();
    const ticket = generation, request = new AbortController();
    controller = request; store.setContext(sid, lid); store.loading = true;
    const active = () => ticket === generation && !request.signal.aborted && store.sessionId === sid && store.logId === lid;
    try {
      if (!api.annotations) throw new Error('此连接暂不提供标注接口');
      const response = await api.annotations(sid, lid, { signal: request.signal });
      if (!active()) return;
      if (response.log_id !== lid) throw new Error('标注响应不属于当前日志');
      store.data = response;
    } catch (error) {
      if (active()) store.error = error instanceof Error ? error.message : '标注加载失败';
    } finally {
      if (active()) { store.loading = false; controller = null; }
    }
  }
  return { load, cancel };
}
