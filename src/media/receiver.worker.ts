import { DecoderPipeline } from './decoder';

interface Streams { readable: ReadableStream<RTCEncodedVideoFrame>; writable: WritableStream<RTCEncodedVideoFrame> }
interface Configuration { sessionId: string; uuid: string }
const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onrtctransform: ((event: { transformer: Streams & { options: Configuration } }) => void) | null;
};
let pipeline: DecoderPipeline | null = null;
let lastErrorAt = -Infinity;
function reportError(message: string) {
  if (performance.now() - lastErrorAt < 1000) return;
  lastErrorAt = performance.now(); scope.postMessage({ type: 'error', message });
}
async function start(streams: Streams, config: Configuration) {
  if (pipeline) throw new Error('Media transform already attached');
  const current = pipeline = new DecoderPipeline({ ...config,
    onPair: pair => scope.postMessage({ type: 'pair', ...pair }, [pair.frame]), onError: reportError,
  });
  const timer = setInterval(() => scope.postMessage({ type: 'stats', ...current.diagnostics() }), 500);
  try {
    await streams.readable.pipeThrough(new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
      transform(frame, controller) { current.push(new Uint8Array(frame.data)); controller.enqueue(frame); },
    })).pipeTo(streams.writable);
  } catch (error) { reportError(String(error)); }
  finally { clearInterval(timer); current.close(); }
}
scope.onrtctransform = event => { void start(event.transformer, event.transformer.options).catch(error => reportError(String(error))); };
scope.onmessage = event => {
  if (event.data.type === 'release') pipeline?.release(event.data.id);
  else if (event.data.type === 'streams') void start(event.data, event.data.config).catch(error => reportError(String(error)));
};
