import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { FrameSnapshot } from "../domain/types";
export const useTelemetryStore = defineStore("telemetry", () => {
  const presented = shallowRef<FrameSnapshot | null>(null),
    generation = ref(0),
    sid = ref("");
  const count = ref(0),
    wallMs = ref(0);
  function context(sessionId: string, nextGeneration: number) {
    if (sid.value !== sessionId) {
      presented.value = null;
      count.value = 0;
      wallMs.value = 0;
    }
    sid.value = sessionId;
    generation.value = nextGeneration;
  }
  function canAccept(frame: FrameSnapshot, fromGeneration: number) {
    if (frame.session_id !== sid.value || generation.value !== fromGeneration)
      return false;
    const old = presented.value;
    if (
      old &&
      (frame.capture_id <= old.capture_id ||
        frame.playback_epoch < old.playback_epoch ||
        frame.control_seq < old.control_seq)
    )
      return false;
    return true;
  }
  function accept(frame: FrameSnapshot, fromGeneration: number) {
    if (!canAccept(frame, fromGeneration)) return false;
    presented.value = frame;
    count.value++;
    wallMs.value = Date.now();
    return true;
  }
  return {
    presented,
    count,
    wallMs,
    generation,
    sid,
    context,
    canAccept,
    accept,
  };
});
