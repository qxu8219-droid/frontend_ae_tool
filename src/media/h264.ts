import type { FrameCatalog } from '../api/generated/frame-catalog.gen';
import { validateCatalog } from './catalog';

function split(bytes: Uint8Array): Uint8Array[] {
  const starts: Array<[number, number]> = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] || bytes[i + 1]) continue;
    const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
    if (length) { starts.push([i, i + length]); i += length - 1; }
  }
  if (starts.length && starts[0][0] === 0) {
    const nals = starts.map((start, index) => bytes.subarray(start[1], starts[index + 1]?.[0] ?? bytes.length));
    if (nals.some(nal => !nal.length)) throw new Error('Empty NAL');
    return nals;
  }
  const nals: Uint8Array[] = []; let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    if (!length || offset + 4 + length > bytes.length) break;
    nals.push(bytes.subarray(offset + 4, offset + 4 + length)); offset += length + 4;
  }
  if (nals.length && offset === bytes.length) return nals;
  if (bytes.length && (bytes[0] & 31) > 0 && (bytes[0] & 31) < 24) return [bytes];
  throw new Error('Invalid H264 NAL framing');
}

function unescape(nal: Uint8Array) {
  const out: number[] = []; let zeros = 0;
  for (const [index, byte] of nal.entries()) {
    if (index === 0) continue;
    if (zeros >= 2 && byte === 3) {
      if (index + 1 >= nal.length || nal[index + 1] > 3) throw new Error('Invalid emulation prevention');
      zeros = 0; continue;
    }
    out.push(byte); zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

export function extractAccessUnit(bytes: Uint8Array, uuidHex: string) {
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Access unit size exceeds bounds');
  if (!/^[0-9a-f]{32}$/.test(uuidHex)) throw new Error('Invalid SEI UUID');
  const uuid = Uint8Array.from(uuidHex.match(/../g)!, hex => parseInt(hex, 16));
  const nals = split(bytes);
  let catalog: FrameCatalog | null = null;
  for (const nal of nals) {
    if ((nal[0] & 31) !== 6) continue;
    const data = unescape(nal); let offset = 0;
    while (offset < data.length) {
      if (data[offset] === 128 && data.subarray(offset + 1).every(byte => byte === 0)) break;
      const number = () => {
        let result = 0;
        while (offset < data.length && data[offset] === 255) { result += 255; offset++; }
        if (offset >= data.length) throw new Error('Truncated SEI header');
        return result + data[offset++];
      };
      const type = number(), size = number();
      if (offset + size > data.length) throw new Error('Truncated SEI payload');
      const payload = data.subarray(offset, offset + size); offset += size;
      if (type !== 5 || size < 16 || !uuid.every((byte, index) => payload[index] === byte)) continue;
      if (catalog) throw new Error('Multiple matching SEI catalogs');
      if (size - 16 > 256 * 1024) throw new Error('SEI catalog exceeds bounds');
      catalog = validateCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(16)).replace(/\0$/, '')));
    }
  }
  const sps = nals.find(nal => (nal[0] & 31) === 7);
  const codec = sps && sps.length >= 4 ? 'avc1.' + [...sps.subarray(1, 4)].map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
  const annexB = new Uint8Array(nals.reduce((length, nal) => length + nal.length + 4, 0));
  let offset = 0;
  for (const nal of nals) { annexB.set([0, 0, 0, 1], offset); annexB.set(nal, offset + 4); offset += nal.length + 4; }
  return { catalog, codec, keyframe: nals.some(nal => (nal[0] & 31) === 5), annexB };
}
