import { reactive } from 'vue';
import type { RoutineSnapshot } from '../core/types';
import { decodeSnapshot, encodeSnapshot } from '../core/serialization';
import type { PlatformBridge } from './bridge';

export const account = reactive({ user: null as { id: string; username: string } | null, ready: false, status: '', conflict: false });
const baseURL = import.meta.env.VITE_ACCOUNT_API_URL || '/api/account';
export async function accountRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch(`${baseURL}${path}`, {
    method, credentials: 'include', signal: AbortSignal.timeout(10000),
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '账号服务暂时不可用'), { status: response.status });
  return data;
}
export async function loadAccount(): Promise<void> {
  try {
    account.user = (await accountRequest('/me')).user;
    localStorage.setItem('mm-account-user', JSON.stringify(account.user));
  } catch (error) {
    if ((error as { status?: number }).status === 401) localStorage.removeItem('mm-account-user');
    else {
      try { account.user = JSON.parse(localStorage.getItem('mm-account-user') || 'null'); } catch { /* 无缓存账号 */ }
      account.status = account.user ? '离线模式，数据暂存本机' : '账号服务未连接';
    }
  } finally { account.ready = true; }
}
export function withAccountSync(bridge: PlatformBridge): PlatformBridge {
  if (typeof window === 'undefined') return bridge;
  let revision = 0;
  let pending: string | null = null;
  let current: string | null = null;
  let syncing = false;
  let conflict = false;
  const listeners = new Set<(snapshot: RoutineSnapshot) => void>();
  const storageKey = () => `mm-account-snapshot:${account.user?.id}`;
  function saveCache(): void {
    localStorage.setItem(storageKey(), JSON.stringify({ revision, pending, current }));
  }
  async function sync(): Promise<void> {
    if (!account.user || syncing || conflict) return;
    syncing = true;
    try {
      if (pending) {
        const sending = pending;
        const result = await accountRequest('/snapshot', 'PUT', { revision, snapshot: JSON.parse(sending) });
        revision = result.revision;
        if (pending === sending) pending = null;
        saveCache();
      }
      if (!pending) {
        const remote = await accountRequest('/snapshot');
        if (!pending && remote.revision !== revision && remote.snapshot) {
          revision = remote.revision;
          current = JSON.stringify(remote.snapshot);
          saveCache();
          const snapshot = decodeSnapshot(current!);
          // 核心按 updatedAt 判断是否接收远端；服务端版本是同步顺序的依据。
          snapshot.updatedAt = new Date();
          snapshot.originID = `cloud:${revision}`;
          listeners.forEach(listener => listener(snapshot));
        }
      }
      account.status = pending ? '等待同步' : '已同步';
    } catch (error) {
      if ((error as { status?: number }).status === 409) { conflict = true; account.conflict = true; account.status = '其他设备已更新，本机改动已保留'; }
      else account.status = (error as { status?: number }).status === 401 ? '登录已过期，请重新登录' : '离线模式，数据暂存本机';
    } finally { syncing = false; }
  }
  window.addEventListener('online', () => void sync());
  window.addEventListener('mm-resolve-sync', async event => {
    if (syncing || !account.user) return;
    try {
      const remote = await accountRequest('/snapshot');
      revision = remote.revision;
      if ((event as CustomEvent).detail === 'cloud') {
        localStorage.setItem(`${storageKey()}:conflict-backup`, pending || current || '');
        pending = null; current = remote.snapshot ? JSON.stringify(remote.snapshot) : null;
        saveCache(); window.location.reload(); return;
      }
      conflict = false; account.conflict = false; saveCache(); await sync();
    } catch { account.status = '暂时无法处理冲突，请稍后重试'; }
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  return new Proxy(bridge, { get(target, key) {
    if (key === 'readSnapshot') return async () => {
      if (!account.user) return target.readSnapshot();
      try {
        const cache = JSON.parse(localStorage.getItem(storageKey()) || 'null');
        if (cache) { revision = cache.revision; pending = cache.pending; current = cache.current; }
        const remote = await accountRequest('/snapshot');
        if (!pending) { revision = remote.revision; current = remote.snapshot ? JSON.stringify(remote.snapshot) : null; }
        saveCache();
        if (!current && sessionStorage.getItem('mm-import-local') === 'yes') {
          sessionStorage.removeItem('mm-import-local');
          const imported = await target.readSnapshot();
          if (imported) { current = encodeSnapshot(imported); pending = current; saveCache(); await sync(); }
          return imported;
        }
      } catch { account.status = '离线模式，数据暂存本机'; }
      if (pending) void sync();
      return current ? decodeSnapshot(current) : null;
    };
    if (key === 'writeSnapshot') return async (snapshot: RoutineSnapshot) => {
      if (!account.user) return target.writeSnapshot(snapshot);
      const encoded = encodeSnapshot(snapshot);
      // 接收到的远端快照不再上传，防止同步回环。
      if (!snapshot.originID.startsWith('cloud:')) { pending = encoded; current = encoded; saveCache(); void sync(); }
      if (target.host === 'webview') await target.writeSnapshot(snapshot);
    };
    if (key === 'onSnapshotChanged') return (listener: (snapshot: RoutineSnapshot) => void) => {
      listeners.add(listener);
      const unsubscribeNative = target.onSnapshotChanged(listener);
      if (!timer) timer = setInterval(() => void sync(), 5000);
      return () => { unsubscribeNative(); listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
