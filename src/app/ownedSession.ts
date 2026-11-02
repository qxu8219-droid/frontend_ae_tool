/** A tab-scoped cleanup receipt, never a list of arbitrary server sessions. */
export function createBrowserOwnedSession(baseUrl: string) {
  if (typeof window === 'undefined') return null;
  const host = window;
  const apiBase = new URL(baseUrl.replace(/\/+$/, ''), host.location.href).href;
  const key = 'replay.owned-session.v1:' + apiBase;
  let storage: Storage | null = null;
  let record: { version: 1; apiBase: string; sid: string } | null = null;
  try {
    storage = host.sessionStorage;
    const raw = storage.getItem(key);
    if (raw) {
      let value;
      try { value = JSON.parse(raw); } catch { storage.removeItem(key); }
      if (value?.version === 1 && value.apiBase === apiBase && typeof value.sid === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(value.sid)) record = value;
      else storage.removeItem(key);
    }
  } catch { storage = null; }
  const navigation = host.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  // Duplicated/new tabs can inherit sessionStorage. A navigate/back_forward
  // entry does not establish ownership, and must discard that copied receipt.
  if (navigation?.type !== 'reload') {
    try { storage?.removeItem(key); } catch { /* No remote mutation is justified. */ }
    record = null;
  }
  const recoverySid = record?.sid ?? null;
  let currentSid = recoverySid;
  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted || !currentSid) return;
    // Keep the receipt until an ordinary, observed DELETE/404 succeeds. Unload
    // requests may be lost; the next reload must retry the same known SID.
    void globalThis.fetch(`${apiBase}/sessions/${encodeURIComponent(currentSid)}`, {
      method: 'DELETE', keepalive: true, headers: { Accept: 'application/json' },
    }).catch(() => {});
  };
  host.addEventListener('pagehide', onPageHide);
  return {
    recoverySid,
    remember(sid: string) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) throw new Error('服务返回的会话 ID 无法用于刷新清理');
      currentSid = sid;
      if (!storage) throw new Error('无法保存当前标签页的会话清理记录，请允许会话存储后重试');
      storage.setItem(key, JSON.stringify({ version: 1, apiBase, sid }));
    },
    release(sid: string) {
      if (currentSid === sid) currentSid = null;
      try {
        const raw = storage?.getItem(key);
        if (raw && JSON.parse(raw).sid === sid) storage?.removeItem(key);
      } catch { /* A stale receipt can safely receive 404 on the next reload. */ }
    },
    dispose() { host.removeEventListener('pagehide', onPageHide); },
  };
}
