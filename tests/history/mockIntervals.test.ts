import { expect, it } from "vitest";
import { createMockRuntime } from "../../src/mocks/runtime";
it("prescans warning and exceeded ranges before downsampling and clips them to the requested range", async () => {
  let now = 0;
  const r = createMockRuntime({ now: () => now });
  try {
    const sid = r.createSession({
      scene_id: r.getScenes().scenes[0].id,
      robot_id: r.getRobots().robots[0].id,
    }).session_id;
    now = 400;
    r.tick();
    const log = await r.uploadLog(sid, new File(["fixture"], "fixture.log"));
    const name = log.channels.find(
      (c) =>
        c.lower !== null &&
        c.lower !== undefined &&
        c.upper !== null &&
        c.upper !== undefined,
    )!.name;
    const full = r.getCurve(sid, log.log_id, { channels: name, max_points: 2 });
    expect(full.series[0].points).toHaveLength(2);
    expect(
      full.series[0].limit_intervals?.some((i) => i.severity === "warning"),
    ).toBe(true);
    expect(
      full.series[0].limit_intervals?.some((i) => i.severity === "error"),
    ).toBe(true);
    const first = full.series[0].limit_intervals![0];
    const from = (first.from_s + first.to_s) / 2;
    const clipped = r.getCurve(sid, log.log_id, {
      channels: name,
      from_s: from,
      to_s: first.to_s,
      max_points: 2,
    });
    expect(clipped.series[0].limit_intervals![0].from_s).toBe(from);
    expect(
      clipped.series[0].limit_intervals!.every(
        (i) => i.from_s >= from && i.to_s <= first.to_s,
      ),
    ).toBe(true);
  } finally {
    r.dispose();
  }
});
it("never emits position-limit intervals for continuous or missing channels", async () => {
  let now = 0;
  const r = createMockRuntime({ now: () => now });
  try {
    const sid = r.createSession({
      scene_id: r.getScenes().scenes[0].id,
      robot_id: r.getRobots().robots[0].id,
    }).session_id;
    now = 400;
    r.tick();
    r.setScenario("missing-channels");
    const log = await r.uploadLog(sid, new File(["fixture"], "fixture.log"));
    const names = log.channels
      .filter(
        (c) =>
          c.quality.origin === "missing" ||
          c.angle_semantics === "angular_unwrapped",
      )
      .map((c) => c.name);
    const response = r.getCurve(sid, log.log_id, { channels: names.join(",") });
    expect(response.series.every((s) => s.limit_intervals?.length === 0)).toBe(
      true,
    );
    expect(
      response.series
        .filter(
          (s) =>
            log.channels.find((c) => c.name === s.channel)?.quality.origin ===
            "missing",
        )
        .every((s) => s.points.every((p) => p.value === null)),
    ).toBe(true);
  } finally {
    r.dispose();
  }
});
