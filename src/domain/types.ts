// App aliases refer to generated contracts; no separate hand-written wire types.
import type { components } from "../api/types.gen";
export type {
  FrameSnapshot,
  ChannelQuality,
  ChassisPose,
} from "../api/generated/frame-catalog.gen";
export type { PresentedFrame } from "../api/generated/presented-frame.gen";
export type { WsServerMessage, WsClientMessage } from "../api/messages.gen";
export type Schema = components["schemas"];
export type SceneList = Schema["SceneList"];
export type RobotList = Schema["RobotList"];
export type JointMetadata = Schema["JointMetadata"];
export type PlaybackSnapshot = Schema["PlaybackSnapshot"];
export type ControlAck = Schema["RESTPlaybackResponse"];
export type SessionStatus = Schema["SessionStatus"];
export type SessionCreated = Schema["SessionCreated"];
export type UploadResult = Schema["UploadResult"];
export type CurveResponse = Schema["CurveResponse"];
export type VideoInfo = Schema["VideoInfo"];
export type ScenarioId =
  | "normal"
  | "no-log"
  | "parse-error"
  | "missing-channels"
  | "worker-error"
  | "video-delay"
  | "data-delay"
  | "ws-reconnect";
export const SCENARIOS: ReadonlyArray<{ id: ScenarioId; label: string }> = [
  { id: "normal", label: "正常回放" },
  { id: "no-log", label: "无日志" },
  { id: "parse-error", label: "解析失败" },
  { id: "missing-channels", label: "缺失通道" },
  { id: "worker-error", label: "Worker 故障" },
  { id: "video-delay", label: "画面迟到" },
  { id: "data-delay", label: "数据迟到" },
  { id: "ws-reconnect", label: "连接重建" },
];
