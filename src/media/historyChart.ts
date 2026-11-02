import type { EChartsCoreOption, ECharts } from "echarts/core";
import type { CurveResponse } from "../domain/types";

export const CHART_WIDTH = 1568,
  CHART_HEIGHT = 336;
export const CHART_PLOT = Object.freeze({
  left: 60,
  right: 20,
  top: 32,
  bottom: 36,
});
export function timeToChartX(time: number, from: number, to: number) {
  const ratio =
    to > from && Number.isFinite(time)
      ? Math.min(1, Math.max(0, (time - from) / (to - from)))
      : 0;
  return (
    CHART_PLOT.left + ratio * (CHART_WIDTH - CHART_PLOT.left - CHART_PLOT.right)
  );
}

export function historyChartOption(
  curve: CurveResponse,
  selected: readonly string[],
): EChartsCoreOption {
  const names = [...new Set(selected)].slice(0, 4),
    series = names.flatMap((name) =>
      curve.series.filter((item) => item.channel === name),
    );
  const count = Math.max(1, series.length),
    gap = 20;
  const height =
    (CHART_HEIGHT - CHART_PLOT.top - CHART_PLOT.bottom - gap * (count - 1)) /
    count;
  const colors = ["#2878d0", "#8052b4", "#008c81", "#a66000"];
  return {
    animation: false,
    backgroundColor: "#ffffff",
    textStyle: { color: "#60748c", fontFamily: "sans-serif" },
    title: {
      text: series.length ? "" : "选择通道以查看历史曲线",
      left: 16,
      top: 8,
      textStyle: { fontSize: 13, fontWeight: "normal", color: "#18304e" },
    },
    grid: series.map((_, i) => ({
      left: CHART_PLOT.left,
      right: CHART_PLOT.right,
      top: CHART_PLOT.top + i * (height + gap),
      height,
      containLabel: false,
    })),
    xAxis: series.map((_, i) => ({
      type: "value",
      gridIndex: i,
      min: curve.from_s,
      max: curve.to_s,
      axisLabel: {
        show: i === count - 1,
        fontSize: 15,
        formatter: "{value} s",
      },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#9eafc1" } },
      splitLine: { lineStyle: { color: "#dee6ef" } },
    })),
    yAxis: series.map((item, i) => ({
      type: "value",
      gridIndex: i,
      name: `${item.channel} [${item.unit}]`,
      nameLocation: "end",
      nameGap: 3,
      nameTextStyle: { align: "left", fontSize: 15, color: colors[i] },
      scale: true,
      axisLabel: {
        fontSize: 15,
        formatter: (value: number) =>
          Math.abs(value) >= 1000
            ? value.toExponential(0)
            : Number(value.toPrecision(3)).toString(),
      },
      splitNumber: count > 2 ? 1 : 2,
      splitLine: { lineStyle: { color: "#dee6ef" } },
    })),
    series: series.map((item, i) => ({
      name: item.channel,
      type: "line",
      xAxisIndex: i,
      yAxisIndex: i,
      showSymbol: false,
      connectNulls: false,
      silent: true,
      lineStyle: { color: colors[i], width: 1.5 },
      data: item.points.map((point) => [
        point.time_s,
        point.quality.valid &&
        point.quality.origin !== "missing" &&
        point.value !== null &&
        Number.isFinite(point.value)
          ? point.value
          : null,
      ]),
      markArea: {
        silent: true,
        data: (item.limit_intervals ?? []).map((interval) => [
          {
            xAxis: interval.from_s,
            itemStyle: {
              color:
                interval.severity === "error"
                  ? "rgba(244,98,112,0.2)"
                  : "rgba(246,190,83,0.15)",
            },
          },
          { xAxis: interval.to_s },
        ]),
      },
    })),
  };
}

/** Detached, static raster. Only the shared presentation renderer draws its moving cursor. */
export function createHistoryChart() {
  let chart: ECharts | null = null,
    canvas: HTMLCanvasElement | null = null;
  let revision = 0,
    disposed = false,
    lastCurve: CurveResponse | null = null,
    lastSelection = "";
  let initializing: Promise<void> | null = null;
  let state: {
    logId: string | null;
    from: number;
    to: number;
    ready: boolean;
    error: string | null;
  } = { logId: null, from: 0, to: 0, ready: false, error: null };
  async function initialize() {
    if (chart || disposed || typeof document === "undefined") return;
    initializing ??= (async () => {
      const [echarts, charts, components, renderers] = await Promise.all([
        import("echarts/core"),
        import("echarts/charts"),
        import("echarts/components"),
        import("echarts/renderers"),
      ]);
      if (disposed) return;
      echarts.use([
        charts.LineChart,
        components.GridComponent,
        components.TitleComponent,
        components.MarkAreaComponent,
        renderers.CanvasRenderer,
      ]);
      canvas = document.createElement("canvas");
      canvas.width = CHART_WIDTH;
      canvas.height = CHART_HEIGHT;
      chart = echarts.init(canvas, undefined, {
        renderer: "canvas",
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        devicePixelRatio: 1,
      });
    })();
    await initializing;
  }
  async function update(
    value: CurveResponse | null,
    selected: readonly string[],
  ) {
    const selection = JSON.stringify([...new Set(selected)].slice(0, 4));
    if (disposed || (value === lastCurve && selection === lastSelection))
      return;
    lastCurve = value;
    lastSelection = selection;
    const current = ++revision;
    state = { logId: null, from: 0, to: 0, ready: false, error: null };
    try {
      if (!value) {
        chart?.clear();
        return;
      }
      await initialize();
      if (current !== revision || disposed || !chart) return;
      chart.setOption(historyChartOption(value, JSON.parse(selection)), {
        notMerge: true,
        lazyUpdate: false,
      });
      chart.getZr().flush();
      state = {
        logId: value.log_id,
        from: value.from_s,
        to: value.to_s,
        ready: true,
        error: null,
      };
    } catch (error) {
      if (current !== revision || disposed) return;
      state = {
        logId: null,
        from: 0,
        to: 0,
        ready: false,
        error: error instanceof Error ? error.message : "曲线绘制失败",
      };
      lastCurve = null;
      initializing = null;
    }
  }
  return {
    update,
    getCanvas: () => (state.ready ? canvas : null),
    getState: () => ({ ...state }),
    dispose() {
      disposed = true;
      revision++;
      chart?.dispose();
      chart = null;
      canvas = null;
      lastCurve = null;
      state = { logId: null, from: 0, to: 0, ready: false, error: null };
    },
  };
}
