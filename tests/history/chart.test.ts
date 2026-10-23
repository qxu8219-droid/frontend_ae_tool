import { expect, it } from "vitest";
import {
  createHistoryChart,
  historyChartOption,
  timeToChartX,
} from "../../src/media/historyChart";
import { curve } from "./fixtures";
it("draws invalid and missing points as gaps instead of connecting or displaying defaults", () => {
  const option = historyChartOption(curve(), ["a"]);
  const series = option.series as any[];
  expect(series[0].connectNulls).toBe(false);
  expect(series[0].data).toEqual([
    [0, 1],
    [1, null],
    [2, 2],
  ]);
  expect(series[0].markArea.data).toHaveLength(2);
});
it("separates differently scaled channels into grids with their own value axes", () => {
  const option = historyChartOption(curve(), ["a", "b"]);
  expect(option.grid as any[]).toHaveLength(2);
  expect((option.yAxis as any[]).map((a) => a.name)).toEqual([
    "a [rad]",
    "b [m]",
  ]);
  expect((option.series as any[]).map((s) => s.yAxisIndex)).toEqual([0, 1]);
  expect(option.animation).toBe(false);
});
it("keeps a shared time projection bounded for the renderer cursor and degenerate ranges", () => {
  expect(timeToChartX(0, 0, 12)).toBe(60);
  expect(timeToChartX(6, 0, 12)).toBe(640);
  expect(timeToChartX(12, 0, 12)).toBe(1220);
  expect(timeToChartX(-5, 0, 12)).toBe(60);
  expect(timeToChartX(20, 0, 12)).toBe(1220);
  expect(timeToChartX(1, 1, 1)).toBe(60);
});
it("can be created and disposed before a browser canvas exists", () => {
  const chart = createHistoryChart();
  expect(chart.getCanvas()).toBeNull();
  chart.dispose();
  expect(chart.getCanvas()).toBeNull();
});
