import { describe, expect, it } from "vitest";
import { example } from "../api/fixtures";
import type { FrameSnapshot, JointMetadata } from "../../src/domain/types";
import canonicalMetadata from "../../src/api/fixtures/joint-metadata.json";
import {
  jointPanelGroups,
  qualityPresentation,
} from "../../src/media/panelModel";

const frame = () => example<FrameSnapshot>("protocol/FrameSnapshot");
const metadata = () => structuredClone(canonicalMetadata) as JointMetadata;

describe("joint panel semantics", () => {
  it("keeps all 28 canonical indices in their group when a group is collapsed", () => {
    const groups = jointPanelGroups(frame(), null, ["left"]);
    expect(groups.map((group) => group.rows.map((row) => row.index))).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18],
      [19, 20, 21, 22, 23, 24, 25, 26, 27],
    ]);
    expect(groups.map((group) => group.collapsed)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("shows missing and invalid values as unavailable instead of a meaningful zero", () => {
    const data = frame();
    data.joints[0] = 0;
    data.quality[0] = {
      origin: "missing",
      valid: false,
      processing: ["defaulted"],
    };
    data.joints[1] = 0;
    data.quality[1] = { origin: "measured", valid: false };
    data.limit_flags = 1;
    const rows = jointPanelGroups(data, null)[0]!.rows;
    expect(rows[0]).toMatchObject({
      valueText: "—",
      available: false,
      fraction: null,
      limitState: "unavailable",
    });
    expect(rows[1]).toMatchObject({
      valueText: "—",
      available: false,
      fraction: null,
      limitState: "unavailable",
    });
    expect(rows[0]!.quality.labels).toContain("默认");
  });

  it("maps finite limits to bounded progress and applies authoritative warn/error flags", () => {
    const data = frame();
    const meta = metadata();
    meta.joints[0] = { ...meta.joints[0], lower: -2, upper: 2 };
    data.joints[0] = 3;
    data.quality[0] = { origin: "measured", valid: true };
    data.limit_flags = 1;
    data.limit_warn_flags = 1;
    expect(jointPanelGroups(data, meta)[0]!.rows[0]).toMatchObject({
      fraction: 1,
      limitState: "exceeded",
      lower: -2,
      upper: 2,
    });
    data.joints[0] = -3;
    data.limit_flags = 0;
    expect(jointPanelGroups(data, meta)[0]!.rows[0]).toMatchObject({
      fraction: 0,
      limitState: "warning",
    });
    data.joints[0] = 1;
    data.limit_warn_flags = 0;
    expect(jointPanelGroups(data, meta)[0]!.rows[0]).toMatchObject({
      fraction: 0.75,
      limitState: "normal",
    });
  });

  it("never gives continuous wheels a finite range even if stale flags are set", () => {
    const data = frame();
    data.joints[1] = 12345;
    data.quality[1] = { origin: "derived", valid: true };
    data.limit_flags = 2;
    data.limit_warn_flags = 2;
    expect(jointPanelGroups(data, null)[0]!.rows[1]).toMatchObject({
      fraction: null,
      limitState: "unlimited",
      unit: "rad",
    });
  });

  it("retains prismatic units and treats absent or degenerate metadata bounds as unknown", () => {
    const data = frame();
    data.quality[17] = { origin: "measured", valid: true };
    data.joints[17] = 0.025;
    expect(jointPanelGroups(data, null)[2]!.rows[7]).toMatchObject({
      unit: "m",
      fraction: 0.5,
      valueText: "0.025",
    });
    const meta = metadata();
    meta.joints[17].lower = 1;
    meta.joints[17].upper = 1;
    expect(jointPanelGroups(data, meta)[2]!.rows[7]).toMatchObject({
      fraction: null,
      limitState: "unknown",
    });
    meta.joints[17].lower = null;
    expect(jointPanelGroups(data, meta)[2]!.rows[7]).toMatchObject({
      fraction: null,
      limitState: "unknown",
    });
  });
});

describe("quality provenance", () => {
  it.each([
    [{ origin: "measured", valid: true }, ["实测"]],
    [{ origin: "commanded", valid: true }, ["指令"]],
    [{ origin: "derived", valid: true, processing: ["derived"] }, ["推算"]],
    [
      { origin: "measured", valid: true, processing: ["interpolated"] },
      ["实测", "插值"],
    ],
    [
      { origin: "commanded", valid: true, processing: ["forward_filled"] },
      ["指令", "前填"],
    ],
    [
      { origin: "missing", valid: false, processing: ["defaulted"] },
      ["缺失", "默认"],
    ],
    [{ origin: "measured", valid: false }, ["实测", "无效"]],
  ] as const)(
    "retains the origin and processing history for %j",
    (input, labels) => {
      expect(
        qualityPresentation({
          ...input,
          processing: "processing" in input ? [...input.processing] : [],
        }).labels,
      ).toEqual(labels);
    },
  );

  it("keeps combined processing and derivation provenance without duplicating origin", () => {
    expect(
      qualityPresentation({
        origin: "derived",
        valid: true,
        processing: [
          "derived",
          "interpolated",
          "forward_filled",
          "unit_converted",
        ],
      }).labels,
    ).toEqual(["推算", "插值", "前填", "换算"]);
  });
});
