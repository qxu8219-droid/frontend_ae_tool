import type { ApiClient } from "../api/client";
import { useHistoryStore } from "../stores/history";

export function createHistoryLoader(
  api: Pick<ApiClient, "channels" | "curve">,
) {
  const store = useHistoryStore();
  let generation = 0,
    controller: AbortController | null = null;
  function cancel() {
    generation++;
    controller?.abort();
    controller = null;
    store.loading = false;
  }
  async function load(sid: string, lid: string, duration: number) {
    cancel();
    const current = generation,
      request = new AbortController();
    controller = request;
    store.setContext(sid, lid);
    store.loading = true;
    store.error = "";
    const active = () =>
      current === generation &&
      !request.signal.aborted &&
      store.sessionId === sid &&
      store.logId === lid;
    try {
      const response = await api.channels(sid, lid, { signal: request.signal });
      if (!active()) return;
      if (response.log_id !== lid) throw new Error("通道响应不属于当前日志");
      store.setChannels(response.channels);
      if (!response.channels.length) {
        store.curve = null;
        return;
      }
      const curve = await api.curve(
        sid,
        lid,
        {
          channels: response.channels.map((channel) => channel.name),
          from_s: 0,
          to_s: duration,
          max_points: 2000,
        },
        { signal: request.signal },
      );
      if (!active()) return;
      if (curve.log_id !== lid) throw new Error("曲线响应不属于当前日志");
      store.setCurve(curve);
    } catch (error) {
      if (active())
        store.error =
          error instanceof Error ? error.message : "历史数据加载失败";
    } finally {
      if (active()) {
        store.loading = false;
        controller = null;
      }
    }
  }
  return { load, cancel };
}
