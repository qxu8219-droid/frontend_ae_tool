import type { FrameCatalog, FrameSnapshot, MarkerPixels } from '../api/generated/frame-catalog.gen';
import { extractAccessUnit } from './h264';
import { selectSnapshot } from './catalog';

export interface DecodedPair {
  id: number;
  frame: VideoFrame;
  snapshot: FrameSnapshot;
  markerPixels: MarkerPixels;
}
interface Pending { catalog: FrameCatalog; at: number }

/** Decoder timestamps identify access units, never source captures. Pixels choose captures. */
export class DecoderPipeline {
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private pending = new Map<number, Pending>();
  private transferred = new Set<number>();
  private nextId = 0;
  private closed = false;
  private packets = 0;
  private dropped = 0;
  private mismatches = 0;
  private scratch: OffscreenCanvas | null = null;
  private now: () => number;
  constructor(private options: {
    sessionId: string; uuid: string; onPair(pair: DecodedPair): void; onError?(message: string): void;
    now?: () => number; createDecoder?: (callbacks: VideoDecoderInit) => VideoDecoder;
    createChunk?: (init: EncodedVideoChunkInit) => EncodedVideoChunk;
    readPixels?: (frame: VideoFrame, coordinates: MarkerPixels) => ReadonlyArray<ArrayLike<number>>;
  }) { this.now = options.now ?? (() => performance.now()); }

  private reset() {
    const decoder = this.decoder; this.decoder = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
    this.pending.clear();
  }
  private pixels(frame: VideoFrame, coordinates: MarkerPixels) {
    if (this.options.readPixels) return this.options.readPixels(frame, coordinates);
    const width = frame.displayWidth, height = frame.displayHeight;
    if (!width || !height || width * height > 4096 * 2160) throw new Error('Decoded image size exceeds bounds');
    this.scratch ??= new OffscreenCanvas(width, height);
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height !== height) this.scratch.height = height;
    const context = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Offscreen 2D canvas unavailable');
    context.drawImage(frame, 0, 0);
    return coordinates.map(([x, y]) => {
      if (x >= width || y >= height) throw new Error('Image marker outside decoded frame');
      return context.getImageData(x, y, 1, 1).data;
    });
  }
  private create(codec: string) {
    const create = this.options.createDecoder ?? (callbacks => new VideoDecoder(callbacks));
    const decoder = create({
      output: frame => {
        if (this.closed || this.decoder !== decoder) { frame.close(); return; }
        const id = frame.timestamp, item = this.pending.get(id); this.pending.delete(id);
        if (!item || this.now() - item.at >= 2000 || this.transferred.size >= 4) {
          frame.close(); this.dropped++; return;
        }
        try {
          const snapshot = selectSnapshot(item.catalog, this.pixels(frame, item.catalog.marker_pixels), this.options.sessionId);
          this.transferred.add(id);
          this.options.onPair({ id, frame, snapshot, markerPixels: item.catalog.marker_pixels });
        } catch (error) {
          this.transferred.delete(id); frame.close(); this.mismatches++;
          this.options.onError?.(error instanceof Error ? error.message : String(error));
        }
      },
      error: error => {
        if (this.decoder !== decoder || this.closed) return;
        this.reset(); this.options.onError?.(error.message);
      },
    });
    this.decoder = decoder;
    decoder.configure({ codec, hardwareAcceleration: 'prefer-software', optimizeForLatency: true });
  }
  push(bytes: Uint8Array) {
    if (this.closed) return;
    this.packets++;
    try {
      const unit = extractAccessUnit(bytes, this.options.uuid);
      if (!unit.catalog || unit.catalog.session_id !== this.options.sessionId) {
        this.dropped++; this.reset(); return;
      }
      const codec = unit.codec ?? this.codec;
      if (this.decoder?.state === 'closed' || this.codec !== codec ||
          this.pending.size >= 8 || [...this.pending.values()].some(item => this.now() - item.at >= 2000)) this.reset();
      this.codec = codec;
      if ((this.decoder?.decodeQueueSize ?? 0) >= 4) { this.reset(); this.dropped++; return; }
      if (!this.decoder) {
        if (!unit.keyframe || !codec) { this.dropped++; return; }
        this.create(codec);
      }
      if (this.nextId === Number.MAX_SAFE_INTEGER) throw new Error('Media packet sequence exhausted');
      const id = ++this.nextId;
      this.pending.set(id, { catalog: unit.catalog, at: this.now() });
      const init: EncodedVideoChunkInit = { type: unit.keyframe ? 'key' : 'delta', timestamp: id, data: unit.annexB };
      this.decoder!.decode(this.options.createChunk?.(init) ?? new EncodedVideoChunk(init));
    } catch (error) {
      this.dropped++; this.reset();
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    }
  }
  release(id: number) { this.transferred.delete(id); }
  diagnostics() {
    return { packets: this.packets, dropped: this.dropped, mismatches: this.mismatches,
      pending: this.pending.size, inFlight: this.transferred.size, codec: this.codec };
  }
  close() { this.closed = true; this.reset(); this.transferred.clear(); this.scratch = null; }
}
