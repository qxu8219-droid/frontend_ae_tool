import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createWorkbenchController } from '../../src/app/controller';
import { ApiError, type ApiClient } from '../../src/api/client';
import { useSessionStore } from '../../src/stores/session';
import { useUiStore } from '../../src/stores/ui';

const apiBase = 'http://localhost:5173/api/v1';
const key = 'replay.owned-session.v1:' + apiBase;
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(name: string) { return this.values.get(name) ?? null; }
  setItem(name: string, value: string) { this.values.set(name, value); }
  removeItem(name: string) { this.values.delete(name); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}
function browser(type: string, storage = new MemoryStorage()) {
  const target = Object.assign(new EventTarget(), { sessionStorage: storage,
    location: { href: 'http://localhost:5173/' }, performance: { getEntriesByType: () => [{ type }] } });
  vi.stubGlobal('window', target); return target;
}
function own(storage: Storage, sid = 'old') { storage.setItem(key, JSON.stringify({ version: 1, apiBase, sid })); }
const source = { capabilities: { kind: 'unavailable' as const, identity: 'capture32_crc32' as const, controllable: false }, connect() {}, disconnect() {} };
const socketFactory = () => ({ connect() {}, disconnect() {}, setTelemetryRate() {}, ping() {} });
function api(resources: Set<string>, remove?: (sid: string) => Promise<void>): ApiClient {
  return { scenes: async () => ({ scenes: [{ id: 'scene' }] }), robots: async () => ({ robots: [] }),
    createSession: async () => { resources.add('new'); return { session_id: 'new', status: 'starting', ws_url: '/ws' }; },
    deleteSession: async (sid: string) => { if (remove) await remove(sid); else resources.delete(sid); },
  } as unknown as ApiClient;
}
const controllers: ReturnType<typeof createWorkbenchController>[] = [];
function controller(client: ApiClient) {
  const result = createWorkbenchController({ api: client, source, socketFactory, getCanvas: () => null }); controllers.push(result); return result;
}
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('blocks new creation until refresh has actually deleted the previously owned session', async () => {
  const storage = new MemoryStorage(); own(storage); browser('reload', storage);
  const resources = new Set(['old']); let finish!: () => void;
  const c = controller(api(resources, sid => new Promise(resolve => { finish = () => { resources.delete(sid); resolve(); }; })));
  const initializing = c.initialize(); await c.create();
  expect(resources).toEqual(new Set(['old'])); expect(useUiStore().cleanupSessionId).toBe('old');
  finish(); await initializing;
  expect(resources.size).toBe(0); expect(storage.getItem(key)).toBeNull(); expect(useSessionStore().sid).toBeNull();
  await c.create(); expect(resources).toEqual(new Set(['new']));
  expect(JSON.parse(storage.getItem(key)!)).toEqual({ version: 1, apiBase, sid: 'new' });
});

it('retains the owned cleanup handle and blocks create after failure, then retries through Close', async () => {
  const storage = new MemoryStorage(); own(storage); browser('reload', storage);
  const resources = new Set(['old']); let offline = true;
  const c = controller(api(resources, async sid => { if (offline) throw new ApiError(0, 'NETWORK_ERROR', 'offline'); resources.delete(sid); }));
  await c.initialize(); await c.create();
  expect(resources).toEqual(new Set(['old'])); expect(useUiStore().cleanupSessionId).toBe('old');
  expect(useUiStore().error).toContain('刷新'); expect(storage.getItem(key)).not.toBeNull();
  offline = false; await c.close();
  expect(resources.size).toBe(0); expect(useUiStore().cleanupSessionId).toBeNull(); expect(storage.getItem(key)).toBeNull();
});

it('treats an already deleted owned SID as completed recovery', async () => {
  const storage = new MemoryStorage(); own(storage); browser('reload', storage);
  const c = controller(api(new Set(), async () => { throw new ApiError(404, 'NOT_FOUND', 'gone'); }));
  await c.initialize();
  expect(useUiStore().cleanupSessionId).toBeNull(); expect(useUiStore().error).toBeNull(); expect(storage.getItem(key)).toBeNull();
});

it.each(['navigate', 'back_forward'])('never deletes an inherited SID on %s, including a subsequent reload', async type => {
  const storage = new MemoryStorage(); own(storage); browser(type, storage);
  const resources = new Set(['old']); const first = controller(api(resources)); await first.initialize();
  expect(resources).toEqual(new Set(['old'])); expect(storage.getItem(key)).toBeNull();
  first.dispose(); setActivePinia(createPinia()); browser('reload', storage);
  await controller(api(resources)).initialize(); expect(resources).toEqual(new Set(['old']));
});

