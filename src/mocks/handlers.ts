import { http, HttpResponse, ws } from "msw";
import type { HttpResponseResolver } from "msw";
import { MockError, mockRuntime } from "./runtime";
import type { MockRuntime } from "./runtime";

const JSON_BODY_LIMIT = 64 * 1024;
const FILE_SIZE_LIMIT = 1024 * 1024;
// Includes a 64 KiB mapping plus multipart headers, filename, and parser metadata.
const MULTIPART_BODY_LIMIT = FILE_SIZE_LIMIT + 128 * 1024;
const curveKeys = ["channels", "from_s", "to_s", "max_points"];
// A shared link avoids accumulating MSW BroadcastChannel managers when callers
// create isolated handler sets. Each returned connection handler owns its runtime.
const connections = ws.link("*/ws/sessions/:sid");
type RequestContext = Parameters<HttpResponseResolver>[0];

function invalid(message: string): never {
  throw new MockError(400, "INVALID_REQUEST", message);
}

function parseJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value))
      invalid("JSON numbers must be finite.");
    return value;
  });
}

function query(request: Request, allowed: readonly string[] = []) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (!allowed.includes(key)) invalid("Unexpected query parameter.");
    if (Object.hasOwn(result, key))
      invalid("Query parameters must not be repeated.");
    result[key] = value;
  }
  return result;
}

function guarded(
  resolve: (context: RequestContext) => Response | Promise<Response>,
): HttpResponseResolver {
  return async (context) => {
    try {
      return await resolve(context);
    } catch (error) {
      if (error instanceof MockError)
        return HttpResponse.json(error.body, { status: error.status });
      throw error;
    }
  };
}

function path(context: RequestContext, name: string) {
  const value = context.params[name];
  if (typeof value !== "string" || !value) invalid("Invalid route parameter.");
  return value;
}

async function boundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get("content-length");
  const reader = request.body?.getReader();
  const cancel = () => {
    // MSW keeps a logging clone. Waiting for a tee branch to cancel can wait
    // forever for that unused clone, so cancellation must not block the response.
    void reader?.cancel().catch(() => undefined);
  };
  try {
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength)) invalid("Invalid Content-Length.");
      if (Number(declaredLength) > limit) {
        cancel();
        throw new MockError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body exceeds the mock size limit.",
        );
      }
    }
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        cancel();
        throw new MockError(
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body exceeds the mock size limit.",
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader?.releaseLock();
  }
}

async function jsonBody(request: Request, optional = false): Promise<unknown> {
  const bytes = await boundedBody(request, JSON_BODY_LIMIT);
  if (bytes.length === 0) {
    if (optional) return {};
    invalid("A JSON body is required.");
  }
  if (
    !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    invalid("Content-Type must be application/json.");
  }
  try {
    const value = parseJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return optional && value === null ? {} : value;
  } catch {
    invalid("Malformed JSON body.");
  }
}

async function multipartBody(request: Request) {
  const bytes = await boundedBody(request, MULTIPART_BODY_LIMIT);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType))
    invalid("Content-Type must be multipart/form-data.");
  let form: FormData;
  try {
    // Only parse after the bounded reader has finished; request.formData() would
    // read an arbitrarily large network body before checking the file size.
    form = await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    invalid("Malformed multipart body.");
  }
  const seen = new Set<string>();
  for (const [key] of form) {
    if (!["file", "parser", "mapping_config"].includes(key))
      invalid("Unexpected multipart field.");
    if (seen.has(key)) invalid("Multipart fields must not be repeated.");
    seen.add(key);
  }
  const file = form.get("file");
  if (file === null || typeof file === "string")
    invalid("A file upload is required.");
  if (file.size > FILE_SIZE_LIMIT)
    throw new MockError(
      413,
      "UPLOAD_TOO_LARGE",
      "Mock log files must not exceed 1 MiB.",
    );
  const options: { parser?: unknown; mapping_config?: unknown } = {};
  if (form.has("parser")) {
    const parser = form.get("parser");
    if (
      typeof parser !== "string" ||
      parser.length === 0 ||
      parser.length > 128
    )
      invalid("Invalid parser.");
    options.parser = parser;
  }
  if (form.has("mapping_config")) {
    const mapping = form.get("mapping_config");
    if (
      typeof mapping !== "string" ||
      mapping.length === 0 ||
      mapping.length > 65536
    )
      invalid("Invalid mapping_config.");
    try {
      options.mapping_config = parseJson(mapping);
    } catch {
      invalid("mapping_config must be valid JSON.");
    }
    if (
      !options.mapping_config ||
      typeof options.mapping_config !== "object" ||
      Array.isArray(options.mapping_config)
    ) {
      invalid("mapping_config must be an inline JSON object.");
    }
  }
  return { file, options };
}

