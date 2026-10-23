import { getCurrentScope, onScopeDispose } from "vue";
import {
  createMockVideoSource,
  createUnavailableVideoSource,
  type MockFrameRuntime,
} from "../media/source";

/** Source selection is explicit; real mode never falls back to synthetic frames. */
export function useVideoSource(runtime?: MockFrameRuntime) {
  const source = runtime
    ? createMockVideoSource(runtime)
    : createUnavailableVideoSource();
  if (getCurrentScope()) onScopeDispose(() => source.disconnect());
  return source;
}
