import type { VideoInfo } from '../domain/types';
import type { DecodedFrame, VideoSource, MediaState } from './types';
import type { DecodedPair } from './decoder';

type Receiver = RTCRtpReceiver & { createEncodedStreams?(): { readable: ReadableStream; writable: WritableStream } };
interface Desired {
  key: string; sid: string; video: VideoInfo;
  onFrame: (frame: DecodedFrame) => void; onStatus?: (status: string, state?: MediaState) => void;
}
interface Connection {
  peer: RTCPeerConnection | null; worker: Worker | null; abort: AbortController;
  resource: string | null; closed: boolean; sink: HTMLVideoElement | null;
  firstFrame?: boolean;
}
function iceReady(peer: RTCPeerConnection, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new Error('Media connection retired'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('ICE gathering timed out')), 5000);
    const changed = () => { if (peer.iceGatheringState === 'complete') finish(); };
    const aborted = () => finish(new Error('Media connection retired'));
    function finish(error?: Error) {
      clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    }
    peer.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Owns real media only. Metadata refresh is idempotent; retirement fences every callback. */
export function createWhepVideoSource(dependencies: {
  fetch?: typeof fetch; supported?: () => boolean;
  createPeer?: (config: RTCConfiguration) => RTCPeerConnection; createWorker?: () => Worker;
} = {}): VideoSource & { diagnostics(): Record<string, unknown> } {
  const request = dependencies.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const supported = dependencies.supported ?? (() => typeof VideoDecoder === 'function' && typeof OffscreenCanvas === 'function' &&
    typeof Worker === 'function' && typeof RTCPeerConnection === 'function' &&
    (typeof RTCRtpScriptTransform === 'function' || typeof (RTCRtpReceiver.prototype as Receiver).createEncodedStreams === 'function'));
  let desired: Desired | null = null, active: Connection | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null, attempts = 0, generation = 0, cleanupPending = 0, cleanupFailures = 0;
  let stats: Record<string, unknown> = {}, lastLayout: Record<string, unknown> | null = null;
  const owned = new Set<DecodedFrame>();
  function releaseResource(url: string) {
    cleanupPending++;
    void request(url, { method: 'DELETE', signal: AbortSignal.timeout(3000), redirect: 'error', credentials: 'omit' })
      .then(response => { if (!response.ok && response.status !== 404) cleanupFailures++; })
      .catch(() => { cleanupFailures++; }).finally(() => { cleanupPending--; });
  }
  function retire(connection: Connection) {
    if (connection.closed) return;
    connection.closed = true; connection.abort.abort();
    for (const frame of owned) frame.close(); owned.clear();
    connection.worker?.terminate();
    if (connection.resource) { releaseResource(connection.resource); connection.resource = null; }
    if (connection.sink) { connection.sink.pause(); connection.sink.srcObject = null; connection.sink = null; }
    for (const receiver of connection.peer?.getReceivers() ?? []) receiver.track?.stop();
    connection.peer?.close();
  }
  function disconnect() {
    desired = null; generation++; attempts = 0;
    if (retry !== null) clearTimeout(retry); retry = null;
    const old = active; active = null; if (old) retire(old);
    stats = {}; lastLayout = null;
  }
  async function start(config: Desired) {
    if (desired !== config) return;
    const connection: Connection = { peer: null, worker: null, abort: new AbortController(), resource: null, closed: false, sink: null };
    active = connection; generation++;
    const current = () => active === connection && desired === config && !connection.closed;
    const fail = (error: unknown) => {
      if (!current()) return;
      active = null;
      // Let the consumer clear scheduled presentations before closing its frames.
      config.onStatus?.(`视频连接中断，画面和数据共同保持：${error instanceof Error ? error.message : String(error)}`, 'waiting');
      retire(connection);
      if (desired === config && attempts < 5) {
        const delay = Math.min(8000, 500 * 2 ** attempts++);
        retry = setTimeout(() => { retry = null; void start(config); }, delay);
      }
    };
    try {
      const endpoint = new URL(config.video.whep_url!, globalThis.location?.href ?? 'http://localhost/');
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid WHEP endpoint');
      const peer = connection.peer = (dependencies.createPeer ?? (options => new RTCPeerConnection(options)))({
        iceServers: config.video.ice_servers?.map(server => ({ urls: server.urls,
          ...(server.username ? { username: server.username } : {}), ...(server.credential ? { credential: server.credential } : {}) })) ?? [],
        encodedInsertableStreams: true,
      } as RTCConfiguration);
      const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
      if (typeof RTCRtpReceiver !== 'undefined' && transceiver.setCodecPreferences) {
        const h264 = RTCRtpReceiver.getCapabilities('video')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'video/h264');
        if (!h264?.length) throw new Error('H264 receiver unavailable');
        transceiver.setCodecPreferences(h264);
      }
      const worker = connection.worker = dependencies.createWorker?.() ?? new Worker(new URL('./receiver.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = event => {
        const message = event.data;
        if (!current()) { message.frame?.close(); return; }
        if (message.type === 'pair') {
          const pair = message as DecodedPair;
          if (pair.snapshot.session_id !== config.sid || owned.size >= 4) {
            pair.frame.close(); worker.postMessage({ type: 'release', id: pair.id }); return;
          }
          let closed = false;
          const managed: DecodedFrame = { sessionId: config.sid, captureId: pair.snapshot.capture_id, image: pair.frame,
            width: pair.frame.displayWidth, height: pair.frame.displayHeight, snapshot: pair.snapshot, markerPixels: pair.markerPixels,
            close() {
              if (closed) return; closed = true; owned.delete(managed); pair.frame.close();
              if (!connection.closed) worker.postMessage({ type: 'release', id: pair.id });
            },
          };
          owned.add(managed);
          lastLayout = { sourceWidth: managed.width, sourceHeight: managed.height, markerPixels: pair.markerPixels };
          try {
            if (!connection.firstFrame) {
              connection.firstFrame = true;
              attempts = 0;
              config.onStatus?.('真实视频已连接，图像与数据按同帧核验', 'ready');
            }
            if (current()) config.onFrame(managed); else managed.close();
          } catch (error) { managed.close(); fail(error); }
        } else if (message.type === 'stats') {
          stats = { packets: message.packets, dropped: message.dropped, mismatches: message.mismatches,
            pending: message.pending, inFlight: message.inFlight, codec: message.codec };
        } else if (message.type === 'error') config.onStatus?.(`等待可核验视频帧：${message.message}`);
      };
      worker.onerror = error => fail(new Error(error.message));
      const settings = { sessionId: config.sid, uuid: config.video.sei_uuid_hex! };
      if (typeof RTCRtpScriptTransform === 'function') transceiver.receiver.transform = new RTCRtpScriptTransform(worker, settings);
      else {
        const streams = (transceiver.receiver as Receiver).createEncodedStreams!();
        worker.postMessage({ type: 'streams', ...streams, config: settings }, [streams.readable, streams.writable]);
      }
      peer.ontrack = event => {
        if (!current()) { event.track.stop(); return; }
        const sink = connection.sink = document.createElement('video');
        sink.muted = true; sink.playsInline = true; sink.autoplay = true;
        sink.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void sink.play().catch(error => { if (current()) fail(error); });
      };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') fail(new Error(peer.connectionState));
        else if (peer.connectionState === 'connected') config.onStatus?.('真实视频已连接，等待图像与数据核验后共同呈现');
      };
      config.onStatus?.('正在连接真实 WHEP 视频', 'waiting');
      await peer.setLocalDescription(await peer.createOffer());
      await iceReady(peer, connection.abort.signal);
      if (!current()) return;
      // Keep this bounded POST alive on local cancellation so a late 201 resource
      // can be deleted. An abort before its Location arrives would lose ownership.
      const response = await request(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription!.sdp, signal: AbortSignal.timeout(8000), redirect: 'error', credentials: 'omit' });
      if (response.status !== 201) throw new Error(`WHEP HTTP ${response.status}`);
      const location = response.headers.get('Location');
      if (!location) throw new Error('WHEP resource Location missing');
      const resource = new URL(location, endpoint);
      if (resource.origin !== endpoint.origin || resource.username || resource.password) throw new Error('Unexpected WHEP resource origin');
      if (!current()) { releaseResource(resource.href); return; }
      connection.resource = resource.href;
      const answer = await response.text();
      if (!current()) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (error) { fail(error); }
  }
  return {
    capabilities: { kind: 'whep', identity: 'capture32_crc32', controllable: true },
    connect(sid, onFrame, onStatus, video) {
      if (!video?.publishing || !video.whep_url || !video.sei_uuid_hex) {
        onStatus?.('等待仿真发布视频', 'waiting'); disconnect(); return;
      }
      const key = JSON.stringify([sid, video.whep_url, video.sei_uuid_hex, video.ice_servers]);
      if (desired?.key === key) { desired.onFrame = onFrame; desired.onStatus = onStatus; return; }
      onStatus?.('正在准备真实视频连接，画面和数据共同保持', 'waiting');
      disconnect();
      if (!supported()) { onStatus?.('当前浏览器不支持所需的 WebCodecs / WebRTC 编码变换，无法呈现真实回放'); return; }
      desired = { key, sid, video, onFrame, onStatus }; void start(desired);
    },
    disconnect,
    diagnostics: () => ({ ...stats, kind: 'whep', generation, owned: owned.size, attempts, cleanupPending, cleanupFailures,
      active: active !== null, layout: lastLayout }),
  };
}
