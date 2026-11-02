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
  expect(timeToChartX(6, 0, 12)).toBe(804);
  expect(timeToChartX(12, 0, 12)).toBe(1548);
  expect(timeToChartX(-5, 0, 12)).toBe(60);
  expect(timeToChartX(20, 0, 12)).toBe(1548);
  expect(timeToChartX(1, 1, 1)).toBe(60);
});
it("can be created and disposed before a browser canvas exists", () => {
  const chart = createHistoryChart();
  expect(chart.getCanvas()).toBeNull();
  chart.dispose();
  expect(chart.getCanvas()).toBeNull();
});
it('gives four independently labelled tracks enough height and readable axes', () => {
  const data = curve();
  data.series = [data.series[0]!, data.series[1]!, { ...data.series[0]!, channel: 'c' }, { ...data.series[1]!, channel: 'd' }];
  const option = historyChartOption(data, ['a', 'b', 'c', 'd']);
  expect((option.grid as any[]).map(grid => grid.height)).toEqual([52, 52, 52, 52]);
  expect((option.yAxis as any[]).every(axis => axis.axisLabel.fontSize >= 15 && axis.nameTextStyle.fontSize >= 15)).toBe(true);
  expect((option.xAxis as any[]).at(-1).axisLabel.fontSize).toBeGreaterThanOrEqual(15);
});