export function createMockHandlers(runtime: MockRuntime) {
  const api = "*/api/v1";
  const get = (route: string, resolve: (context: RequestContext) => Response) =>
    http.get(
      `${api}${route}`,
      guarded((context) => {
        query(context.request);
        return resolve(context);
      }),
    );
  const controlHandlers = [
    "load",
    "play",
    "pause",
    "stop",
    "seek",
    "step",
    "speed",
  ].map((command) =>
    http.post(
      `${api}/sessions/:sid/playback/${command}`,
      guarded(async (context) => {
        query(context.request);
        const body = await jsonBody(
          context.request,
          ["play", "pause", "stop"].includes(command),
        );
        return HttpResponse.json(
          runtime.control(path(context, "sid"), command, body),
        );
      }),
    ),
  );
  const socketHandler = connections.addEventListener(
    "connection",
    ({ client, params }) => {
      if (typeof params.sid !== "string" || new URL(client.url).search) {
        client.close(1008, "INVALID_REQUEST");
        return;
      }
      let subscription:
        ReturnType<MockRuntime["subscribeConnection"]> | undefined;
      let closed = false;
      const dispose = () => {
        closed = true;
        subscription?.dispose();
      };
      client.addEventListener("close", dispose);
      try {
        subscription = runtime.subscribeConnection(params.sid, {
          message: (message) => {
            if (!closed) client.send(JSON.stringify(message));
          },
          close: (code, reason) => {
            dispose();
            client.close(code, reason);
          },
        });
        if (closed) subscription.dispose();
      } catch (error) {
        dispose();
        client.close(
          error instanceof MockError && error.status === 503 ? 1013 : 1008,
          error instanceof MockError
            ? error.body.error.code
            : "CONNECTION_FAILED",
        );
        return;
      }
      client.addEventListener("message", (event) => {
        if (closed) return;
        let value: unknown;
        if (
          typeof event.data === "string" &&
          new TextEncoder().encode(event.data).byteLength <= JSON_BODY_LIMIT
        ) {
          try {
            value = parseJson(event.data);
          } catch {
            /* Runtime rejects invalid envelopes. */
          }
        }
        subscription?.receive(value);
      });
    },
  );
  return [
    get("/scenes", () => HttpResponse.json(runtime.getScenes())),
    get("/robots", () => HttpResponse.json(runtime.getRobots())),
    get("/robots/:robot_id/joints", (context) =>
      HttpResponse.json(runtime.getJointMetadata(path(context, "robot_id"))),
    ),
    http.post(
      `${api}/sessions`,
      guarded(async (context) => {
        query(context.request);
        return HttpResponse.json(
          runtime.createSession(await jsonBody(context.request)),
          { status: 201 },
        );
      }),
    ),
    get("/sessions/:sid", (context) =>
      HttpResponse.json(runtime.getSession(path(context, "sid"))),
    ),
    http.delete(
      `${api}/sessions/:sid`,
      guarded((context) => {
        query(context.request);
        runtime.deleteSession(path(context, "sid"));
        return new HttpResponse(null, { status: 204 });
      }),
    ),
    http.post(
      `${api}/sessions/:sid/logs`,
      guarded(async (context) => {
        query(context.request);
        const { file, options } = await multipartBody(context.request);
        return HttpResponse.json(
          await runtime.uploadLog(path(context, "sid"), file, options),
          { status: 201 },
        );
      }),
    ),
    get("/sessions/:sid/logs/:lid/channels", (context) =>
      HttpResponse.json(
        runtime.getLogChannels(path(context, "sid"), path(context, "lid")),
      ),
    ),
    http.get(
      `${api}/sessions/:sid/logs/:lid/curve`,
      guarded((context) =>
        HttpResponse.json(
          runtime.getCurve(
            path(context, "sid"),
            path(context, "lid"),
            query(context.request, curveKeys),
          ),
        ),
      ),
    ),
    get("/sessions/:sid/playback", (context) =>
      HttpResponse.json(runtime.getPlayback(path(context, "sid"))),
    ),
    ...controlHandlers,
    http.post(
      `${api}/sessions/:sid/playback/:command`,
      guarded(() => invalid("Unknown playback command.")),
    ),
    get("/sessions/:sid/video", (context) =>
      HttpResponse.json(runtime.getVideo(path(context, "sid"))),
    ),
    socketHandler,
  ];
}

export const handlers = createMockHandlers(mockRuntime);
