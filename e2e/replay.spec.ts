import { test, expect } from "./fixtures";
import {
  assertPair,
  collectPairs,
  createReadySession,
  diagnostics,
  loadDemo,
  readPair,
  recordPair,
  seek,
  waitPair,
} from "./oracle";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("mode-badge")).toContainText(/Mock/i);
  await expect(page.getByTestId("create-session")).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""),
    )
    .toContain("/mockServiceWorker.js");
});

test("UI controls preserve actual frame pairing through play, pause, seek, steps, speeds, stop and replay", async ({
  page,
  evidence,
}) => {
  const sid = await createReadySession(page);
  const loaded = await loadDemo(page);
  expect(loaded.snapshot.source_sample_index).toBe(0);
  const ready = await collectPairs(page, evidence, "loaded-at-zero");
  expect(
    ready.every(
      (sample) =>
        sample.snapshot.log_time_s === 0 && sample.snapshot.state === "ready",
    ),
  ).toBe(true);

  await page.getByTestId("speed-select").selectOption("0.1");
  await waitPair(page, (sample) => sample.snapshot.speed === 0.1);
  await page.getByTestId("play").click();
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.state === "playing" && sample.snapshot.log_time_s > 0,
  );
  const playing = await collectPairs(page, evidence, "playing-0.1", 5);
  expect(playing.at(-1)!.snapshot.log_time_s).toBeGreaterThan(
    playing[0]!.snapshot.log_time_s,
  );
  expect(playing.at(-1)!.snapshot.source_joints[0]).not.toBe(
    playing[0]!.snapshot.source_joints[0],
  );
  expect(
    new Set(playing.map((sample) => sample.robotPixelsHash)).size,
    "Actual robot geometry must move during playback",
  ).toBeGreaterThan(1);
  expect(playing.every((sample) => sample.snapshot.speed === 0.1)).toBe(true);

  await page.getByTestId("pause").click();
  await waitPair(page, (sample) => sample.snapshot.state === "paused");
  const paused = await collectPairs(
    page,
    evidence,
    "paused-captures-continue",
    5,
  );
  expect(paused.at(-1)!.snapshot.capture_id).toBeGreaterThan(
    paused[0]!.snapshot.capture_id,
  );
  for (const sample of paused) {
    expect(sample.snapshot.log_time_s).toBe(paused[0]!.snapshot.log_time_s);
    expect(sample.snapshot.joints).toEqual(paused[0]!.snapshot.joints);
    expect(
      sample.robotPixelsHash,
      "Paused robot pixels remain fixed while capture stamps advance",
    ).toBe(paused[0]!.robotPixelsHash);
  }

  await seek(page, 3);
  const atThree = await collectPairs(page, evidence, "exact-seek-three");
  for (const sample of atThree) {
    expect(sample.snapshot.log_time_s).toBe(3);
    expect(sample.snapshot.source_sample_index).toBe(180);
  }
  await page.getByTestId("step-forward").click();
  await waitPair(
    page,
    (sample) => Math.abs(sample.snapshot.log_time_s - 181 / 60) < 1e-12,
  );
  const forward = await collectPairs(
    page,
    evidence,
    "single-source-step-forward",
  );
  expect(
    forward.every(
      (sample) =>
        sample.snapshot.source_sample_index === 181 &&
        sample.snapshot.state === "paused",
    ),
  ).toBe(true);
  await page.getByTestId("step-backward").click();
  await waitPair(page, (sample) => sample.snapshot.log_time_s === 3);
  const backward = await collectPairs(
    page,
    evidence,
    "single-source-step-backward",
  );
  expect(
    backward.every((sample) => sample.snapshot.source_sample_index === 180),
  ).toBe(true);

  for (const speed of [1, 4, 10]) {
    await page.getByTestId("speed-select").selectOption(String(speed));
    await waitPair(page, (sample) => sample.snapshot.speed === speed);
    await page.getByTestId("play").click();
    await waitPair(
      page,
      (sample) =>
        sample.snapshot.state === "playing" && sample.snapshot.speed === speed,
    );
    const samples = await collectPairs(page, evidence, `playing-${speed}`, 4);
    expect(samples.every((sample) => sample.snapshot.speed === speed)).toBe(
      true,
    );
    expect(samples.at(-1)!.snapshot.log_time_s).toBeGreaterThan(
      samples[0]!.snapshot.log_time_s,
    );
    await page.getByTestId("pause").click();
    await waitPair(page, (sample) => sample.snapshot.state === "paused");
  }

  await page.getByTestId("stop").click();
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.state === "ready" && sample.snapshot.log_time_s === 0,
  );
  const stopped = await collectPairs(page, evidence, "stop-at-zero");
  expect(
    stopped.every(
      (sample) =>
        sample.snapshot.log_time_s === 0 &&
        sample.snapshot.source_sample_index === 0,
    ),
  ).toBe(true);
  await page.getByTestId("speed-select").selectOption("1");
  await page.getByTestId("play").click();
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.state === "playing" && sample.snapshot.log_time_s > 0,
  );
  const replayed = await collectPairs(page, evidence, "replay-after-stop");
  expect(replayed.at(-1)!.snapshot.capture_id).toBeGreaterThan(
    stopped.at(-1)!.snapshot.capture_id,
  );
  expect(replayed.at(-1)!.snapshot.session_id).toBe(sid);
  expect(replayed.at(-1)!.snapshot.log_id).toBe(loaded.snapshot.log_id);
  evidence.observations.lifecycle = {
    sid,
    logId: loaded.snapshot.log_id,
    sampledPhases: 11,
  };
});

