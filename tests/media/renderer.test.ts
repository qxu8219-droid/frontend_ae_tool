import { expect, it } from 'vitest';
import { example } from '../api/fixtures';
import type { FrameSnapshot } from '../../src/domain/types';
import { drawPresentation } from '../../src/media/renderer';

it('renders each canonical group in its own card and excludes history from another log', () => {
  const snapshot = example<FrameSnapshot>('protocol/FrameSnapshot');
  snapshot.quality[17] = { origin: 'derived', valid: true, method: 'estimate.v1' };
  snapshot.quality[19] = { origin: 'missing', valid: false };
  const text: Array<[string, number, number]> = [];
  const images: unknown[] = [];
  const ctx = new Proxy({}, { get(target, key) {
    if (key === 'fillText') return (value: string, x: number, y: number) => text.push([value, x, y]);
    if (key === 'drawImage') return (image: unknown) => images.push(image);
    return (target as Record<PropertyKey, unknown>)[key] ?? (() => {});
  }, set(target, key, value) { (target as Record<PropertyKey, unknown>)[key] = value; return true; } });
  const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
  const image = {} as ImageBitmap;
  const history = {} as HTMLCanvasElement;
  drawPresentation(canvas, { image, sessionId: snapshot.session_id, captureId: snapshot.capture_id, width: 640, height: 360, close() {} }, snapshot, null, { historyCanvas: history, historyLogId: 'another-log', historyRange: { from: 0, to: 10 } });
  const at = (value: string, xmin: number, xmax: number, ymin: number, ymax: number) => text.some(([t,x,y]) => t === value && x >= xmin && x < xmax && y >= ymin && y < ymax);
  expect(at('L arm 1', 800, 1192, 48, 312)).toBe(true);
  expect(at('R arm 1', 1192, 1600, 48, 312)).toBe(true);
  expect(at('torso 1', 800, 1192, 320, 552)).toBe(true);
  expect(at('steer 1', 1192, 1600, 320, 552)).toBe(true);
  expect(at('未评估', 800, 1192, 48, 312)).toBe(true);
  expect(at('—', 1192, 1600, 48, 312)).toBe(true);
  expect(images).toEqual([image]);
  expect(text.some(([t]) => t.includes('等待当前日志数据'))).toBe(true);
});
