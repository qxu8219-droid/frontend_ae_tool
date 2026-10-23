import { expect, it } from "vitest";
import { crc32Id, decodeStamp, stampBits } from "../../src/media/stamp";
it("decodes the complete uint32 ID and validates its big-endian CRC", () => {
  for (const [id, crc] of [
    [1, 0x5643ef8a],
    [0x12345678, 0x4a090e98],
    [0x80000000, 0xcc1d6927],
    [0xffffffff, 0xffffffff],
  ]) {
    expect(crc32Id(id)).toBe(crc);
    const samples = stampBits(id).map((bit) =>
      bit ? [0, 220, 0] : [220, 0, 0],
    );
    expect(decodeStamp(samples)).toBe(id);
    samples[40] = samples[40][0] ? [0, 220, 0] : [220, 0, 0];
    expect(() => decodeStamp(samples)).toThrow();
  }
  expect(() => stampBits(0)).toThrow();
  expect(() => stampBits(2 ** 32)).toThrow();
  expect(() => decodeStamp(Array(64).fill([100, 100, 100]))).toThrow();
});