test("healthy moving Mock playback sustains the initial presentation budget", async ({
  page,
  evidence,
}) => {
  await createReadySession(page);
  await loadDemo(page);
  await page.getByTestId("speed-select").selectOption("0.1");
  await waitPair(page, (sample) => sample.snapshot.speed === 0.1);
  await page.getByTestId("play").click();
  await waitPair(page, (sample) => sample.snapshot.state === "playing");
  await collectPairs(page, evidence, "performance-warmup", 5);
  const initial = await page.evaluate(() => ({
    wall: performance.now(),
    count: (window as any).__replayDiagnostics.sync().presented,
  }));
  let samples = 0,
    maxLatency = 0;
  for (let index = 0; index < 28; index++) {
    await page.waitForTimeout(250);
    const sample = await readPair(page);
    expect(sample).not.toBeNull();
    assertPair(sample!);
    recordPair(evidence, `steady-${index}`, sample!);
    samples++;
    maxLatency = Math.max(
      maxLatency,
      Date.now() - sample!.snapshot.captured_wall_s * 1000,
    );
  }
  const final = await page.evaluate(() => ({
    wall: performance.now(),
    count: (window as any).__replayDiagnostics.sync().presented,
  }));
  const elapsedMs = final.wall - initial.wall,
    presentations = final.count - initial.count,
    fps = (presentations * 1000) / elapsedMs;
  evidence.observations.performance = {
    scope: "Moving Mock canvas presentations; not IsaacSim/NVENC",
    elapsedMs,
    presentations,
    fps,
    samples,
    maxLatencyMs: maxLatency,
  };
  expect(fps).toBeGreaterThanOrEqual(15);
  expect(maxLatency).toBeLessThan(2000);
});

