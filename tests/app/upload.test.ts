import { describe, expect, it } from "vitest";
import { parseUploadOptions, validateUploadFile } from "../../src/app/upload";

describe("upload configuration validation", () => {
  it("omits blank options so that the server chooses its default mapping", () => {
    expect(parseUploadOptions("  ", "  \n ")).toEqual({
      ok: true,
      options: {},
    });
  });

  it("passes a finite nested mapping and a trimmed parser identifier", () => {
    expect(
      parseUploadOptions(
        " csv_v1 ",
        '{"scale":0.5,"fields":["q",null,true],"nested":{"zero":0}}',
      ),
    ).toEqual({
      ok: true,
      options: {
        parser: "csv_v1",
        mapping_config: {
          scale: 0.5,
          fields: ["q", null, true],
          nested: { zero: 0 },
        },
      },
    });
  });

  it.each(["null", "[]", '"q"', "42", "true", '{"broken":}'])(
    "rejects a non-object or malformed mapping: %s",
    (mapping) => {
      expect(parseUploadOptions("", mapping).ok).toBe(false);
    },
  );

  it("rejects overflow numbers even though JSON.parse accepts them", () => {
    expect(parseUploadOptions("", '{"nested":[{"gain":1e400}]}').ok).toBe(
      false,
    );
  });

  it("rejects oversized source text rather than silently dropping mapping content", () => {
    expect(
      parseUploadOptions("", '{"field":"' + "q".repeat(65536) + '"}').ok,
    ).toBe(false);
  });

  it.each(["csv parser", "../parser", "p".repeat(129)])(
    "rejects unsupported parser identifiers: %s",
    (parser) => {
      expect(parseUploadOptions(parser, "{}").ok).toBe(false);
    },
  );
});

describe("file size validation", () => {
  it("accepts the exact advertised byte limit", () => {
    expect(validateUploadFile({ size: 1048576 }, 1048576)).toBeNull();
  });

  it("rejects the next byte before upload begins", () => {
    expect(validateUploadFile({ size: 1048577 }, 1048576)).toBeTypeOf("string");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects empty or invalid file sizes: %s",
    (size) => {
      expect(validateUploadFile({ size }, 1048576)).toBeTypeOf("string");
    },
  );
});

it('recognizes portable B041 bundles while keeping backend parser selection automatic', async () => {
  const { isB041Upload } = await import('../../src/app/upload');
  expect(isB041Upload('episode.B041')).toBe(true);
  expect(isB041Upload('episode.b041.json')).toBe(false);
  expect(parseUploadOptions('', '')).toEqual({ ok: true, options: {} });
  expect(validateUploadFile({ size: 16 }, 1024)).toBeNull();
});
