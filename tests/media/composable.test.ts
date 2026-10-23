import { it, expect, vi } from "vitest";
import { effectScope } from "vue";
import { useVideoSource } from "../../src/composables/useVideoSource";
it("releases the selected source when its Vue scope is disposed", () => {
  const unsubscribe = vi.fn(),
    scope = effectScope();
  const source = scope.run(() =>
    useVideoSource({
      subscribeFrames: () => unsubscribe,
      getScenario: () => "normal",
    }),
  )!;
  source.connect("s", () => {});
  scope.stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(source.capabilities.kind).toBe("mock");
});
