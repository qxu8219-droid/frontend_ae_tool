import { describe, expect, it } from "vitest";
import {
  parseServerMessage,
  validateFrameSnapshot,
  validateRest,
} from "../../src/api/validation";
import { example } from "./fixtures";

describe("generated contract runtime validation", () => {
  it("accepts complete backend examples without changing them", () => {
    const frame = example("protocol/FrameSnapshot");
    expect(validateFrameSnapshot(frame)).toEqual(frame);
    for (const name of [
      "service/ws_connection_snapshot",
      "service/ws_frame_snapshot",
      "service/ws_playback_state",
      "service/ws_health_telemetry",
      "service/ws_alert",
      "service/ws_pong",
      "service/ws_system",
      "service/ws_telemetry_rate_changed",
    ] as const) {
      expect(parseServerMessage(example(name), "example-session")).toEqual(
        example(name),
      );
    }
  });

  it.each([
    [
      "unknown field",
      (m: any) => {
        m.extra = true;
      },
    ],
    [
      "missing discriminator",
      (m: any) => {
        delete m.type;
      },
    ],
    [
      "unknown version",
      (m: any) => {
        m.schema_version = 2;
      },
    ],
    [
      "unsafe sequence",
      (m: any) => {
        m.seq = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "nonfinite data",
      (m: any) => {
        m.data.playback.speed = Infinity;
      },
    ],
    [
      "wrong session",
      (m: any) => {
        m.data.playback.session_id = "other";
      },
    ],
    [
      "wrong epoch",
      (m: any) => {
        m.data.sync.playback_epoch += 1;
      },
    ],
    [
      "reordered canonical joints",
      (m: any) => {
        m.data.joint_meta.canonical_order.reverse();
      },
    ],
  ])("rejects %s", (_, mutate) => {
    const value = example("service/ws_connection_snapshot");
    mutate(value);
    expect(() => parseServerMessage(value, "example-session")).toThrow();
  });

  it("rejects mismatched expected session and cross-identity rendered evidence", () => {
    const message = example("service/ws_connection_snapshot");
    expect(() => parseServerMessage(message, "another-session")).toThrow(
      /session/i,
    );
    message.data.sync.last_rendered_identity = example(
      "protocol/FrameIdentity",
    );
    message.data.sync.last_rendered_identity.control_seq =
      message.data.playback.control_seq + 1;
    expect(() => parseServerMessage(message)).toThrow(/identity|control/i);
  });

  it.each([
    [
      "capture identity",
      (f: any) => {
        f.render_seq += 1;
      },
    ],
    [
      "progress",
      (f: any) => {
        f.progress = 0.99;
      },
    ],
    [
      "nonfinite joints",
      (f: any) => {
        f.joints[0] = NaN;
      },
    ],
    [
      "missing quality",
      (f: any) => {
        f.quality[0].origin = "missing";
        f.quality[0].valid = true;
      },
    ],
    [
      "derived method",
      (f: any) => {
        f.quality[0].origin = "derived";
        f.quality[0].method = null;
      },
    ],
  ])("rejects incoherent frame %s", (_, mutate) => {
    const frame = example("protocol/FrameSnapshot");
    mutate(frame);
    expect(() => validateFrameSnapshot(frame)).toThrow();
  });

  it("rejects partial alert locations and nonfinite arbitrary details", () => {
    const alert = example("service/ws_alert");
    delete alert.data.playback_epoch;
    expect(() => parseServerMessage(alert)).toThrow(/location/i);
    alert.data.details = { nested: [Infinity] };
    expect(() => parseServerMessage(alert)).toThrow();
  });
});

it('rejects reference overlays, duplicate ids and reversed annotation intervals', () => {
  const data = { log_id: 'l', source_id: 'src', source_sha256: null, alignment: 'source_frames', provisional: true,
    assumptions: [], reference: {}, events: [], segments: [{ id: 'a', start_s: 0, end_s: 1, start_frame: 0, end_frame: 2, label: 'stage', review_status: 'pending_review', boundary_status: 'unknown', training_approved: false, details: {} }] };
  expect(validateRest('LogAnnotations', data).segments[0]?.training_approved).toBe(false);
  expect(() => validateRest('LogAnnotations', { ...data, alignment: 'reference_only' })).toThrow();
  expect(() => validateRest('LogAnnotations', { ...data, segments: [...data.segments, ...data.segments] })).toThrow();
  expect(() => validateRest('LogAnnotations', { ...data, segments: [{ ...data.segments[0], end_s: 0 }] })).toThrow();
  expect(() => validateRest('LogAnnotations', { ...data, segments: [{ ...data.segments[0], end_frame: 0 }] })).toThrow();
});
