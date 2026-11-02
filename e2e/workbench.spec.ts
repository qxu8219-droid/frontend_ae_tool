import { test, expect } from "./fixtures";
import {
  createReadySession,
  loadDemo,
  readPair,
  waitPair,
  assertPair,
  recordPair,
  diagnostics,
  seek,
} from "./oracle";
import type { Page } from "@playwright/test";

async function cursor(page: Page) {
  return page.evaluate(() => {
    const frame = (window as any).__replayDiagnostics.snapshot();
    if (!frame) return null;
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="paired-canvas"]',
    )!;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Independent geometry from the documented final canvas, not renderer imports.
    const expectedX = 80 + (frame.log_time_s / frame.duration_s) * 1160;
    const pixel = ctx.getImageData(Math.floor(expectedX), 900, 1, 1).data;
    const absentX = frame.log_time_s < 6 ? 1120 : 160;
    const other = ctx.getImageData(absentX, 900, 1, 1).data;
    const cyan = (p: Uint8ClampedArray) =>
      Math.abs(p[0] - 69) < 3 &&
      Math.abs(p[1] - 216) < 3 &&
      Math.abs(p[2] - 232) < 3;
    return {
      captureId: frame.capture_id,
      time: frame.log_time_s,
      expectedX,
      matched: cyan(pixel),
      other: cyan(other),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("create-session")).toBeEnabled();
  await createReadySession(page);
});

test("file mapping is validated, upload inspected before activation, and failure preserves active playback", async ({
  page,
  evidence,
}) => {
  await page.getByText("解析器与映射配置").click();
  await page.getByTestId("mapping-json").fill("[]");
  await expect(page.getByTestId("mapping-error")).toBeVisible();
  await expect(page.getByTestId("choose-file")).toBeDisabled();
  await page
    .getByTestId("mapping-json")
    .fill('{"timestamp":{"field":"robot_time","unit":"s"}}');
  await page.getByTestId("upload-parser").fill("json_v1");
  const uploadResponse = page.waitForResponse(
    (r) =>
      /\/logs$/.test(new URL(r.url()).pathname) &&
      r.request().method() === "POST",
  );
  await page
    .getByTestId("file-input")
    .setInputFiles({
      name: "real-name.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"not_real_data":true}'),
    });
  const upload = await (await uploadResponse).json();
  expect(upload.mapping_snapshot.requested_mapping).toEqual({
    timestamp: { field: "robot_time", unit: "s" },
  });
  await expect(page.getByTestId("upload-result")).toBeVisible();
  expect((await diagnostics(page)).snapshot).toBeNull();
  await expect(page.getByTestId("play")).toBeDisabled();
  await page.getByTestId("activate-log").click();
  const first = await waitPair(
    page,
    (p) => p.snapshot.log_id === upload.log_id,
  );
  assertPair(first);
  recordPair(evidence, "activated-upload", first);
  await seek(page, 5);
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  await page
    .getByTestId("file-input")
    .setInputFiles({
      name: "large.log",
      mimeType: "text/plain",
      buffer: oversized,
    });
  await expect(page.getByTestId("upload-file-error")).toBeVisible();
  await page.getByTestId("scenario-select").selectOption("parse-error");
  await page
    .getByTestId("file-input")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("{}"),
    });
  await expect(page.getByTestId("parse-issues")).toContainText(
    "MOCK_PARSE_ERROR",
  );
  await expect(page.getByTestId("upload-result")).toHaveCount(0);
  await expect(page.getByTestId("activate-log")).toHaveCount(0);
  const retained = await readPair(page);
  assertPair(retained!);
  expect(retained!.snapshot.log_id).toBe(upload.log_id);
  expect(retained!.snapshot.log_time_s).toBe(5);
});

