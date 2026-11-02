import { expect, it, vi } from 'vitest';
import { DecoderPipeline, type DecodedPair } from '../../src/media/decoder';
import { accessUnit, catalog, pixels, UUID } from './realFixtures';

function setup() {
  const decoders: Array<{ callbacks: VideoDecoderInit; chunks: EncodedVideoChunk[]; decoder: VideoDecoder }> = [];
  const pairs: DecodedPair[] = []; const errors: string[] = []; let now = 0;
  const pipeline = new DecoderPipeline({ sessionId: catalog().session_id, uuid: UUID, now: () => now,
    onPair: pair => pairs.push(pair), onError: error => errors.push(error),
    createChunk: init => init as unknown as EncodedVideoChunk,
    readPixels: frame => pixels((frame as unknown as { pixelId: number }).pixelId),
    createDecoder(callbacks) {
      const chunks: EncodedVideoChunk[] = [];
      const decoder = { state: 'configured', decodeQueueSize: 0, configure: vi.fn(),
        decode: (chunk: EncodedVideoChunk) => chunks.push(chunk), close: vi.fn() } as unknown as VideoDecoder;
      decoders.push({ callbacks, chunks, decoder }); return decoder;
    },
  });
  function emit(which = decoders.length - 1, id = catalog().snapshots[0].capture_id) {
    const current = decoders[which]; const chunk = current.chunks.shift()!;
    const frame = { timestamp: chunk.timestamp, displayWidth: 1280, displayHeight: 720, pixelId: id, close: vi.fn() };
    current.callbacks.output(frame as unknown as VideoFrame); return frame;
  }
  return { pipeline, decoders, pairs, errors, emit, time: (value: number) => { now = value; } };
}
it('joins decoder output to its own access unit and actual pixels', () => {
  const run = setup(); run.pipeline.push(accessUnit());
  const wrong = run.emit(0, 999); expect(wrong.close).toHaveBeenCalledOnce(); expect(run.pairs).toHaveLength(0);
  run.pipeline.push(accessUnit()); const good = run.emit();
  expect(run.pairs[0].snapshot.capture_id).toBe(good.pixelId);
  expect(run.pairs[0].markerPixels).toEqual(catalog().marker_pixels);
  expect(good.close).not.toHaveBeenCalled();
  run.pipeline.release(run.pairs[0].id); good.close(); run.pipeline.close();
});
it('resets a broken reference chain and rejects late callbacks until a new IDR', () => {
  const run = setup(); run.pipeline.push(accessUnit());
  run.pipeline.push(accessUnit(catalog(), { uuid: '0'.repeat(32) }));
  expect(run.decoders[0].decoder.close).toHaveBeenCalledOnce();
  expect(run.emit(0).close).toHaveBeenCalledOnce();
  run.pipeline.push(accessUnit(catalog(), { key: false })); expect(run.decoders).toHaveLength(1);
  run.pipeline.push(accessUnit()); run.emit(); expect(run.pairs).toHaveLength(1);
  run.pipeline.close();
});
it('bounds outstanding main-thread frames and resumes only after explicit release', () => {
  const run = setup();
  for (let i = 0; i < 4; i++) { run.pipeline.push(accessUnit()); run.emit(); }
  run.pipeline.push(accessUnit()); expect(run.emit().close).toHaveBeenCalledOnce();
  expect(run.pairs).toHaveLength(4); expect(run.pipeline.diagnostics().inFlight).toBe(4);
  run.pipeline.release(run.pairs[0].id);
  run.pipeline.push(accessUnit()); run.emit(); expect(run.pairs).toHaveLength(5);
  run.pipeline.close();
});
it('drops expired outputs, excessive decoder queue and callbacks after close', () => {
  const run = setup(); run.pipeline.push(accessUnit()); run.time(2001);
  expect(run.emit().close).toHaveBeenCalledOnce(); expect(run.pairs).toHaveLength(0);
  Object.defineProperty(run.decoders[0].decoder, 'decodeQueueSize', { value: 4 });
  run.pipeline.push(accessUnit(catalog(), { key: false }));
  expect(run.decoders[0].decoder.close).toHaveBeenCalledOnce();
  run.pipeline.push(accessUnit()); run.pipeline.close(); expect(run.emit().close).toHaveBeenCalledOnce();
  run.pipeline.push(accessUnit()); expect(run.decoders).toHaveLength(2);
});
it('caps undecoded associations when a decoder stops producing outputs', () => {
  const run = setup();
  for (let i = 0; i < 30; i++) run.pipeline.push(accessUnit());
  expect(run.pipeline.diagnostics().pending).toBeLessThanOrEqual(8);
  expect(run.decoders.length).toBeGreaterThan(1);
  run.pipeline.close();
});
