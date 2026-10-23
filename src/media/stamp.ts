export const SOURCE_WIDTH = 640,
  SOURCE_HEIGHT = 360;
export const MARKER_PIXELS: ReadonlyArray<readonly [number, number]> =
  Array.from(
    { length: 64 },
    (_, i) => [16 + (i % 32) * 19, 12 + Math.floor(i / 32) * 13] as const,
  );
export function crc32Id(id: number) {
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff)
    throw new Error("Capture ID must be a positive uint32");
  let crc = 0xffffffff;
  for (const shift of [24, 16, 8, 0]) {
    crc ^= (id >>> shift) & 255;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function stampBits(id: number) {
  const crc = crc32Id(id);
  return Array.from(
    { length: 64 },
    (_, bit) => ((bit < 32 ? id : crc) >>> (bit % 32)) & 1,
  );
}
export function decodeStamp(samples: ReadonlyArray<ArrayLike<number>>) {
  if (samples.length !== 64) throw new Error("Expected 64 marker pixels");
  let id = 0,
    crc = 0;
  samples.forEach((sample, bit) => {
    if (
      !Number.isFinite(sample[0]) ||
      !Number.isFinite(sample[1]) ||
      Math.abs(sample[1] - sample[0]) < 30
    )
      throw new Error("Unreadable frame stamp");
    if (sample[1] > sample[0]) {
      if (bit < 32) id = (id | (1 << bit)) >>> 0;
      else crc = (crc | (1 << (bit - 32))) >>> 0;
    }
  });
  if (crc32Id(id) !== crc) throw new Error("Frame stamp CRC mismatch");
  return id;
}