test("100ms timeline preview and release commit the final target while displayed frame and curve cursor stay paired", async ({
  page,
  evidence,
}) => {
  await loadDemo(page);
  await expect.poll(async () => (await cursor(page))?.matched).toBe(true);
  const requests: number[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/seek")) requests.push(r.postDataJSON()?.time_s);
  });
  await page.getByTestId("timeline").evaluate(async (input) => {
    const slider = input as HTMLInputElement;
    for (let i = 1; i <= 9; i++) {
      slider.value = String(i * 0.9);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 8));
    }
    slider.value = "8.25";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.getByTestId("preview-time")).toContainText("8.250");
  await page.getByTestId("timeline").dispatchEvent("change");
  const atTarget = await waitPair(page, (p) => p.snapshot.log_time_s === 8.25);
  assertPair(atTarget);
  recordPair(evidence, "timeline-final", atTarget);
  expect(requests.at(-1)).toBe(8.25);
  expect(requests.length).toBeLessThanOrEqual(2);
  await expect.poll(async () => (await cursor(page))?.matched).toBe(true);
  const first = await cursor(page);
  expect(first?.other).toBe(false);
  evidence.observations.cursor = first;
  await page.getByTestId("frame-input").fill("180");
  await page.getByTestId("frame-submit").click();
  const frameSeek = await waitPair(
    page,
    (p) => p.snapshot.source_sample_index === 180,
  );
  expect(frameSeek.snapshot.log_time_s).toBe(3);
  recordPair(evidence, "frame-index-seek", frameSeek);
  await page.getByTestId("scenario-select").selectOption("video-delay");
  await page.getByTestId("play").click();
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(110);
    const current = await cursor(page);
    expect(current?.matched).toBe(true);
    expect(current?.other).toBe(false);
    const pair = await readPair(page);
    assertPair(pair!);
    recordPair(evidence, `cursor-late-video-${i}`, pair!);
  }
  await page.getByTestId("pause").click();
});

test("history is reverse sorted and filterable, seek follows events, groups collapse, and health remains independent", async ({
  page,
  evidence,
}) => {
  await loadDemo(page);
  await expect
    .poll(() =>
      page
        .getByTestId("channel-select")
        .evaluate((el) => (el as HTMLSelectElement).selectedOptions.length),
    )
    .toBe(4);
  const rows = page.getByTestId("history-events").locator("button");
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  const times = (await rows.allTextContents()).map((s) =>
    Number(s.split(" s")[0]),
  );
  expect(times).toEqual([...times].sort((a, b) => b - a));
  await page.getByTestId("severity-filter").selectOption("error");
  const severity = await page
    .getByTestId("history-events")
    .locator("li[data-severity]")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-severity")));
  expect(severity.length).toBeGreaterThan(0);
  expect(severity.every((s) => s === "error")).toBe(true);
  const target = Number((await rows.first().innerText()).split(" s")[0]);
  await rows.first().click();
  const paired = await waitPair(
    page,
    (p) => Math.abs(p.snapshot.log_time_s - target) < 0.0011,
  );
  assertPair(paired);
  recordPair(evidence, "event-seek", paired);
  await expect.poll(async () => (await cursor(page))?.matched).toBe(true);
  await page.getByTestId("group-left").click();
  await expect(page.getByTestId("group-left")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.waitForTimeout(100);
  const hidden = await page.getByTestId("paired-canvas").evaluate((canvas) => {
    const c = (canvas as HTMLCanvasElement).getContext("2d")!;
    const pixels = c.getImageData(1030, 430, 60, 13).data;
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180)
        bright++;
    return bright;
  });
  expect(hidden).toBe(0);
  await page.getByTestId("group-left").click();
  await expect(page.getByTestId("group-left")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect
    .poll(async () => (await readPair(page))?.visibleText.joints[2])
    .toBe(0);
  assertPair((await readPair(page))!);
  await page.getByTestId("event-view").selectOption("triggered");
  await page.getByTestId("stop").click();
  await waitPair(page, (p) => p.snapshot.log_time_s === 0);
  // Initial pose itself has limits in this fixture; only events at time zero may now be triggered.
  const resetTimes = (
    await page.getByTestId("history-events").locator("button").allTextContents()
  ).map((s) => Number(s.split(" s")[0]));
  expect(resetTimes.every((time) => time === 0)).toBe(true);
  await expect(page.getByTestId("health-panel")).toContainText("CPU");
  await page.getByTestId("channel-select").selectOption([]);
  await page
    .getByTestId("channel-select")
    .selectOption(["torso_joint1", "left_gripper_finger_joint1"]);
  await expect
    .poll(() =>
      page
        .getByTestId("channel-select")
        .evaluate((el) =>
          Array.from((el as HTMLSelectElement).selectedOptions).map(
            (o) => o.value,
          ),
        ),
    )
    .toEqual(["torso_joint1", "left_gripper_finger_joint1"]);
  await expect.poll(async () => (await cursor(page))?.matched).toBe(true);
});
