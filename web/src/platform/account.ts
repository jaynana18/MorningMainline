import { reactive } from 'vue';
import type { RoutineSnapshot } from '../core/types';
import { decodeSnapshot, encodeSnapshot } from '../core/serialization';
import type { PlatformBridge, SharedSettings } from './bridge';
import { nativeRequest } from './webview';

/**
 * 「用户习惯」三项：出行方式 / 语音播报 / 超时提醒间隔 —— 跟账号走，跨设备生效。
 *
 * 🔴 **刻意不含高德 Key**：那是**开发者配置**（构建期 `web/.env.local` 注入，
 * 全用户同一份），不是用户数据。把它跟账号同步会让「换账号」这种无关动作
 * 把 Key 带着走，也会让浏览器宿主的产物里多一份不该公开的凭据。
 *
 * 与快照同步的关键差别：**不做乐观锁**。偏好冲突的代价只是某一项被覆盖，
 * 而 revision 冲突会逼用户处理一次 409 —— 为「提醒间隔差 1 分钟」弹冲突框不值。
 * 故 PUT 直接覆盖，`updatedAt` 由**服务端**打（用客户端时钟会在设备时钟不准时乱序）。
 */
function pickPreferences(settings: SharedSettings): Record<string, unknown> {
  return {
    travelMode: settings.travelMode,
    speechEnabled: settings.speechEnabled,
    overduePolicy: { ...settings.overduePolicy },
  };
}

export const account = reactive({ user: null as { id: string; username: string } | null, ready: false, status: '', conflict: false });
const baseURL = import.meta.env.VITE_ACCOUNT_API_URL || '/api/account';
export async function accountRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
  const timeout = path === '/parse' ? 65000 : 10000;
  // ⚠️ `typeof window` 守卫不能省：本模块被 `taskParsing` 引用，而 `stores/routine`
  // 又会 import 前者 —— 单测（Node 环境）一旦走到 `store.parse()` 就会直接抛
  // `ReferenceError: window is not defined`，看起来像解析功能坏了，实际只是环境没有 window。
  // `withAccountSync` 早就有同样的守卫，这里漏了。
  if (typeof window !== 'undefined' && window.webkit?.messageHandlers?.mainline) {
    const result = await nativeRequest('account.request', { path, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, timeout) as { status: number; data: any };
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(result.data.error || '账号服务暂时不可用'), { status: result.status });
    return result.data;
  }
  const response = await fetch(`${baseURL}${path}`, {
    method, credentials: 'include', signal: AbortSignal.timeout(timeout),
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
          // ⚠️ 先解码、成功后才提交 revision：`decodeSnapshot` 可返回 null。
          // 若按原写法先推进 revision 再解码，一次解码失败就会让
          // 「remote.revision === revision」永久成立 → 这份远端数据再也不会被拉取。
          const encoded = JSON.stringify(remote.snapshot);
          const snapshot = decodeSnapshot(encoded);
          if (snapshot) {
            revision = remote.revision;
            current = encoded;
            saveCache();
            // 核心按 updatedAt 判断是否接收远端；服务端版本是同步顺序的依据。
            snapshot.updatedAt = new Date();
            snapshot.originID = `cloud:${revision}`;
            listeners.forEach(listener => listener(snapshot));
          }
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
  /**
   * 上次同步成功的偏好，供离线时回读。
   *
   * ⚠️ 刻意**不参与 LWW 裁决**（不比对 `updatedAt`）：偏好是 PUT 直接覆盖的，
   * 服务端的 `updatedAt` 只用于记录，本地比它没有意义 —— 本机改了但还没推上去时，
   * 本地值一定比服务端新，再拿时间戳去比反而会把自己的改动覆盖掉。
   */
  const preferencesKey = () => `mm-account-preferences:${account.user?.id}`;

  /**
   * 把三项「用户习惯」推给服务端。
   *
   * 失败**不抛给调用方**：用户改个开关不该因为网络抖动而弹错。
   * 本地写入（App Group / localStorage）已经先成功了，下次改设置时会重推。
   */
  async function pushPreferences(settings: SharedSettings): Promise<void> {
    if (!account.user || conflict) return;
    try {
      await accountRequest('/preferences', 'PUT', { preferences: pickPreferences(settings) });
      localStorage.setItem(preferencesKey(), JSON.stringify(pickPreferences(settings)));
      account.status = '已同步';
      return;
    } catch (error) {
      // 401 交给既有的状态文案体系；其余按离线处理，不改本机值。
      if ((error as { status?: number }).status === 401) account.status = '登录已过期，请重新登录';
      else account.status = '离线模式，数据暂存本机';
    }
  }

  /**
   * 取远端偏好并按字段覆盖到本机设置上。
   *
   * 🔴 只有 `travelMode` / `speechEnabled` / `overduePolicy` 三项以云端为准，
   * `amapKey` **永远保留本机值** —— 它是开发者配置，服务端根本不存它。
   * 若这里整体替换，换一次账号就会把 Key 清空。
   *
   * 远端为空（新账号第一次）时不覆盖，由调用方把本机现状推上去作为初始值 ——
   * 否则「老用户第一次登录」会看到自己的设置被重置成默认值。
   */
  async function pullPreferences(local: SharedSettings): Promise<SharedSettings> {
    if (!account.user) return local;
    try {
      const remote = await accountRequest('/preferences');
      const preferences = remote.preferences as Partial<SharedSettings> | null;
      if (!preferences) {
        // 远端还没数据（新账号第一次登录）：本机现状就是初始值，推上去。
        void pushPreferences(local);
        return local;
      }
      const merged: SharedSettings = {
        ...local,
        ...(typeof preferences.travelMode === 'string' ? { travelMode: preferences.travelMode } : {}),
        ...(typeof preferences.speechEnabled === 'boolean' ? { speechEnabled: preferences.speechEnabled } : {}),
        ...(preferences.overduePolicy ? { overduePolicy: preferences.overduePolicy } : {}),
        // 显式重申：Key 不来自云端。
        amapKey: local.amapKey,
      };
      localStorage.setItem(preferencesKey(), JSON.stringify(pickPreferences(merged)));
      return merged;
    } catch (error) {
      if ((error as { status?: number }).status === 401) account.status = '登录已过期，请重新登录';
      else {
        // 离线时用上次同步的缓存，至少要跟「上次在线时」一致，而不是退回默认值。
        try {
          const cached = JSON.parse(localStorage.getItem(preferencesKey()) || 'null');
          if (cached) return { ...local, ...cached, amapKey: local.amapKey };
        } catch { /* 无缓存，保持本机值 */ }
        account.status = '离线模式，数据暂存本机';
      }
      return local;
    }
  }

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
    if (key === 'readSettings') return async () => {
      const local = await target.readSettings();
      if (!account.user) return local;
      // 云端偏好优先；Key 永远取本机（服务端不存它）。
      return pullPreferences(local);
    };
    if (key === 'writeSettings') return async (settings: SharedSettings) => {
      // 本机先写：App Group 是手表拿 Key 的唯一通道，不能被网络拖慢或拖败。
      await target.writeSettings(settings);
      // 再异步推云端；失败静默（本机已生效，下次改设置会重推）。
      if (account.user) void pushPreferences(settings);
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