it('binds ownership to the configured API base and ignores another server record', async () => {
  const storage = new MemoryStorage(); own(storage); browser('reload', storage); vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:8001/api/v1');
  const resources = new Set(['old']); await controller(api(resources)).initialize();
  expect(resources).toEqual(new Set(['old'])); expect(storage.getItem(key)).not.toBeNull();
});

it.each(['{bad json', JSON.stringify({ version: 1, apiBase: 'http://other.invalid/api/v1', sid: 'old' }),
  JSON.stringify({ version: 1, apiBase, sid: '../foreign' })])('ignores an invalid receipt without deleting a remote session: %s', async raw => {
  const storage = new MemoryStorage(); storage.setItem(key, raw); browser('reload', storage);
  const resources = new Set(['old']); const c = controller(api(resources)); await c.initialize();
  expect(resources).toEqual(new Set(['old'])); await c.create();
  expect(useSessionStore().sid).toBe('new'); expect(resources).toEqual(new Set(['old', 'new']));
});

it('cleans a newly created session if the tab cannot persist its cleanup receipt', async () => {
  const storage = new MemoryStorage(); browser('navigate', storage);
  storage.setItem = () => { throw new Error('storage denied'); };
  const resources = new Set<string>(); const c = controller(api(resources)); await c.create();
  expect(resources.size).toBe(0); expect(useSessionStore().sid).toBeNull();
  expect(useUiStore().cleanupSessionId).toBeNull(); expect(useUiStore().error).toContain('storage denied');
});

it('pagehide only attempts keepalive deletion of this document owned SID and preserves reload retry evidence', async () => {
  const storage = new MemoryStorage(), target = browser('navigate', storage), calls: Array<[string, RequestInit]> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push([url, init]); throw new Error('unload network interrupted'); });
  const resources = new Set<string>(), c = controller(api(resources)); await c.create();
  target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true })); expect(calls).toEqual([]);
  target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false })); await Promise.resolve();
  expect(calls).toEqual([[apiBase + '/sessions/new', { method: 'DELETE', keepalive: true, headers: { Accept: 'application/json' } }]]);
  expect(storage.getItem(key)).not.toBeNull();
  await c.close(); expect(storage.getItem(key)).toBeNull();
  target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false })); expect(calls).toHaveLength(1);
});

it('does not invent an owned SID when a document reloads during an unresolved create request', async () => {
  const storage = new MemoryStorage(); browser('navigate', storage);
  let created!: (value: Awaited<ReturnType<ApiClient['createSession']>>) => void;
  const resources = new Set<string>(), client = api(resources);
  client.createSession = () => new Promise(resolve => { created = resolve; });
  const c = controller(client); const pending = c.create();
  expect(storage.getItem(key)).toBeNull(); c.dispose();
  resources.add('late'); created({ session_id: 'late', status: 'starting', ws_url: '/ws' }); await pending;
  expect(resources.size).toBe(0); expect(storage.getItem(key)).toBeNull();
});

it.each([false, true])('a late cancelled create never overwrites the newer owned receipt (stale cleanup fails: %s)', async cleanupFails => {
  const storage = new MemoryStorage(), target = browser('navigate', storage), unloads: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { unloads.push(url); return new Response(null, { status: 204 }); });
  const resources = new Set<string>(); let firstResolve!: (value: Awaited<ReturnType<ApiClient['createSession']>>) => void;
  const client = api(resources, async sid => {
    if (sid === 'late-A' && cleanupFails) throw new ApiError(503, 'CLEANUP_FAILED', 'late A cleanup failed');
    resources.delete(sid);
  });
  let creations = 0;
  client.createSession = async () => {
    if (++creations === 1) return new Promise(resolve => { firstResolve = resolve; });
    resources.add('new-B'); return { session_id: 'new-B', status: 'starting', ws_url: '/ws' };
  };
  const c = controller(client), first = c.create(); await c.close(); await c.create();
  resources.add('late-A'); firstResolve({ session_id: 'late-A', status: 'starting', ws_url: '/ws' }); await first;
  expect(useSessionStore().sid).toBe('new-B');
  expect(JSON.parse(storage.getItem(key)!)).toEqual({ version: 1, apiBase, sid: 'new-B' });
  target.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  expect(unloads).toEqual([apiBase + '/sessions/new-B']);
  expect(resources.has('new-B')).toBe(true); expect(resources.has('late-A')).toBe(cleanupFails);
});
