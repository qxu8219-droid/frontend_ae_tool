import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** Lossless recording of the Chrome viewport surface, never exported app canvas pixels. */
export async function startLosslessScreenRecording(page: Page, output: string) {
  await mkdir(join(output, 'screen-frames'), { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Lossless recording requires an explicit viewport');
  const frames: Array<{ file: string; sha256: string; timestamp_ms: number; width: number; height: number }> = [];
  const pending = new Set<Promise<void>>();
  const errors: string[] = [];
  let receivedFrames = 0, maximumPending = 0;
  const onFrame = (event: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const index = receivedFrames++;
    if (pending.size >= 4) {
      errors.push(`Screencast persistence queue exceeded four frames at ${index}`);
      void cdp.send('Page.stopScreencast').catch(error => errors.push(String(error)));
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => errors.push(String(error)));
      return;
    }
    const save = (async () => {
      const png = Buffer.from(event.data, 'base64');
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('CDP did not emit PNG');
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      if (width !== viewport.width || height !== viewport.height) throw new Error('Screencast dimensions differ from viewport');
      if (!Number.isFinite(event.metadata.timestamp)) throw new Error('Screencast timestamp is absent');
      const file = `screen-frames/${String(index).padStart(8, '0')}.png`;
      await writeFile(join(output, file), png);
      frames[index] = { file, sha256: createHash('sha256').update(png).digest('hex'),
        timestamp_ms: event.metadata.timestamp! * 1000, width, height };
    })().catch(error => { errors.push(String(error)); }).finally(async () => {
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => errors.push(String(error)));
    });
    pending.add(save); maximumPending = Math.max(maximumPending, pending.size);
    void save.finally(() => pending.delete(save));
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.enable');
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: viewport.width,
    maxHeight: viewport.height, everyNthFrame: 1 });
  let stopped: Promise<{ manifest: string; complete: boolean; frameCount: number; errors: string[] }> | null = null;
  return {
    stop() {
      stopped ??= (async () => {
        await cdp.send('Page.stopScreencast').catch(error => errors.push(String(error)));
        cdp.off('Page.screencastFrame', onFrame);
        await Promise.all([...pending]);
        await cdp.detach().catch(error => errors.push(String(error)));
        const saved = frames.filter(Boolean);
        const complete = errors.length === 0 && receivedFrames > 0 && saved.length === receivedFrames;
        const manifest = join(output, 'screen-recording.json');
        await writeFile(manifest, JSON.stringify({ schema: 'chromium-cdp-png/v1', complete,
          format: 'Lossless PNG sequence of the actual Chrome viewport surface', viewport,
          received_frames: receivedFrames, persisted_frames: saved.length, maximum_pending: maximumPending,
          errors, frames: saved, timestamp_source: 'Page.screencastFrame.metadata.timestamp (seconds since epoch, stored in milliseconds)',
        }, null, 2));
        return { manifest, complete, frameCount: saved.length, errors };
      })();
      return stopped;
    },
  };
}

