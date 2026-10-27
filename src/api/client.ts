import type { components, operations } from "./types.gen";
import type { JsonValue } from "./generated/json-value.gen";
import { ContractValidationError, validateRest } from "./validation";

type Schemas = components["schemas"];
type Query = NonNullable<
  operations["get_curve_api_v1_sessions__sid__logs__lid__curve_get"]["parameters"]["query"]
>;
export type CurveParams = Omit<Query, "channels"> & {
  channels: string | readonly string[];
};
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface UploadOptions extends RequestOptions {
  parser?: string;
  mapping_config?: Record<string, JsonValue>;
}
export type Fetcher = typeof fetch;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, JsonValue> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function invalid(message: string): never {
  throw new ApiError(0, "INVALID_REQUEST", message);
}

function id(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    invalid("Identifier must contain 1–256 characters");
  try {
    return encodeURIComponent(value);
  } catch {
    return invalid("Identifier contains invalid Unicode");
  }
}

function requestBody<N extends keyof Schemas>(
  schema: N,
  value: unknown,
): Schemas[N] {
  try {
    return validateRest(schema, value);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid request");
  }
}

function cancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function createApiClient(
  baseUrl = "/api/v1",
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
) {
  const base = baseUrl.replace(/\/+$/, "");
  const sessionPath = (sid: string) => `/sessions/${id(sid)}`;

  async function request<N extends keyof Schemas>(
    path: string,
    schema: N,
    options?: RequestOptions,
    init?: RequestInit,
  ): Promise<Schemas[N]>;
  async function request(
    path: string,
    schema: null,
    options?: RequestOptions,
    init?: RequestInit,
  ): Promise<void>;
  async function request(
    path: string,
    schema: keyof Schemas | null,
    options: RequestOptions = {},
    init: RequestInit = {},
  ): Promise<unknown> {
    cancelled(options.signal);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        ...init,
        signal: options.signal,
        headers: { Accept: "application/json", ...init.headers },
      });
      cancelled(options.signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      cancelled(options.signal);
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        error instanceof Error ? error.message : "Network request failed",
      );
    }
    if (response.status === 204 && schema === null) return;
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
      cancelled(options.signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      cancelled(options.signal);
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "Server response is not valid JSON",
      );
    }
    try {
      if (!response.ok) {
        const { error } = validateRest("ErrorEnvelope", body);
        throw new ApiError(
          response.status,
          error.code,
          error.message,
          error.details,
        );
      }
      if (schema === null)
        throw new ContractValidationError("Expected an empty 204 response");
      return validateRest(schema, body);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        error instanceof Error ? error.message : "Invalid server response",
      );
    }
  }

  async function control<
    N extends
      | "LoadRequest"
      | "PlayRequest"
      | "ControlRequest"
      | "SeekRequest"
      | "StepRequest"
      | "SpeedRequest",
  >(
    sid: string,
    action: string,
    schema: N,
    value: Schemas[N],
    options?: RequestOptions,
  ): Promise<Schemas["RESTPlaybackResponse"]> {
    const body = requestBody(schema, {
      ...value,
      request_id: value.request_id ?? crypto.randomUUID(),
    });
    const ack = await request(
      `${sessionPath(sid)}/playback/${action}`,
      "RESTPlaybackResponse",
      options,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (ack.playback.session_id !== sid || ack.request_id !== body.request_id)
      throw new ApiError(
        200,
        "INVALID_RESPONSE",
        "Control response does not match its session and request",
      );
    return ack;
  }

  return {
    async scenes(options?: RequestOptions): Promise<Schemas["SceneList"]> {
      return request("/scenes", "SceneList", options);
    },
    async robots(options?: RequestOptions): Promise<Schemas["RobotList"]> {
      return request("/robots", "RobotList", options);
    },
    async joints(
      robotId: string,
      options?: RequestOptions,
    ): Promise<Schemas["JointMetadata"]> {
      const value = await request(
        `/robots/${id(robotId)}/joints`,
        "JointMetadata",
        options,
      );
      if (value.robot_id !== robotId)
        throw new ApiError(
          200,
          "INVALID_RESPONSE",
          "Joint metadata belongs to another robot",
        );
      return value;
    },
    async createSession(
      body: Schemas["CreateSessionRequest"],
      options?: RequestOptions,
    ): Promise<Schemas["SessionCreated"]> {
      return request("/sessions", "SessionCreated", options, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody("CreateSessionRequest", body)),
      });
    },
    async session(
      sid: string,
      options?: RequestOptions,
    ): Promise<Schemas["SessionStatus"]> {
      const value = await request(sessionPath(sid), "SessionStatus", options);
      if (value.session_id !== sid)
        throw new ApiError(
          200,
          "INVALID_RESPONSE",
          "Session response belongs to another session",
        );
      return value;
    },
    async deleteSession(sid: string, options?: RequestOptions): Promise<void> {
      return request(sessionPath(sid), null, options, { method: "DELETE" });
    },
    async upload(
      sid: string,
      file: File,
      options: UploadOptions = {},
    ): Promise<Schemas["UploadResult"]> {
      const form = new FormData();
      form.append("file", file);
      if (options.parser !== undefined) {
        if (
          typeof options.parser !== "string" ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(options.parser)
        )
          invalid("Invalid upload parser");
        form.append("parser", options.parser);
      }
      if (options.mapping_config !== undefined) {
        if (
          options.mapping_config === null ||
          typeof options.mapping_config !== "object" ||
          Array.isArray(options.mapping_config)
        )
          invalid("mapping_config must be an inline JSON object");
        requestBody("JsonValue", options.mapping_config);
        const mapping = JSON.stringify(options.mapping_config);
        if (mapping.length > 65536)
          invalid("mapping_config exceeds 65536 characters");
        form.append("mapping_config", mapping);
      }
      return request(`${sessionPath(sid)}/logs`, "UploadResult", options, {
        method: "POST",
        body: form,
      });
    },
    async channels(
      sid: string,
      lid: string,
      options?: RequestOptions,
    ): Promise<Schemas["LogChannels"]> {
      const value = await request(
        `${sessionPath(sid)}/logs/${id(lid)}/channels`,
        "LogChannels",
        options,
      );
      if (value.log_id !== lid)
        throw new ApiError(
          200,
          "INVALID_RESPONSE",
          "Channels belong to another log",
        );
      return value;
    },
    async annotations(sid: string, lid: string, options?: RequestOptions): Promise<Schemas["LogAnnotations"]> {
      const value = await request(`${sessionPath(sid)}/logs/${id(lid)}/annotations`, "LogAnnotations", options);
      if (value.log_id !== lid)
        throw new ApiError(200, "INVALID_RESPONSE", "Annotations belong to another log");
      return value;
    },
    async curve(
      sid: string,
      lid: string,
      params: CurveParams,
      options?: RequestOptions,
    ): Promise<Schemas["CurveResponse"]> {
      const raw = Array.isArray(params.channels)
        ? params.channels.join(",")
        : params.channels;
      if (typeof raw !== "string" || raw.length > 32768)
        invalid("channels must be a comma-separated string");
      const names = raw.split(",").map((value) => value.trim());
      const channels = [...new Set(names)];
      if (
        names.some((value) => !value || value.length > 256) ||
        channels.length > 128
      )
        invalid("Provide 1–128 nonempty channel names");
      const from = params.from_s ?? 0;
      const to = params.to_s;
      const points = params.max_points ?? 2000;
      if (
        typeof from !== "number" ||
        !Number.isFinite(from) ||
        from < 0 ||
        (to != null &&
          (typeof to !== "number" || !Number.isFinite(to) || to < from)) ||
        !Number.isInteger(points) ||
        points < 2 ||
        points > 10000
      )
        invalid("Curve range and point budget must be finite and ordered");
      const query = new URLSearchParams({
        channels: channels.join(","),
        from_s: String(from),
        max_points: String(points),
      });
      if (to != null) query.set("to_s", String(to));
      const value = await request(
        `${sessionPath(sid)}/logs/${id(lid)}/curve?${query}`,
        "CurveResponse",
        options,
      );
      if (value.log_id !== lid)
        throw new ApiError(
          200,
          "INVALID_RESPONSE",
          "Curve belongs to another log",
        );
      return value;
    },
    load(sid: string, body: Schemas["LoadRequest"], options?: RequestOptions) {
      return control(sid, "load", "LoadRequest", body, options);
    },
    play(
      sid: string,
      body: Schemas["PlayRequest"] = {},
      options?: RequestOptions,
    ) {
      return control(sid, "play", "PlayRequest", body, options);
    },
    pause(
      sid: string,
      body: Schemas["ControlRequest"] = {},
      options?: RequestOptions,
    ) {
      return control(sid, "pause", "ControlRequest", body, options);
    },
    stop(
      sid: string,
      body: Schemas["ControlRequest"] = {},
      options?: RequestOptions,
    ) {
      return control(sid, "stop", "ControlRequest", body, options);
    },
    seek(sid: string, body: Schemas["SeekRequest"], options?: RequestOptions) {
      return control(sid, "seek", "SeekRequest", body, options);
    },
    step(sid: string, body: Schemas["StepRequest"], options?: RequestOptions) {
      return control(sid, "step", "StepRequest", body, options);
    },
    speed(
      sid: string,
      body: Schemas["SpeedRequest"],
      options?: RequestOptions,
    ) {
      return control(sid, "speed", "SpeedRequest", body, options);
    },
    async playback(
      sid: string,
      options?: RequestOptions,
    ): Promise<Schemas["PlaybackSnapshot"]> {
      const value = await request(
        `${sessionPath(sid)}/playback`,
        "PlaybackSnapshot",
        options,
      );
      if (value.session_id !== sid)
        throw new ApiError(
          200,
          "INVALID_RESPONSE",
          "Playback belongs to another session",
        );
      return value;
    },
    async video(
      sid: string,
      options?: RequestOptions,
    ): Promise<Schemas["VideoInfo"]> {
      return request(`${sessionPath(sid)}/video`, "VideoInfo", options);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
