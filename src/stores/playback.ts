import { defineStore } from "pinia";
import { shallowRef, toRaw } from "vue";
import type { PlaybackSnapshot, UploadResult } from "../domain/types";

export interface ImportedLogDetails {
  sessionId: string;
  result: UploadResult;
  fileName: string;
  fileSize: number;
  importedAt: number;
}

export const usePlaybackStore = defineStore("playback", () => {
  const server = shallowRef<PlaybackSnapshot | null>(null),
    uploaded = shallowRef<UploadResult | null>(null);
  const importedDetails = shallowRef(new Map<string, ImportedLogDetails>());
  let candidateSessionId: string | null = null;

  function detailsKey(sid: string, lid: string) {
    return JSON.stringify([sid, lid]);
  }
  function beginUpload(sid: string): void {
    candidateSessionId = sid;
    uploaded.value = null;
  }
  function recordUpload(
    sid: string,
    result: UploadResult,
    file: { name: string; size: number },
    importedAt = Date.now(),
  ): void {
    const snapshot = structuredClone(toRaw(result));
    const key = detailsKey(sid, snapshot.log_id);
    const next = new Map(importedDetails.value);
    // Refresh insertion order when the same log is imported again.
    next.delete(key);
    next.set(key, {
      sessionId: sid,
      result: snapshot,
      fileName: file.name,
      fileSize: file.size,
      importedAt,
    });
    candidateSessionId = sid;
    // Keep compatibility edits separate from the retained import snapshot.
    uploaded.value = structuredClone(snapshot);
    const active = server.value;
    const activeKey = active?.log_id
      ? detailsKey(active.session_id, active.log_id)
      : null;
    const candidateKey = detailsKey(candidateSessionId, uploaded.value.log_id);
    for (const retainedKey of next.keys()) {
      if (next.size <= 8) break;
      if (retainedKey !== activeKey && retainedKey !== candidateKey)
        next.delete(retainedKey);
    }
    importedDetails.value = next;
  }
  function getLogDetails(
    sid: string,
    lid: string | null | undefined,
  ): ImportedLogDetails | null {
    if (!lid) return null;
    return importedDetails.value.get(detailsKey(sid, lid)) ?? null;
  }
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
    candidateSessionId = null;
    importedDetails.value = new Map();
  }
  return { server, uploaded, update, beginUpload, recordUpload, getLogDetails, reset };
});
