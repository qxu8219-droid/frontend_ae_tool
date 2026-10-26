import { expect, it } from 'vitest';
import { extractAccessUnit } from '../../src/media/h264';
import { selectSnapshot, validateCatalog } from '../../src/media/catalog';
import { accessUnit, catalog, pixels, UUID } from './realFixtures';

it('reads formal SEI in AnnexB and AVCC, normalizing WebCodecs input to AnnexB', () => {
  for (const avcc of [false, true]) {
    const result = extractAccessUnit(accessUnit(catalog(), { avcc }), UUID);
    expect(result.catalog).toEqual(catalog());
    expect(result.codec).toBe('avc1.42e01f');
    expect(result.keyframe).toBe(true);
    expect([...result.annexB.subarray(0, 4)]).toEqual([0, 0, 0, 1]);
  }
});
it('selects the unique same-session image identity, never the diagnostic encoder poll ID', () => {
  const value = catalog(); value.encoder_poll_capture_id = 999;
  const id = value.snapshots[0].capture_id;
  expect(selectSnapshot(validateCatalog(value), pixels(id), value.session_id).capture_id).toBe(id);
  expect(() => selectSnapshot(value, pixels(999), value.session_id)).toThrow();
  expect(() => selectSnapshot(value, pixels(id), 'retired')).toThrow();
  const corrupt = pixels(id); corrupt[40] = [120, 120, 0];
  expect(() => selectSnapshot(value, corrupt, value.session_id)).toThrow();
});
it('rejects semantic catalog corruption and finite/quality/geometry violations', () => {
  for (const change of [
    (c: ReturnType<typeof catalog>) => c.snapshots.push(c.snapshots[0]),
    (c: ReturnType<typeof catalog>) => { c.snapshots[0].session_id = 'other'; },
    (c: ReturnType<typeof catalog>) => { c.marker_pixels[1] = c.marker_pixels[0]; },
    (c: ReturnType<typeof catalog>) => { c.snapshots[0].joints[0] = NaN; },
    (c: ReturnType<typeof catalog>) => { c.snapshots[0].quality[0].origin = 'missing'; c.snapshots[0].quality[0].valid = true; },
  ]) { const value = catalog(); change(value); expect(() => validateCatalog(value)).toThrow(); }
});
it('does not accept the legacy UUID or truncated, ambiguous or oversized metadata', () => {
  expect(extractAccessUnit(accessUnit(catalog(), { uuid: '3654537366c659f396416e41d4c037f5' }), UUID).catalog).toBeNull();
  const valid = accessUnit();
  expect(() => extractAccessUnit(new Uint8Array([...valid, ...valid]), UUID)).toThrow();
  expect(() => extractAccessUnit(valid.subarray(0, valid.length - 10), UUID)).toThrow();
  expect(() => extractAccessUnit(new Uint8Array(4 * 1024 * 1024 + 1), UUID)).toThrow();
  expect(() => extractAccessUnit(accessUnit({ padding: 'x'.repeat(256 * 1024) }), UUID)).toThrow();
});