test("parse-error returns a valid visible error and never activates playback", async ({
  page,
  evidence,
}) => {
  await page.getByTestId("scenario-select").selectOption("parse-error");
  await createReadySession(page);
  const upload = page.waitForResponse(
    (response) =>
      /\/sessions\/[^/]+\/logs$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByTestId("demo-load").click();
  const response = await upload;
  expect(response.status()).toBe(422);
  const body = await response.json();
  expect(body.error).toMatchObject({
    code: "MOCK_PARSE_ERROR",
    message: expect.any(String),
    details: expect.any(Object),
  });
  expect(body.error.details.issues[0]).toMatchObject({
    severity: "error",
    code: "MOCK_PARSE_ERROR",
  });
  await expect(page.getByTestId("error-message")).toContainText(
    /MOCK_PARSE_ERROR|parser failure|解析/i,
  );
  await expect(page.getByTestId("play")).toBeDisabled();
  await page.waitForTimeout(250);
  const state = await diagnostics(page);
  expect(state.snapshot).toBeNull();
  expect(state.sync.presented).toBe(0);
  expect(
    evidence.requests.filter((request) =>
      /\/playback\/load$/.test(request.url),
    ),
  ).toEqual([]);
  evidence.observations.error = { status: response.status(), body, state };
});

test("missing channels retain explicit missing provenance and invalid quality in paired frames", async ({
  page,
  evidence,
}) => {
  await page.getByTestId("scenario-select").selectOption("missing-channels");
  await createReadySession(page);
  await loadDemo(page);
  await page.getByTestId("play").click();
  await waitPair(page, (sample) => sample.snapshot.state === "playing");
  const samples = await collectPairs(
    page,
    evidence,
    "missing-channel-quality",
    5,
  );
  for (const { snapshot } of samples) {
    expect(
      snapshot.quality
        .slice(0, 25)
        .every((quality) => quality.valid && quality.origin === "derived"),
    ).toBe(true);
    expect(
      snapshot.quality
        .slice(25)
        .map(({ origin, valid }) => ({ origin, valid })),
    ).toEqual([
      { origin: "missing", valid: false },
      { origin: "missing", valid: false },
      { origin: "missing", valid: false },
    ]);
    expect(snapshot.source_joints.slice(25)).toEqual([0, 0, 0]);
    expect(snapshot.joints.slice(25)).toEqual([0, 0, 0]);
  }
});

test("no-log prevents playback without presenting a synthetic substitute", async ({
  page,
  evidence,
}) => {
  await page.getByTestId("scenario-select").selectOption("no-log");
  await createReadySession(page);
  await expect(page.getByTestId("play")).toBeDisabled();
  await expect(page.getByTestId("seek-submit")).toBeDisabled();
  await expect(page.getByTestId("step-forward")).toBeDisabled();
  await page.waitForTimeout(350);
  const state = await diagnostics(page);
  expect(state.snapshot).toBeNull();
  expect(state.sync.presented).toBe(0);
  expect(state.sync.frames).toBe(0);
  expect(state.sync.snapshots).toBe(0);
  expect(
    evidence.requests.filter((request) =>
      /\/playback\/(play|seek|step)$/.test(request.url),
    ),
  ).toEqual([]);
  evidence.observations.noLog = state;
});

test("worker failure freezes the last pair until close, new session, and demo reupload from zero", async ({
  page,
  evidence,
}) => {
  const oldSid = await createReadySession(page);
  const loaded = await loadDemo(page);
  await page.getByTestId("play").click();
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.state === "playing" && sample.snapshot.log_time_s > 0.1,
  );
  await collectPairs(page, evidence, "before-worker-error");
  await page.getByTestId("scenario-select").selectOption("worker-error");
  await expect
    .poll(async () => (await diagnostics(page)).session.workerPhase)
    .toBe("error");
  await expect(page.getByTestId("error-message")).toContainText(
    /MOCK_WORKER_EXITED|worker failure|重建|故障/i,
  );
  await expect(page.getByTestId("play")).toBeDisabled();
  await expect(page.getByTestId("demo-load")).toBeDisabled();
  const frozen = await readPair(page);
  expect(frozen).not.toBeNull();
  assertPair(frozen!, oldSid);
  for (let index = 0; index < 4; index++) {
    await page.waitForTimeout(120);
    const sample = await readPair(page);
    expect(sample?.snapshot).toEqual(frozen!.snapshot);
    expect(sample?.stamp).toEqual(frozen!.stamp);
    expect(sample?.robotPixelsHash).toBe(frozen!.robotPixelsHash);
    expect(sample?.sync.presented).toBe(frozen!.sync.presented);
    expect(sample?.sync.frames).toBe(0);
    expect(sample?.sync.snapshots).toBe(0);
    expect(sample?.source?.pending ?? 0).toBe(0);
    expect(sample?.source?.owned ?? 0).toBe(0);
    recordPair(evidence, "frozen-worker-error", sample!);
  }
  await page.getByTestId("scenario-select").selectOption("normal");
  await page.waitForTimeout(150);
  expect((await diagnostics(page)).session.workerPhase).toBe("error");
  await page.getByTestId("close-session").click();
  await expect
    .poll(async () => (await diagnostics(page)).session.sid)
    .toBeNull();
  const newSid = await createReadySession(page);
  expect(newSid).not.toBe(oldSid);
  await expect(page.getByTestId("play")).toBeDisabled();
  const reloaded = await loadDemo(page);
  expect(reloaded.snapshot.log_id).not.toBe(loaded.snapshot.log_id);
  const recovered = await collectPairs(
    page,
    evidence,
    "worker-recreated-at-zero",
  );
  expect(
    recovered.every(
      (sample) =>
        sample.snapshot.session_id === newSid &&
        sample.snapshot.log_time_s === 0,
    ),
  ).toBe(true);
  expect(
    evidence.requests.filter(
      (request) => request.method === "POST" && /\/logs$/.test(request.url),
    ),
  ).toHaveLength(2);
  evidence.observations.workerRecovery = {
    oldSid,
    newSid,
    oldLog: loaded.snapshot.log_id,
    newLog: reloaded.snapshot.log_id,
  };
});

