import type { Schema } from "../domain/types";

export type UploadFormOptions = {
  parser?: string;
  mapping_config?: Record<string, Schema["JsonValue"]>;
};
export type UploadOptionsResult =
  { ok: true; options: UploadFormOptions } | { ok: false; error: string };

export function parseUploadOptions(
  parser: string,
  mappingText: string,
): UploadOptionsResult {
  const options: UploadFormOptions = {};
  const parserId = parser.trim();
  if (parserId) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(parserId)) {
      return {
        ok: false,
        error:
          "解析器标识仅支持字母、数字、下划线、点和短横线，最多 128 字符。",
      };
    }
    options.parser = parserId;
  }
  if (mappingText.length > 65536) {
    return { ok: false, error: "映射配置不能超过 65,536 字符。" };
  }
  if (mappingText.trim()) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(mappingText);
    } catch {
      return {
        ok: false,
        error: "映射配置不是有效的 JSON，请检查引号和逗号。",
      };
    }
    if (
      mapping === null ||
      typeof mapping !== "object" ||
      Array.isArray(mapping)
    ) {
      return { ok: false, error: "映射配置必须是 JSON 对象，例如 {}。" };
    }
    // Iterative traversal also handles deeply nested input without a call-stack overflow.
    const pending: unknown[] = [mapping];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "number" && !Number.isFinite(value)) {
        return { ok: false, error: "映射配置中的数字必须是有限值。" };
      }
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) pending.push(child);
      }
    }
    options.mapping_config = mapping as Record<string, Schema["JsonValue"]>;
  }
  return { ok: true, options };
}

export function validateUploadFile(
  file: Pick<File, "size">,
  maxBytes: number,
): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    return "请选择非空的日志文件。";
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    return "上传大小限制尚未就绪。";
  if (file.size > maxBytes)
    return `文件超过 ${formatUploadSize(maxBytes)} 大小限制。`;
  return null;
}

export function formatUploadSize(bytes: number): string {
  if (bytes >= 1048576) return `${Number((bytes / 1048576).toFixed(2))} MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(2))} KiB`;
  return `${bytes} B`;
}

/** The extension selects the server's portable-bundle adapter when parser is omitted. */
export function isB041Upload(name: string): boolean {
  return name.toLowerCase().endsWith(".b041");
}
