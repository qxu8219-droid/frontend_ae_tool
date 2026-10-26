import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { Schema, JointMetadata } from "../domain/types";
import type { SocketStatus } from "../api/socket";
import type { HealthTelemetryData } from "../api/generated/ws-server.gen";
export const useSessionStore = defineStore("session", () => {
  const sid = ref<string | null>(null),
    workerPhase = ref<string>("disconnected");
  const syncState = ref('awaiting_pair'), waitingForControl = ref(false);
  const socket = shallowRef<SocketStatus>({ state: "closed", generation: 0 });
  const scenes = shallowRef<Schema["Scene"][]>([]),
    robots = shallowRef<Schema["Robot"][]>([]);
  const jointMeta = shallowRef<JointMetadata | null>(null);
  const health = shallowRef<HealthTelemetryData | null>(null),
    healthWallTime = ref(0);
  const sceneId = ref(""),
    robotId = ref("");
  function reset() {
    sid.value = null;
    workerPhase.value = "disconnected";
    syncState.value = 'awaiting_pair'; waitingForControl.value = false;
    health.value = null;
    healthWallTime.value = 0;
    socket.value = { state: "closed", generation: socket.value.generation };
  }
  return {
    sid,
    workerPhase,
    syncState,
    waitingForControl,
    socket,
    scenes,
    robots,
    jointMeta,
    health,
    healthWallTime,
    sceneId,
    robotId,
    reset,
  };
});
