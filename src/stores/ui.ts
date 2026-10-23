import { defineStore } from "pinia";
import { ref } from "vue";
import type { ScenarioId } from "../domain/types";
export const useUiStore = defineStore("ui", () => {
  const busy = ref(0),
    creating = ref(false),
    error = ref<string | null>(null),
    scenario = ref<ScenarioId>("normal"),
    mediaStatus = ref("等待会话");
  const activity = ref<Array<{ at: number; message: string }>>([]);
  function log(message: string) {
    activity.value = [{ at: Date.now(), message }, ...activity.value].slice(
      0,
      30,
    );
  }
  return { busy, creating, error, scenario, mediaStatus, activity, log };
});
