import { defineStore } from "pinia";
import { ref } from "vue";
import type { ScenarioId } from "../domain/types";
import type { Schema } from "../domain/types";
export const useUiStore = defineStore("ui", () => {
  const busy = ref(0),
    creating = ref(false),
    error = ref<string | null>(null),
    scenario = ref<ScenarioId>("normal"),
    mediaStatus = ref("等待会话");
  const uploadIssues = ref<Schema["ParseIssue"][]>([]),
    uploading = ref(false),
    cleanupSessionId = ref<string | null>(null),
    intentRevision = ref(0),
    collapsedGroups = ref<string[]>([]);
  const activity = ref<Array<{ at: number; message: string }>>([]);
  function log(message: string) {
    activity.value = [{ at: Date.now(), message }, ...activity.value].slice(
      0,
      30,
    );
  }
  return {
    busy,
    creating,
    error,
    scenario,
    mediaStatus,
    activity,
    log,
    uploadIssues,
    uploading,
    collapsedGroups,
    cleanupSessionId,
    intentRevision,
  };
});
