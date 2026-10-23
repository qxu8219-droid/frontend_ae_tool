import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type {
  CurveResponse,
  FrameSnapshot,
  Schema,
  WsServerMessage,
} from "../domain/types";

type AlertMessage = Extract<WsServerMessage, { type: "alert" }>;
export type HistoryAlert = AlertMessage["data"];
export interface HistoryEvent {
  id: string;
  log_id: string;
  time_s: number;
  channel: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}
const MAX_ALERTS = 1000;

export const useHistoryStore = defineStore("history", () => {
  const sessionId = ref(""),
    logId = ref("");
  const channels = shallowRef<Schema["ChannelDescriptor"][]>([]);
  const selected = ref<string[]>([]),
    curve = shallowRef<CurveResponse | null>(null);
  const loading = ref(false),
    error = ref("");
  const severity = ref<"all" | "info" | "warning" | "error">("all");
  const view = ref<"history" | "triggered">("history");
  const triggered = shallowRef<HistoryAlert[]>([]);
  let pending: HistoryAlert[] = [],
    presented: FrameSnapshot | null = null;

  function alertKey(alert: HistoryAlert) {
    return `${alert.log_id}:${alert.joint_index ?? alert.source}:${alert.log_time_s}`;
  }
  function eventChannel(alert: HistoryAlert) {
    return (
      channels.value.find((c) => c.joint_index === alert.joint_index)?.name ??
      (alert.joint_index == null ? alert.source : `joint ${alert.joint_index}`)
    );
  }
  const events = computed<HistoryEvent[]>(() => {
    const byKey = new Map<string, HistoryEvent>();
    for (const series of curve.value?.series ?? [])
      for (const interval of series.limit_intervals ?? []) {
        const id = `${logId.value}:${interval.channel}:${interval.from_s}`;
        byKey.set(id, {
          id,
          log_id: logId.value,
          time_s: interval.from_s,
          channel: interval.channel,
          severity: interval.severity,
          code: interval.code,
          message: `${interval.severity === "error" ? "超出限位" : "接近限位"} · ${interval.from_s.toFixed(3)}–${interval.to_s.toFixed(3)} s`,
        });
      }
    return [...byKey.values()].sort(
      (a, b) => a.time_s - b.time_s || a.channel.localeCompare(b.channel),
    );
  });
  const filteredEvents = computed<HistoryEvent[]>(() => {
    const all =
      view.value === "history"
        ? events.value
        : triggered.value.map((alert) => ({
            id: alertKey(alert),
            log_id: alert.log_id!,
            time_s: alert.log_time_s!,
            channel: eventChannel(alert),
            severity: alert.severity,
            code: alert.code,
            message: alert.message,
          }));
    return all
      .filter((e) => severity.value === "all" || e.severity === severity.value)
      .sort(
        (a, b) => b.time_s - a.time_s || a.channel.localeCompare(b.channel),
      );
  });

  function reset() {
    sessionId.value = "";
    logId.value = "";
    channels.value = [];
    selected.value = [];
    curve.value = null;
    loading.value = false;
    error.value = "";
    triggered.value = [];
    pending = [];
    presented = null;
    severity.value = "all";
    view.value = "history";
  }
  function setContext(sid: string, lid: string) {
    if (sessionId.value === sid && logId.value === lid) return;
    reset();
    sessionId.value = sid;
    logId.value = lid;
  }
  function setSelected(names: readonly string[]) {
    const known = new Set(channels.value.map((c) => c.name));
    selected.value = [...new Set(names)]
      .filter((name) => known.has(name))
      .slice(0, 4);
  }
  function setChannels(value: Schema["ChannelDescriptor"][]) {
    channels.value = value;
    const preferred = [
      "torso_joint1",
      "left_arm_joint1",
      "right_arm_joint1",
      "right_gripper_finger_joint2",
    ].filter((name) => value.some((c) => c.name === name));
    setSelected(
      selected.value.length
        ? selected.value
        : preferred.length
          ? preferred
          : value.slice(0, 2).map((c) => c.name),
    );
  }
  function setCurve(value: CurveResponse) {
    if (value.log_id !== logId.value) return;
    curve.value = {
      ...value,
      series: value.series.map((series) => ({
        ...series,
        points: [
          ...new Map(
            series.points.map((point) => [point.time_s, point]),
          ).values(),
        ].sort((a, b) => a.time_s - b.time_s),
      })),
    };
  }
  function release() {
    if (!presented) return;
    const accepted = new Map(
      triggered.value.map((alert) => [alertKey(alert), alert]),
    );
    const waiting: HistoryAlert[] = [];
    for (const alert of pending) {
      if (alert.playback_epoch! < presented.playback_epoch) continue;
      if (
        alert.playback_epoch === presented.playback_epoch &&
        alert.log_time_s! <= presented.log_time_s
      )
        accepted.set(alertKey(alert), alert);
      else waiting.push(alert);
    }
    pending = waiting;
    triggered.value = [...accepted.values()]
      .sort((a, b) => a.log_time_s! - b.log_time_s!)
      .slice(-MAX_ALERTS);
  }
  function ingestAlert(input: HistoryAlert | AlertMessage) {
    if ("type" in input && input.session_id !== sessionId.value) return;
    const alert = "type" in input ? input.data : input;
    // Non-log operational alerts belong to the independent health/status stream.
    if (
      alert.log_id !== logId.value ||
      alert.log_time_s == null ||
      !Number.isFinite(alert.log_time_s) ||
      alert.playback_epoch == null
    )
      return;
    if (presented && alert.playback_epoch < presented.playback_epoch) return;
    const key = `${alert.playback_epoch}:${alertKey(alert)}`;
    pending = pending.filter(
      (old) => `${old.playback_epoch}:${alertKey(old)}` !== key,
    );
    pending.push(alert);
    pending = pending.slice(-MAX_ALERTS);
    release();
  }
  function present(frame: FrameSnapshot) {
    if (frame.session_id !== sessionId.value || frame.log_id !== logId.value)
      return;
    if (
      presented &&
      (frame.playback_epoch < presented.playback_epoch ||
        frame.capture_id <= presented.capture_id)
    )
      return;
    if (presented && frame.playback_epoch !== presented.playback_epoch)
      triggered.value = [];
    presented = frame;
    release();
  }
  return {
    sessionId,
    logId,
    channels,
    selected,
    curve,
    loading,
    error,
    events,
    severity,
    view,
    triggered,
    filteredEvents,
    reset,
    setContext,
    setSelected,
    setChannels,
    setCurve,
    ingestAlert,
    present,
  };
});
