import { afterEach, expect, it, vi } from 'vitest';
import { createWhepVideoSource } from '../../src/media/whep';
import { example } from '../api/fixtures';
import type { VideoInfo } from '../../src/domain/types';
import { catalog, UUID } from './realFixtures';

function video(): VideoInfo {
  return { ...example('service/ws_connection_snapshot').data.video, publishing: true, whep_url: 'http://127.0.0.1:6189/s/whep', sei_uuid_hex: UUID };
}
function setup(fetcher?: typeof fetch) {
  const peers: any[] = [], workers: any[] = [], frames: any[] = [], statuses: string[] = [];
  const fetch = fetcher ?? vi.fn(async (_url, init) => new Response(init?.method === 'POST' ? 'answer' : null,
    { status: init?.method === 'POST' ? 201 : 204, headers: { Location: '/s/whep/resource' } }));
  const source = createWhepVideoSource({ fetch, supported: () => true,
    createPeer: () => {
      const receiver = { createEncodedStreams: () => ({ readable: {}, writable: {} }) };
      const peer = { iceGatheringState: 'complete', connectionState: 'new', localDescription: { sdp: 'offer' },
        addTransceiver: () => ({ receiver }), createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
        setLocalDescription: async () => {}, setRemoteDescription: vi.fn(async () => {}), close: vi.fn(), getReceivers: () => [],
        addEventListener: vi.fn(), removeEventListener: vi.fn(), onconnectionstatechange: null, ontrack: null };
      peers.push(peer); return peer as unknown as RTCPeerConnection;
    },
    createWorker: () => {
      const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
      workers.push(worker); return worker as unknown as Worker;
    },
  });
  const connect = (info = video(), sid = catalog().session_id) => source.connect(sid, frame => frames.push(frame), status => statuses.push(status), info);
  return { source, connect, peers, workers, frames, statuses, fetch };
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it('waits for publishing and treats repeated endpoint snapshots as an update, not a new PC', async () => {
  const run = setup(); run.connect({ ...video(), publishing: false }); expect(run.peers).toHaveLength(0);
  run.connect(); await settle(); run.connect({ ...video(), render_fps: 19.5 }); await settle();
  expect(run.peers).toHaveLength(1); expect(run.peers[0].setRemoteDescription).toHaveBeenCalledOnce();
  run.source.disconnect(); await settle();
  expect(run.peers[0].close).toHaveBeenCalledOnce(); expect(run.workers[0].terminate).toHaveBeenCalledOnce();
  expect(run.fetch).toHaveBeenLastCalledWith('http://127.0.0.1:6189/s/whep/resource', expect.objectContaining({ method: 'DELETE' }));
});
it('deletes a late POST resource after cancellation instead of attaching it to a new session', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn((_: unknown, init?: RequestInit) => init?.method === 'POST' ? new Promise<Response>(r => { resolve = r; }) : Promise.resolve(new Response(null, { status: 204 })));
  const run = setup(fetch); run.connect(); await settle(); run.source.disconnect();
  resolve(new Response('answer', { status: 201, headers: { Location: '/s/whep/late' } })); await settle();
  expect(run.peers[0].setRemoteDescription).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenLastCalledWith('http://127.0.0.1:6189/s/whep/late', expect.objectContaining({ method: 'DELETE' }));
});
it('closes owned frames and late retired-worker messages, releasing each frame once', async () => {
  const run = setup(); run.connect(); await settle();
  const frame = { displayWidth: 1280, displayHeight: 720, close: vi.fn() };
  const late = run.workers[0].onmessage;
  late({ data: { type: 'pair', id: 1, frame, snapshot: catalog().snapshots[0], markerPixels: catalog().marker_pixels } });
  expect(run.frames).toHaveLength(1); expect(run.source.diagnostics().owned).toBe(1);
  run.source.disconnect(); run.frames[0].close(); expect(frame.close).toHaveBeenCalledOnce();
  const retired = { ...frame, close: vi.fn() };
  late({ data: { type: 'pair', id: 2, frame: retired, snapshot: catalog().snapshots[0] } });
  expect(retired.close).toHaveBeenCalledOnce(); expect(run.frames).toHaveLength(1);
});
it('rejects a foreign resource location and bounds repeated connection failures', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response('answer', { status: 201, headers: { Location: 'https://foreign.example/resource' } }));
  const run = setup(fetch); run.connect(); await settle();
  for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(10000); await settle(); }
  expect(run.peers.length).toBeLessThanOrEqual(6);
  expect(run.peers.every(peer => peer.close.mock.calls.length === 1)).toBe(true);
  expect(fetch.mock.calls.every(call => String(call[0]).startsWith('http://127.0.0.1:6189/'))).toBe(true);
  run.source.disconnect();
});
it('reports unsupported capabilities without acquiring or inventing media', () => {
  const source = createWhepVideoSource({ supported: () => false }); const status = vi.fn(), frame = vi.fn();
  source.connect('s', frame, status, video());
  expect(status).toHaveBeenCalledWith(expect.stringContaining('不支持'));
  expect(frame).not.toHaveBeenCalled(); expect(source.diagnostics().owned).toBe(0); source.disconnect();
});
