import type { FrameSnapshot, VideoInfo } from '../domain/types';
export type MediaState = 'waiting' | 'ready';

export interface DecodedFrame {
  readonly sessionId: string;
  readonly captureId: number;
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly snapshot?: FrameSnapshot;
  readonly markerPixels?: ReadonlyArray<readonly [number, number]>;
  close(): void;
}
export interface VideoSource {
  readonly capabilities: {
    kind: "mock" | "whep" | "unavailable";
    identity: "capture32_crc32";
    controllable: boolean;
  };
  connect(
    sid: string,
    onFrame: (frame: DecodedFrame) => void,
    onStatus?: (message: string, state?: MediaState) => void,
    video?: VideoInfo,
  ): void;
  disconnect(): void;
}
