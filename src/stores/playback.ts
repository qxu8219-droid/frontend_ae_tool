import { defineStore } from "pinia";
import { shallowRef } from "vue";
import type { PlaybackSnapshot, UploadResult } from "../domain/types";
export const usePlaybackStore = defineStore("playback", () => {
  const server = shallowRef<PlaybackSnapshot | null>(null),
    uploaded = shallowRef<UploadResult | null>(null);
  function update(value: PlaybackSnapshot) {
    const old = server.value;
    if (
      old &&
      old.session_id === value.session_id &&
      (value.control_seq < old.control_seq ||
        value.playback_epoch < old.playback_epoch)
    )
      return false;
    server.value = value;
    return true;
  }
  function reset() {
    server.value = null;
    uploaded.value = null;
  }
  return { server, uploaded, update, reset };
});
