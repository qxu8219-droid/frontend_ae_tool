import { example } from '../api/fixtures';
import type { FrameCatalog } from '../../src/api/generated/frame-catalog.gen';

export const UUID = '83249d41b6545e6e8d7779430f88bb0d';
export function catalog(): FrameCatalog {
  return example('protocol/SnapshotCatalog');
}
export function accessUnit(value: unknown = catalog(), options: { uuid?: string; key?: boolean; avcc?: boolean } = {}) {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const uuid = Uint8Array.from((options.uuid ?? UUID).match(/../g)!, hex => parseInt(hex, 16));
  const size = json.length + 16;
  const rbsp = [5, ...Array(Math.floor(size / 255)).fill(255), size % 255, ...uuid, ...json, 128];
  const escaped: number[] = []; let zeros = 0;
  for (const value of rbsp) {
    if (zeros >= 2 && value <= 3) { escaped.push(3); zeros = 0; }
    escaped.push(value); zeros = value === 0 ? zeros + 1 : 0;
  }
  const nals = [new Uint8Array([6, ...escaped]), new Uint8Array([options.key === false ? 0x41 : 0x65, 1])];
  if (options.key !== false) nals.unshift(new Uint8Array([0x67, 0x42, 0xe0, 0x1f]));
  return new Uint8Array(nals.flatMap(nal => {
    const prefix = new Uint8Array(4);
    if (options.avcc) new DataView(prefix.buffer).setUint32(0, nal.length);
    else prefix[3] = 1;
    return [...prefix, ...nal];
  }));
}
export function pixels(id: number) {
  let crc = 0xffffffff;
  for (const shift of [24, 16, 8, 0]) {
    crc ^= (id >>> shift) & 255;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const checksum = (crc ^ 0xffffffff) >>> 0;
  return Array.from({ length: 64 }, (_, bit) => ((bit < 32 ? id : checksum) >>> (bit % 32)) & 1 ? [0, 220, 0] : [220, 0, 0]);
}