for (const scenario of ["video-delay", "data-delay"] as const) {
  test(`${scenario}: 650 ms late delivery keeps actual frames paired, caches bounded, and recovers`, async ({
    page,
    evidence,
  }) => {
    await createReadySession(page);
    await loadDemo(page);
    await page.getByTestId("speed-select").selectOption("0.1");
    await page.getByTestId("play").click();
    await waitPair(page, (sample) => sample.snapshot.state === "playing");
    const baseline = await collectPairs(page, evidence, `${scenario}-baseline`);
    await page.getByTestId("scenario-select").selectOption(scenario);
    await page.waitForTimeout(850);
    const delayed = await collectPairs(
      page,
      evidence,
      `${scenario}-delayed`,
      8,
    );
    expect(
      Math.min(...delayed.map((sample) => sample.captureAgeMs)),
      "Pixels and metadata must both reflect the delayed capture",
    ).toBeGreaterThanOrEqual(550);
    expect(delayed.at(-1)!.snapshot.capture_id).toBeGreaterThan(
      baseline.at(-1)!.snapshot.capture_id,
    );
    expect(delayed.at(-1)!.snapshot.log_time_s).toBeGreaterThan(
      delayed[0]!.snapshot.log_time_s,
    );
    if (scenario === "video-delay") {
      expect(
        Math.max(...delayed.map((sample) => sample.source?.pending ?? 0)),
      ).toBeGreaterThanOrEqual(8);
      expect(
        Math.max(...delayed.map((sample) => sample.sync.snapshots)),
      ).toBeGreaterThanOrEqual(8);
    } else {
      expect(
        Math.max(...delayed.map((sample) => sample.sync.frames)),
      ).toBeGreaterThanOrEqual(8);
    }
    await page.getByTestId("scenario-select").selectOption("normal");
    await page.waitForTimeout(800);
    const recovered = await collectPairs(
      page,
      evidence,
      `${scenario}-recovered`,
      5,
    );
    expect(recovered.at(-1)!.snapshot.capture_id).toBeGreaterThan(
      delayed.at(-1)!.snapshot.capture_id,
    );
    expect(recovered.at(-1)!.source?.pending ?? 0).toBe(0);
    expect(recovered.at(-1)!.sync.frames).toBeLessThanOrEqual(2);
    expect(recovered.at(-1)!.sync.snapshots).toBeLessThanOrEqual(2);
    evidence.observations.delay = {
      scenario,
      injectedDelayMs: 650,
      samples: delayed.length,
      minObservedCaptureAgeMs: Math.min(
        ...delayed.map((sample) => sample.captureAgeMs),
      ),
      maxObservedCaptureAgeMs: Math.max(
        ...delayed.map((sample) => sample.captureAgeMs),
      ),
    };
  });
}

