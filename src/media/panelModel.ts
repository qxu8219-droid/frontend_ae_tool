import type {
  ChannelQuality,
  FrameSnapshot,
  JointMetadata,
} from "../domain/types";
import canonicalMetadata from "../api/fixtures/joint-metadata.json";

export const JOINT_GROUPS = Object.freeze([
  { id: "base", label: "底盘", start: 0, count: 6, color: "#45d8e8" },
  { id: "torso", label: "躯干", start: 6, count: 4, color: "#90b9f0" },
  { id: "left", label: "左臂 / 夹爪", start: 10, count: 9, color: "#b5a3ee" },
  { id: "right", label: "右臂 / 夹爪", start: 19, count: 9, color: "#e4b98b" },
] as const);

export interface QualityPresentation {
  available: boolean;
  origin: ChannelQuality["origin"];
  labels: string[];
  text: string;
}

export type LimitState =
  "unavailable" | "unlimited" | "unknown" | "normal" | "warning" | "exceeded";

export interface JointPanelRow {
  index: number;
  name: string;
  unit: "rad" | "m";
  valueText: string;
  available: boolean;
  lower: number | null;
  upper: number | null;
  fraction: number | null;
  limitState: LimitState;
  quality: QualityPresentation;
}

export interface JointPanelGroup {
  id: string;
  label: string;
  start: number;
  count: number;
  color: string;
  collapsed: boolean;
  rows: JointPanelRow[];
}

/** Keep origin and transformations separate so inferred or filled values never resemble measurements. */
export function qualityPresentation(
  quality: ChannelQuality,
): QualityPresentation {
  const origins = {
    measured: "实测",
    commanded: "指令",
    derived: "推算",
    missing: "缺失",
  };
  const transforms = {
    original: "",
    unit_converted: "换算",
    interpolated: "插值",
    forward_filled: "前填",
    defaulted: "默认",
    derived: "推算",
  };
  const labels = [origins[quality.origin]];
  for (const processing of quality.processing ?? []) {
    const name = transforms[processing];
    if (name && !labels.includes(name)) labels.push(name);
  }
  if (!quality.valid && quality.origin !== "missing") labels.push("无效");
  return {
    available: quality.valid && quality.origin !== "missing",
    origin: quality.origin,
    labels,
    text: labels.join("·"),
  };
}

/** The capture flags are authoritative; progress is bounded visually but values are never clamped. */
export function jointPanelGroups(
  snapshot: FrameSnapshot,
  metadata: JointMetadata | null,
  collapsed: readonly string[] = [],
): JointPanelGroup[] {
  return JOINT_GROUPS.map((group) => ({
    ...group,
    collapsed: collapsed.includes(group.id),
    rows: Array.from({ length: group.count }, (_, offset) => {
      const index = group.start + offset;
      const descriptor = (metadata?.joints[index] ??
        canonicalMetadata.joints[index])!;
      const value = snapshot.joints[index]!;
      const quality = qualityPresentation(snapshot.quality[index]!);
      const available = quality.available && Number.isFinite(value);
      const { lower, upper } = descriptor;
      const finiteRange =
        typeof lower === "number" &&
        typeof upper === "number" &&
        Number.isFinite(lower) &&
        Number.isFinite(upper) &&
        upper > lower;
      const fraction =
        available && descriptor.type !== "continuous" && finiteRange
          ? Math.max(0, Math.min(1, (value - lower) / (upper - lower)))
          : null;
      const limitState: LimitState = !available
        ? "unavailable"
        : descriptor.type === "continuous"
          ? "unlimited"
          : !finiteRange
            ? "unknown"
            : (snapshot.limit_flags & (1 << index)) !== 0
              ? "exceeded"
              : (snapshot.limit_warn_flags & (1 << index)) !== 0
                ? "warning"
                : "normal";
      return {
        index,
        name: descriptor.name,
        unit: descriptor.unit as "rad" | "m",
        available,
        valueText: !available
          ? "—"
          : Math.abs(value) >= 10000
            ? value.toExponential(1)
            : value.toFixed(3),
        lower,
        upper,
        fraction,
        limitState,
        quality,
      };
    }),
  }));
}
