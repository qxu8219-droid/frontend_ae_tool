import {
  createApiClient,
  ApiError,
  type ApiClient,
  type UploadOptions,
} from "../api/client";
import { SessionSocket, type SessionSocketOptions } from "../api/socket";
import type {
  FrameSnapshot,
  Schema,
  ScenarioId,
  WsServerMessage,
  PlaybackSnapshot,
} from "../domain/types";
import { FrameSynchronizer } from "../media/frameSync";
import { useVideoSource } from "../composables/useVideoSource";
import {
  drawEmptyPresentation,
  drawPresentation,
  PRESENTATION_IMAGE_RECT,
} from "../media/renderer";
import { MARKER_PIXELS, SOURCE_WIDTH, SOURCE_HEIGHT } from "../media/stamp";
import type { VideoSource } from "../media/types";
import { useSessionStore } from "../stores/session";
import { usePlaybackStore } from "../stores/playback";
import { useTelemetryStore } from "../stores/telemetry";
import { useUiStore } from "../stores/ui";
import { createSeekScheduler } from "./timeline";
import { createHistoryLoader } from "./history";
import { useHistoryStore } from "../stores/history";
import { createAnnotationLoader } from "./annotations";
import { useAnnotationStore } from "../stores/annotations";
import { createBrowserOwnedSession } from './ownedSession';

export interface MockBridge {
  setScenario(id: ScenarioId): void;
  getScenario(): ScenarioId;
  subscribeFrames(
    sid: string,
    listener: (frame: FrameSnapshot) => void,
  ): () => void;
}
type SocketHandle = Pick<
  SessionSocket,
  "connect" | "disconnect" | "ping" | "setTelemetryRate"
>;
type Bodies = {
  play: Schema["PlayRequest"];
  pause: Schema["ControlRequest"];
  stop: Schema["ControlRequest"];
  load: Schema["LoadRequest"];
  seek: Schema["SeekRequest"];
  step: Schema["StepRequest"];
  speed: Schema["SpeedRequest"];
};

