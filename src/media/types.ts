export interface DecodedFrame {
  readonly sessionId: string;
  readonly captureId: number;
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}
export interface VideoSource {
  readonly capabilities: {
    kind: "mock" | "unavailable";
    identity: "capture32_crc32";
    controllable: boolean;
  };
  connect(
    sid: string,
    onFrame: (frame: DecodedFrame) => void,
    onStatus?: (message: string) => void,
  ): void;
  disconnect(): void;
}
