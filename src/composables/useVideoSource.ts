import { getCurrentScope, onScopeDispose } from "vue";
import {
  createMockVideoSource,
  type MockFrameRuntime,
} from "../media/source";
import { createWhepVideoSource } from '../media/whep';

/** Source selection is explicit; real mode never falls back to synthetic frames. */
export function useVideoSource(runtime?: MockFrameRuntime) {
  const source = runtime
    ? createMockVideoSource(runtime)
    : createWhepVideoSource();
  if (getCurrentScope()) onScopeDispose(() => source.disconnect());
  return source;
}