export function createWorkbenchController(options: {
  runtime?: MockBridge;
  getCanvas: () => HTMLCanvasElement | null;
  api?: ApiClient;
  socketFactory?: (options: SessionSocketOptions) => SocketHandle;
  source?: VideoSource;
  getPresentation?: () => NonNullable<Parameters<typeof drawPresentation>[4]>;
}) {
  const session = useSessionStore(),
    playback = usePlaybackStore(),
    telemetry = useTelemetryStore(),
    ui = useUiStore();
  const api =
    options.api ??
    createApiClient(import.meta.env.VITE_API_BASE_URL || "/api/v1");
  const ownership = options.runtime ? null : createBrowserOwnedSession(import.meta.env.VITE_API_BASE_URL || '/api/v1');
  if (ownership?.recoverySid) ui.cleanupSessionId = ownership.recoverySid;
  const media = options.source ?? useVideoSource(options.runtime);
  const history = useHistoryStore(),
    historyLoader = createHistoryLoader(api);
  const annotations = useAnnotationStore(), annotationLoader = createAnnotationLoader(api);
  const configuredLimit = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES);
  const maxUploadBytes = options.runtime
    ? 1024 * 1024
    : Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 64 * 1024 * 1024;
  let lifecycle = 0,
    requests = new AbortController(),
    queue: Promise<unknown> = Promise.resolve(),
    disposed = false;
  let controlIntent = 0, settledIntent = 0, socketRestored = false, mediaStalled = false, fatal = false;
  let mediaTransportStalled = false;
  let presentedLayout: { sourceWidth: number; sourceHeight: number; markerPixels: ReadonlyArray<readonly [number, number]> } | null = null;
  const pendingAlerts: Array<
    Extract<WsServerMessage, { type: "alert" }>["data"]
  > = [];
  const seenAlerts = new Set<string>();
  const sync = new FrameSynchronizer({
    onPresent: (image, snapshot) => {
      const canvas = options.getCanvas();
      if (!canvas || !telemetry.canAccept(snapshot, session.socket.generation))
        return false;
      drawPresentation(
        canvas,
        image,
        snapshot,
        session.jointMeta,
        { ...options.getPresentation?.(), realMedia: media.capabilities.kind === 'whep' },
      );
      presentedLayout = { sourceWidth: image.width, sourceHeight: image.height, markerPixels: image.markerPixels ?? MARKER_PIXELS };
      telemetry.accept(snapshot, session.socket.generation);
      session.syncState = 'paired';
      history.present(snapshot);
      for (let i = pendingAlerts.length - 1; i >= 0; i--) {
        const alert = pendingAlerts[i];
        if (
          alert.log_id === snapshot.log_id &&
          alert.playback_epoch === snapshot.playback_epoch &&
          alert.log_time_s! <= snapshot.log_time_s
        ) {
          ui.log(alert.message);
          pendingAlerts.splice(i, 1);
        }
      }
      return true;
    },
  });
  function updateHold() {
    session.waitingForControl = controlIntent > settledIntent;
    sync.setSuspended(session.waitingForControl || !socketRestored || mediaStalled || mediaTransportStalled || fatal);
  }
  function barrier(value: PlaybackSnapshot) {
    if (value.log_id && (annotations.logId !== value.log_id || annotations.sessionId !== value.session_id)) {
      void annotationLoader.load(value.session_id, value.log_id);
    } else if (!value.log_id) {
      annotationLoader.cancel(); annotations.reset();
    }
    sync.setBarrier(
      value.control_seq,
      value.playback_epoch,
      value.log_id ?? undefined,
    );
    for (let i = pendingAlerts.length - 1; i >= 0; i--)
      if (pendingAlerts[i].log_id !== value.log_id || pendingAlerts[i].playback_epoch !== value.playback_epoch) pendingAlerts.splice(i, 1);
    if (
      value.log_id &&
      (history.logId !== value.log_id || history.sessionId !== value.session_id)
    ) {
      seekScheduler.cancel();
      void historyLoader.load(
        value.session_id,
        value.log_id,
        value.duration_s ?? 0,
      );
    } else if (!value.log_id) {
      seekScheduler.cancel();
      historyLoader.cancel();
      history.reset();
    }
  }
  function empty(message = "创建会话并载入日志，开始同步回放") {
    const canvas = options.getCanvas();
    if (canvas) drawEmptyPresentation(canvas, message);
  }
  function report(error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    const prefix = error instanceof ApiError ? `${error.code} · ` : "";
    ui.error =
      prefix + (error instanceof Error ? error.message : String(error));
    ui.log(ui.error);
  }
  async function action(work: () => Promise<void>, ticket = lifecycle) {
    ui.busy++;
    ui.error = null;
    try {
      await work();
    } catch (error) {
      if (ticket === lifecycle && !disposed) report(error);
    } finally {
      ui.busy--;
    }
  }
  function receive(message: WsServerMessage, generation: number) {
    if (
      disposed ||
      message.session_id !== session.sid ||
      generation !== session.socket.generation
    )
      return;
    switch (message.type) {
      case "connection_snapshot": {
        session.jointMeta = message.data.joint_meta;
        session.workerPhase = message.data.worker.phase;
        socketRestored = true;
        fatal ||= message.data.worker.phase === 'error' || message.data.worker.phase === 'stopped';
        mediaStalled = message.data.sync.state === 'stalled';
        session.syncState = message.data.sync.state;
        if (playback.update(message.data.playback))
          barrier(message.data.playback);
        updateHold();
        if (fatal || mediaStalled) {
          media.disconnect(); ui.mediaStatus = '视频或 Worker 暂不可用，画面和数据共同保持'; break;
        }
        const ticket = lifecycle, connectionGeneration = generation;
        media.connect(
          message.session_id,
          (frame) => {
            if (disposed || ticket !== lifecycle || connectionGeneration !== session.socket.generation || frame.sessionId !== session.sid) {
              frame.close(); return;
            }
            if (media.capabilities.kind === 'whep') {
              if (!frame.snapshot) { frame.close(); return; }
            }
            sync.addFrame(frame);
          },
          (status, state) => {
            if (ticket !== lifecycle || connectionGeneration !== session.socket.generation || disposed) return;
            ui.mediaStatus = status;
            if (media.capabilities.kind === 'whep' && state) {
              mediaTransportStalled = state === 'waiting'; updateHold();
            }
          },
          message.data.video,
        );
        ui.log("连接已恢复，等待匹配画面");
        break;
      }
      case "playback_state":
        if (!playback.update(message.data.playback)) break;
        barrier(message.data.playback);
        if (message.data.playback.log_id === null) {
          sync.reset(message.session_id, generation);
          barrier(message.data.playback);
          telemetry.context("", generation);
          telemetry.context(message.session_id, generation);
          empty("当前没有已激活的日志");
        }
        break;
      case "frame_snapshot":
        // Real frames carry the snapshot selected from their own SEI catalog.
        // A supplemental WS pose must never replace that evidence.
        if (media.capabilities.kind !== 'whep') sync.addSnapshot(message.data);
        break;
      case "system":
        if (message.data.worker)
          session.workerPhase = message.data.worker.phase;
        if (
          message.data.event === "worker_exited" ||
          message.data.event === "session_error" ||
          message.data.worker?.phase === "error"
        ) {
          fatal = true; session.syncState = 'stalled'; updateHold();
          media.disconnect();
          ui.mediaStatus = "Worker 已停止，画面和数据共同保持";
          ui.error = "Worker 故障，请关闭会话并重新创建，再从日志起点加载。";
          ui.log(ui.error);
        } else if (message.data.event === 'mediamtx_unreachable') {
          mediaStalled = true; session.syncState = 'stalled'; updateHold(); media.disconnect();
          ui.mediaStatus = '媒体连接中断，画面和数据共同保持';
        } else if (message.data.message) ui.log(message.data.message);
        break;
      case "alert": {
        const alert = message.data,
          key = `${alert.log_id ?? "system"}:${alert.alert_id}`;
        history.ingestAlert(alert);
        if (seenAlerts.has(key)) break;
        seenAlerts.add(key);
        if (seenAlerts.size > 200)
          seenAlerts.delete(seenAlerts.values().next().value!);
        if (alert.log_time_s == null) ui.log(alert.message);
        else {
          pendingAlerts.push(alert);
          if (pendingAlerts.length > 100) pendingAlerts.shift();
        }
        break;
      }
      case "health_telemetry":
        session.health = message.data;
        session.healthWallTime = message.wall_time * 1000;
        break;
    }
  }
  const socket = (
    options.socketFactory ?? ((settings) => new SessionSocket(settings))
  )({
    baseUrl: import.meta.env.VITE_API_BASE_URL || "/api/v1",
    onMessage: receive,
    onStatus(status) {
      if (disposed) return;
      const changed = status.generation !== session.socket.generation;
      session.socket = status;
      if (changed) {
        socketRestored = status.state === 'open';
        media.disconnect();
        sync.reset(session.sid ?? "", status.generation);
        telemetry.context(session.sid ?? "", status.generation);
        annotationLoader.cancel();
        if (playback.server?.log_id) void annotationLoader.load(playback.server.session_id, playback.server.log_id);
        if (playback.server) barrier(playback.server);
      }
      if (status.state === 'open') socketRestored = true;
      updateHold();
      if (status.state === "reconnecting" || status.state === "error")
        ui.mediaStatus = "连接重建中，画面和数据共同保持";
    },
  });

  const controls = {
    play: (sid: string, body: Bodies["play"]) =>
      api.play(sid, body, { signal: requests.signal }),
    pause: (sid: string, body: Bodies["pause"]) =>
      api.pause(sid, body, { signal: requests.signal }),
    stop: (sid: string, body: Bodies["stop"]) =>
      api.stop(sid, body, { signal: requests.signal }),
    load: (sid: string, body: Bodies["load"]) =>
      api.load(sid, body, { signal: requests.signal }),
    seek: (sid: string, body: Bodies["seek"]) =>
      api.seek(sid, body, { signal: requests.signal }),
    step: (sid: string, body: Bodies["step"]) =>
      api.step(sid, body, { signal: requests.signal }),
    speed: (sid: string, body: Bodies["speed"]) =>
      api.speed(sid, body, { signal: requests.signal }),
  };
  const seekScheduler = createSeekScheduler(
    (time) => enqueueControl("seek", { time_s: time }),
    { delayMs: 0, deduplicate: false },
  );
  function seek(time: number) {
    if (disposed || !session.sid || !Number.isFinite(time) || time < 0) return;
    controlIntent++; updateHold();
    seekScheduler.request(time);
    seekScheduler.flush();
  }
  function control<K extends keyof Bodies>(
    name: K,
    body: Bodies[K] = {} as Bodies[K],
  ): Promise<void> {
    ++ui.intentRevision;
    seekScheduler.cancel();
    return enqueueControl(name, body);
  }
  function enqueueControl<K extends keyof Bodies>(
    name: K,
    body: Bodies[K],
  ): Promise<void> {
    const sid = session.sid,
      ticket = lifecycle;
    if (!sid || disposed) return Promise.resolve();
    const intent = ++controlIntent; updateHold();
    const result = queue.then(async () => {
      if (!sid || ticket !== lifecycle || disposed) return;
      await action(async () => {
        const ack = await (
          controls[name] as (
            sid: string,
            b: Bodies[K],
          ) => ReturnType<ApiClient["play"]>
        )(sid, body);
        if (ticket !== lifecycle || sid !== session.sid) return;
        if (playback.update(ack.playback)) barrier(ack.playback);
      }, ticket);
      if (ticket === lifecycle && intent === controlIntent) { settledIntent = intent; updateHold(); }
    });
    queue = result.catch(() => {});
    return result;
  }
  async function initialize() {
    await action(async () => {
      const ticket = lifecycle;
      let recoveryError: unknown;
      const recoverSid = ownership?.recoverySid;
      if (recoverSid && ui.cleanupSessionId === recoverSid) {
        try {
          await deleteTrackedSession(recoverSid);
          if (ui.cleanupSessionId === recoverSid) ui.cleanupSessionId = null;
          ui.log('刷新前的会话已清理，请重新创建并从头载入日志');
        } catch (error) { recoveryError = error; }
      }
      if (ticket !== lifecycle || disposed) return;
      const [scenes, robots] = await Promise.all([
          api.scenes({ signal: requests.signal }),
          api.robots({ signal: requests.signal }),
        ]);
      if (ticket !== lifecycle || disposed) return;
      session.scenes = scenes.scenes;
      session.robots = robots.robots;
      session.sceneId = scenes.scenes[0]?.id ?? "";
      session.robotId = robots.robots[0]?.id ?? "";
      if (session.robotId) {
        const meta = await api.joints(session.robotId, {
          signal: requests.signal,
        });
        if (ticket === lifecycle && !disposed) session.jointMeta = meta;
      }
      if (recoveryError && ui.cleanupSessionId === recoverSid)
        throw new Error(`刷新前的会话尚未清理，请点击“重试关闭”后重新创建：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    });
  }
  async function deleteTrackedSession(sid: string) {
    try { await api.deleteSession(sid); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    ownership?.release(sid);
  }
  async function create() {
    if (disposed || ui.creating || session.sid || ui.cleanupSessionId) return;
    const ticket = ++lifecycle;
    ui.creating = true;
    try {
      await action(async () => {
        // Let creation return its ID even if locally cancelled, then delete that
        // resource. Aborting before the response would lose the server's new ID.
        const result = await api.createSession({
          scene_id: session.sceneId,
          robot_id: session.robotId,
          isaacsim_version: "6.2.0",
          physics_engine: "physx",
          mode: "kinematic",
        });
        if (ticket !== lifecycle || disposed) {
          ui.cleanupSessionId = result.session_id;
          try {
            await deleteTrackedSession(result.session_id);
            if (ui.cleanupSessionId === result.session_id)
              ui.cleanupSessionId = null;
          } catch (error) {
            if (!disposed) report(error);
          }
          return;
        }
        // A cancelled response may arrive after a newer create has succeeded.
        // Only the live creation may replace this document's ownership receipt.
        try { ownership?.remember(result.session_id); }
        catch (error) {
          ui.cleanupSessionId = result.session_id;
          try {
            await deleteTrackedSession(result.session_id);
            if (ui.cleanupSessionId === result.session_id) ui.cleanupSessionId = null;
          } catch { /* Retain the in-memory handle so Close can retry. */ }
          throw error;
        }
        session.sid = result.session_id;
        session.workerPhase = "booting";
        playback.reset();
        telemetry.context(result.session_id, session.socket.generation);
        socket.connect(result.session_id);
        ui.log("会话已创建，正在准备回放环境");
      }, ticket);
    } finally {
      if (ticket === lifecycle) ui.creating = false;
    }
  }
  async function close() {
    ++lifecycle;
    ui.creating = false;
    requests.abort();
    seekScheduler.cancel();
    historyLoader.cancel();
    history.reset();
    annotationLoader.cancel();
    annotations.reset();
    queue = Promise.resolve();
    requests = new AbortController();
    controlIntent = settledIntent = 0; socketRestored = false; mediaStalled = mediaTransportStalled = fatal = false; presentedLayout = null;
    media.disconnect();
    socket.disconnect();
    sync.dispose();
    const sid = session.sid ?? ui.cleanupSessionId;
    ui.cleanupSessionId = sid;
    session.reset();
    playback.reset();
    telemetry.context("", session.socket.generation);
    pendingAlerts.length = 0;
    seenAlerts.clear();
    ui.uploadIssues = [];
    ui.uploading = false;
    ui.mediaStatus = "等待会话";
    empty();
    await action(async () => {
      if (sid) await deleteTrackedSession(sid);
      if (ui.cleanupSessionId === sid) ui.cleanupSessionId = null;
    });
  }
  async function loadFile(file: File, options: UploadOptions = {}) {
    const sid = session.sid,
      ticket = lifecycle;
    if (!sid || disposed || ui.uploading) return null;
    if (file.size > maxUploadBytes) {
      ui.error = `上传上限为 ${(maxUploadBytes / 1024 / 1024).toFixed(0)} MiB。`;
      return null;
    }
    let uploaded: Schema["UploadResult"] | null = null;
    playback.uploaded = null;
    ui.uploadIssues = [];
    ui.uploading = true;
    await action(async () => {
      let result: Schema["UploadResult"];
      try {
        result = await api.upload(sid, file, {
          ...options,
          signal: requests.signal,
        });
      } catch (error) {
        if (
          ticket === lifecycle &&
          error instanceof ApiError &&
          Array.isArray(error.details.issues)
        ) {
          ui.uploadIssues = error.details.issues.filter(
            (issue): issue is Schema["ParseIssue"] =>
              !!issue &&
              typeof issue === "object" &&
              !Array.isArray(issue) &&
              typeof issue.code === "string" &&
              typeof issue.message === "string" &&
              ["info", "warning", "error"].includes(String(issue.severity)),
          ) as Schema["ParseIssue"][];
        }
        throw error;
      }
      if (ticket !== lifecycle || session.sid !== sid) return;
      playback.uploaded = result;
      uploaded = result;
      ui.uploadIssues = result.issues;
      ui.log("上传结果已就绪，请核对映射与质量后激活日志");
    }, ticket);
    if (ticket === lifecycle) ui.uploading = false;
    return uploaded as Schema["UploadResult"] | null;
  }
  const loadDemo = async () => {
    const ticket = lifecycle;
    const result = await loadFile(
      new File(
        [
          JSON.stringify({
            mock: true,
            duration_s: 12,
            description: "Synthetic demonstration, not a real robot log",
          }),
        ],
        "synthetic-demo.json",
        { type: "application/json" },
      ),
    );
    if (result && ticket === lifecycle)
      await control("load", { log_id: result.log_id });
  };
  function setScenario(value: ScenarioId) {
    ui.scenario = value;
    if (session.workerPhase !== "error") ui.error = null;
    options.runtime?.setScenario(value);
    ui.log(`演示场景已切换：${value}`);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    ownership?.dispose();
    ++lifecycle;
    requests.abort();
    seekScheduler.dispose();
    historyLoader.cancel();
    history.reset();
    annotationLoader.cancel();
    annotations.reset();
    media.disconnect();
    socket.disconnect();
    sync.dispose();
    pendingAlerts.length = 0;
    seenAlerts.clear();
  }
  const diagnostics = Object.freeze({
    snapshot: () =>
      telemetry.presented ? structuredClone(telemetry.presented) : null,
    sync: () => sync.diagnostics(),
    session: () => ({
      sid: session.sid,
      workerPhase: session.workerPhase,
      wsGeneration: session.socket.generation,
      wsState: session.socket.state,
      mode: options.runtime ? "mock" : "real",
    }),
    layout: () => ({
      sourceWidth: presentedLayout?.sourceWidth ?? SOURCE_WIDTH,
      sourceHeight: presentedLayout?.sourceHeight ?? SOURCE_HEIGHT,
      markerPixels: (presentedLayout?.markerPixels ?? MARKER_PIXELS).map((pixel) => [pixel[0], pixel[1]] as const),
      imageRect: PRESENTATION_IMAGE_RECT,
    }),
    source: () =>
      "diagnostics" in media
        ? (media as VideoSource & { diagnostics: () => unknown }).diagnostics()
        : { inFlight: 0, pending: 0, owned: 0 },
  });
  return {
    initialize,
    create,
    close,
    control,
    seek,
    loadFile,
    loadDemo,
    setScenario,
    dispose,
    diagnostics,
    empty,
    maxUploadBytes,
  };
}