/** Independent recording evidence; no application renderer/stamp/runtime imports. */
export async function installRecordingEvidence(page: Page, output: string) {
  await mkdir(join(output, 'references'), { recursive: true });
  const observations = join(output, 'recording-observations.jsonl');
  await writeFile(observations, '');
  const pending = new Set<Promise<void>>();
  let count = 0;
  const startedWallMs = Date.now();
  let startBoundary: unknown = null;
  let endBoundary: unknown = null;
  async function boundary() {
    const candidates: Array<{ capture_id: number; session_id: string; wall_ms: number }> = [];
    const started = Date.now();
    do {
      const sample = await page.evaluate(() => {
        const diagnostic = (window as unknown as { __replayDiagnostics?: {
          snapshot(): { capture_id: number; session_id: string } | null;
        } }).__replayDiagnostics;
        const snapshot = diagnostic?.snapshot();
        if (!snapshot) throw new Error('Recording boundary requires a presented snapshot');
        return { capture_id: snapshot.capture_id, session_id: snapshot.session_id, wall_ms: Date.now() };
      });
      if (!candidates.some(candidate => candidate.capture_id === sample.capture_id)) candidates.push(sample);
      await page.waitForTimeout(25);
    } while (Date.now() - started < 250);
    if (new Set(candidates.map(candidate => candidate.session_id)).size !== 1)
      throw new Error('Recording boundary cannot cross a session reset');
    return { session_id: candidates[0]!.session_id, capture_ids: candidates.map(candidate => candidate.capture_id),
      candidates, collection_started_wall_ms: started, collection_ended_wall_ms: Date.now() };
  }
  await page.exposeBinding('__recordingEvidence', async (_source, entry: Record<string, unknown>) => {
    const save = (async () => {
      const index = count++;
      const png = entry.png as string;
      delete entry.png;
      const reference = `references/${String(index).padStart(7, '0')}.png`;
      await writeFile(join(output, reference), Buffer.from(png.split(',')[1]!, 'base64'));
      await appendFile(observations, JSON.stringify({ ...entry, reference }) + '\n');
    })();
    pending.add(save);
    try { await save; } finally { pending.delete(save); }
  });
  await page.addInitScript(() => {
    type Snapshot = {
      capture_id: number; session_id: string; playback_epoch: number; control_seq: number;
      log_time_s: number; duration_s: number; progress: number; state: string; speed: number;
      joints: number[]; source_joints: number[]; quality: Array<{ valid: boolean; origin: string }>;
    };
    const host = window as unknown as {
      __replayDiagnostics?: { snapshot(): Snapshot | null; layout(): unknown };
      __recordingEvidence(entry: unknown): Promise<void>;
      __stopRecordingEvidence?: () => void;
      __recordingEvidenceErrors?: string[];
    };
    let stopped = false;
    let previous = '';
    let busy = false;
    host.__recordingEvidenceErrors = [];
    host.__stopRecordingEvidence = () => { stopped = true; };
    const tick = () => {
      if (stopped) return;
      requestAnimationFrame(tick);
      const diagnostic = host.__replayDiagnostics;
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="paired-canvas"]');
      const snapshot = diagnostic?.snapshot();
      if (!diagnostic || !canvas || !snapshot || busy) return;
      const box = canvas.getBoundingClientRect();
      const key = JSON.stringify([snapshot.session_id, snapshot.capture_id, box.x, box.y, box.width, box.height]);
      if (key === previous) return;
      previous = key;
      const expected = document.createElement('canvas');
      expected.width = canvas.width;
      expected.height = canvas.height;
      const ctx = expected.getContext('2d')!;
      const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = '#f3f6fa';
      ctx.fillRect(0, 0, expected.width, expected.height);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'right';
      ctx.font = `14px ${mono}`;
      ctx.fillStyle = '#356fad';
      ctx.fillText(`CAPTURE ${snapshot.capture_id} / EPOCH ${snapshot.playback_epoch} / CONTROL ${snapshot.control_seq}`, 1584, 30);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(16, 488, 768, 42);
      ctx.font = `15px ${mono}`;
      ctx.fillStyle = '#18304e';
      ctx.textAlign = 'left';
      ctx.fillText(`LOG TIME  ${snapshot.log_time_s.toFixed(3)} / ${snapshot.duration_s.toFixed(3)} s`, 20, 506);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#356fad';
      ctx.fillText(`${(snapshot.progress * 100).toFixed(1)}% / ${snapshot.state} / ${snapshot.speed}x`, 780, 506);
      ctx.textAlign = 'left';
      ctx.font = `13px ${mono}`;
      ctx.fillStyle = '#60748c';
      ctx.fillText(`Wheel source rad: ${[1, 3, 5].map(index => snapshot.source_joints[index]!.toFixed(3)).join(' / ')} (unwrapped)`, 390, 30);
      const regions = [
        { name: 'capture_epoch_control', x: 1000, y: 14, width: 584, height: 20 },
        { name: 'log_time', x: 20, y: 488, width: 450, height: 21 },
        { name: 'progress_state_speed', x: 500, y: 488, width: 280, height: 21 },
        { name: 'source_wheel_angles', x: 390, y: 16, width: 600, height: 18 },
      ];
      for (const index of [0, 1, 17, 25, 26, 27]) {
        const [x, top, offset, width] = index < 6 ? [1192, 320, index, 392] : index < 10 ? [800, 320, index - 6, 384] : index < 19 ? [800, 48, index - 10, 384] : [1192, 48, index - 19, 392];
        const y = top + 67 + offset * 21;
        ctx.fillStyle = offset % 2 === 0 ? '#f5f8fc' : '#ffffff';
        ctx.fillRect(x + 1, y - 16, width - 2, 21);
        const quality = snapshot.quality[index]!;
        const unavailable = !quality.valid || quality.origin === 'missing';
        ctx.fillStyle = unavailable ? '#75859a' : '#18304e';
        ctx.textAlign = 'right'; ctx.font = `16px ${mono}`;
        const value = snapshot.joints[index]!;
        ctx.fillText(unavailable ? '—' : Math.abs(value) >= 10000 ? value.toExponential(1) : value.toFixed(3), x + 177, y);
        regions.push({ name: `joint_${index}`, x: x + 100, y: y - 16, width: 79, height: 19 });
      }
      const entry = {
        kind: 'capture', wall_ms: Date.now(), performance_ms: performance.now(), snapshot,
        canvas: { x: box.x, y: box.y, width: box.width, height: box.height,
          intrinsicWidth: canvas.width, intrinsicHeight: canvas.height },
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        layout: diagnostic.layout(), regions, png: expected.toDataURL('image/png'),
      };
      busy = true;
      void host.__recordingEvidence(entry).catch(error => {
        host.__recordingEvidenceErrors!.push(String(error));
      }).finally(() => { busy = false; });
    };
    requestAnimationFrame(tick);
  });
  return {
    async start() {
      if (startBoundary) throw new Error('Recording active window already started');
      startBoundary = await boundary();
      return startBoundary;
    },
    async end() {
      if (!startBoundary || endBoundary) throw new Error('Recording active window must start once and end once');
      endBoundary = await boundary();
      const activeWindow = join(output, 'active-window.json');
      await writeFile(activeWindow, JSON.stringify({ schema: 'recording-active-window/v1',
        policy: 'Predeclared 250ms boundary candidates; earliest readable start anchor through latest readable end anchor, every inclusive video frame',
        intended_duration_s: 10, minimum_duration_s: 8,
        start: startBoundary, end: endBoundary,
      }, null, 2));
      return { activeWindow, start: startBoundary, end: endBoundary };
    },
    async stop() {
      let browserErrors: string[] = [];
      if (!page.isClosed()) browserErrors = await page.evaluate(() => {
        const host = window as unknown as { __stopRecordingEvidence?: () => void; __recordingEvidenceErrors?: string[] };
        host.__stopRecordingEvidence?.();
        return host.__recordingEvidenceErrors ?? [];
      });
      await Promise.all([...pending]);
      const manifest = join(output, 'recording-manifest.json');
      await writeFile(manifest, JSON.stringify({ schema: 'recording-evidence/v1', startedWallMs,
        stoppedWallMs: Date.now(), referenceCount: count, browserErrors,
        scope: 'Independent expected text templates per observed capture; video analyzer reports any missed IDs as coverage gaps',
      }, null, 2));
      return { manifest, observations, referenceCount: count, browserErrors };
    },
  };
}