test("native WebSocket reconnect advances generation and restores the full active session", async ({
  page,
  evidence,
}) => {
  const sid = await createReadySession(page);
  await loadDemo(page);
  await seek(page, 3);
  await page.getByTestId("speed-select").selectOption("0.1");
  await page.getByTestId("play").click();
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.state === "playing" && sample.snapshot.log_time_s >= 3,
  );
  const before = (
    await collectPairs(page, evidence, "before-websocket-reconnect")
  ).at(-1)!;
  await page.getByTestId("scenario-select").selectOption("ws-reconnect");
  await expect
    .poll(async () => (await diagnostics(page)).session.wsGeneration)
    .toBeGreaterThan(before.session.wsGeneration);
  await waitPair(
    page,
    (sample) =>
      sample.snapshot.capture_id > before.snapshot.capture_id &&
      sample.session.wsGeneration > before.session.wsGeneration &&
      sample.snapshot.state === "playing",
  );
  const recovered = await collectPairs(
    page,
    evidence,
    "websocket-full-state-restored",
    5,
  );
  for (const sample of recovered) {
    expect(sample.session.sid).toBe(sid);
    expect(sample.session.workerPhase).toBe("ready");
    expect(sample.snapshot.log_id).toBe(before.snapshot.log_id);
    expect(sample.snapshot.speed).toBe(0.1);
    expect(sample.snapshot.log_time_s).toBeGreaterThanOrEqual(
      before.snapshot.log_time_s,
    );
    expect(sample.snapshot.control_seq).toBeGreaterThanOrEqual(
      before.snapshot.control_seq,
    );
    expect(sample.snapshot.playback_epoch).toBeGreaterThanOrEqual(
      before.snapshot.playback_epoch,
    );
    expect(sample.snapshot.quality).toHaveLength(28);
  }
  evidence.observations.reconnect = {
    beforeGeneration: before.session.wsGeneration,
    afterGeneration: recovered.at(-1)!.session.wsGeneration,
  };
});

test("close and immediate recreate destroy delayed resources without old-session metadata", async ({
  page,
  evidence,
}) => {
  let sid = await createReadySession(page);
  let loaded = await loadDemo(page);
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.getByTestId("play").click();
    await waitPair(page, (sample) => sample.snapshot.state === "playing");
    await page.getByTestId("scenario-select").selectOption("video-delay");
    await expect
      .poll(async () => (await diagnostics(page)).source?.pending ?? 0)
      .toBeGreaterThanOrEqual(5);
    const oldSid = sid;
    const oldLog = loaded.snapshot.log_id;
    await page.getByTestId("close-session").click();
    await expect
      .poll(async () => (await diagnostics(page)).session.sid)
      .toBeNull();
    const closed = await diagnostics(page);
    expect(closed.snapshot).toBeNull();
    expect(closed.sync.frames).toBe(0);
    expect(closed.sync.snapshots).toBe(0);
    expect(closed.source?.pending ?? 0).toBe(0);
    expect(closed.source?.owned ?? 0).toBe(0);
    await page.getByTestId("scenario-select").selectOption("normal");
    sid = await createReadySession(page);
    expect(sid).not.toBe(oldSid);
    expect((await diagnostics(page)).snapshot).toBeNull();
    await expect(page.getByTestId("play")).toBeDisabled();
    loaded = await loadDemo(page);
    expect(loaded.snapshot.log_id).not.toBe(oldLog);
    const samples = await collectPairs(
      page,
      evidence,
      `new-session-${iteration}`,
      8,
    );
    for (const sample of samples) {
      expect(sample.snapshot.session_id).toBe(sid);
      expect(sample.snapshot.log_id).toBe(loaded.snapshot.log_id);
      expect(sample.snapshot.log_time_s).toBe(0);
    }
  }
  await page.getByTestId("close-session").click();
  await expect
    .poll(async () => (await diagnostics(page)).session.sid)
    .toBeNull();
  await page.waitForTimeout(750);
  const closed = await diagnostics(page);
  expect(closed.snapshot).toBeNull();
  expect(closed.sync.frames).toBe(0);
  expect(closed.sync.snapshots).toBe(0);
  expect(closed.source?.pending ?? 0).toBe(0);
  expect(closed.source?.owned ?? 0).toBe(0);
  evidence.observations.finalClosed = closed;
});
