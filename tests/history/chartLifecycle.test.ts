import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { curve } from "./fixtures";
const render = vi.hoisted(() => ({ fail: false }));
vi.mock("echarts/core", () => ({
  use() {},
  init: () => ({
    setOption() {
      if (render.fail) throw new Error("Raster unavailable");
    },
    clear() {},
    dispose() {},
    getZr: () => ({ flush() {} }),
  }),
}));
vi.mock("echarts/charts", () => ({ LineChart: {} }));
vi.mock("echarts/components", () => ({
  GridComponent: {},
  TitleComponent: {},
  MarkAreaComponent: {},
}));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));
import { createHistoryChart } from "../../src/media/historyChart";
beforeEach(() => {
  render.fail = false;
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0 }) });
});
afterEach(() => vi.unstubAllGlobals());
it("never labels an old or unfinished raster with a newer log identity", async () => {
  const chart = createHistoryChart();
  const old = chart.update(curve("old"), ["a"]);
  expect(chart.getCanvas()).toBeNull();
  const fresh = chart.update(curve("new"), ["b"]);
  await Promise.all([old, fresh]);
  expect(chart.getState()).toMatchObject({
    logId: "new",
    from: 0,
    to: 12,
    ready: true,
    error: null,
  });
  expect(chart.getCanvas()).not.toBeNull();
  const later = chart.update(curve("later"), ["a"]);
  expect(chart.getCanvas()).toBeNull();
  await later;
  expect(chart.getState().logId).toBe("later");
  await chart.update(null, []);
  expect(chart.getCanvas()).toBeNull();
  chart.dispose();
});
it("handles raster initialization/render failure without exposing stale pixels or rejecting", async () => {
  const chart = createHistoryChart();
  await chart.update(curve("old"), ["a"]);
  render.fail = true;
  await expect(chart.update(curve("new"), ["a"])).resolves.toBeUndefined();
  expect(chart.getCanvas()).toBeNull();
  expect(chart.getState()).toMatchObject({
    ready: false,
    error: "Raster unavailable",
  });
  chart.dispose();
});
it("cannot revive a raster when disposed during lazy initialization", async () => {
  const chart = createHistoryChart();
  const work = chart.update(curve(), ["a"]);
  chart.dispose();
  await work;
  expect(chart.getCanvas()).toBeNull();
  expect(chart.getState().ready).toBe(false);
});
