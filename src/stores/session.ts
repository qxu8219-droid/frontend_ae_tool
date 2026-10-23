import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { Schema, JointMetadata } from "../domain/types";
import type { SocketStatus } from "../api/socket";
export const useSessionStore = defineStore("session", () => {
  const sid = ref<string | null>(null),
    workerPhase = ref<string>("disconnected");
  const socket = shallowRef<SocketStatus>({ state: "closed", generation: 0 });
  const scenes = shallowRef<Schema["Scene"][]>([]),
    robots = shallowRef<Schema["Robot"][]>([]);
  const jointMeta = shallowRef<JointMetadata | null>(null);
  const sceneId = ref(""),
    robotId = ref("");
  function reset() {
    sid.value = null;
    workerPhase.value = "disconnected";
    socket.value = { state: "closed", generation: socket.value.generation };
  }
  return {
    sid,
    workerPhase,
    socket,
    scenes,
    robots,
    jointMeta,
    sceneId,
    robotId,
    reset,
  };
});
