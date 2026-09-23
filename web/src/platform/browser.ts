/**
 * platform/browser.ts — 浏览器宿主实现（ARCHITECTURE §1 浏览器列 / §4b.1）。
 *
 * 关键约束：
 * - 快照落 **IndexedDB**（不用 localStorage 存大对象）；非 DOM 环境（单测/SSR）自动回落内存实现。
 * - `deviceInfo().id` **必须持久化且稳定**：否则 `originID` 过滤失效 → 同步自激（§4b.1 硬性要求）。
 * - `parseWithModel` 在**无后端代理时返回 `null`**，绝不可把 API Key 打进前端产物（§7）。
 * - `capabilities` 依据探测结果动态给出（Web Push 可用则 `backgroundNotification=true`）。
 */

import type { RoutineSession, RoutineSnapshot, ParseResult, DeviceRole } from '../core/types';
import { decodeSnapshot, encodeSnapshot } from '../core/serialization';
import type {
  BridgeCapabilities,
  DeviceInfo,
  NotificationPayload,
  PlatformBridge,
} from './bridge';

/** 键值持久化抽象：IndexedDB 可用时走 IDB，否则回落内存（单测/无 DOM 场景）。 */
interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const DB_NAME = 'morning-mainline';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

const DEVICE_ID_KEY = 'morning-mainline.device-id';
const SNAPSHOT_KEY = 'morning-mainline.local-snapshot.v2';
const NOTIFICATION_SESSION_KEY = 'morning-mainline.notifications.session-id';

/** 纯内存兜底（无 IndexedDB 的宿主，例如 Node 测试环境）。 */
function createMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

/** IndexedDB 键值实现（单 objectStore，keyPath = 'key'）。 */
function createIndexedDbStore(): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open 失败'));
    });
    return dbPromise;
  };

  return {
    async get(key) {
      const db = await open();
      return await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB get 失败'));
      });
    },
    async set(key, value) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB set 失败'));
      });
    },
  };
}

/** 选择可用的持久化后端。 */
function selectStore(): KeyValueStore {
  if (typeof indexedDB !== 'undefined') {
    try {
      return createIndexedDbStore();
    } catch {
      return createMemoryStore();
    }
  }
  return createMemoryStore();
}

/** Web Push 能力探测（§1：浏览器宿主仅在装 PWA + PushManager 时才有后台通知）。 */
function detectBackgroundNotification(): boolean {
  return (
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  );
}

export interface BrowserBridgeOptions {
  /**
   * 可选的后端代理地址。**为空时 `parseWithModel` 一律返回 `null`**（§7：Key 绝不进前端）。
   * 仅当显式配置代理时才发起请求。
   */
  modelProxyURL?: string | null;
  /** 覆盖默认持久化后端（单测可注入内存实现）。 */
  store?: KeyValueStore;
}

/**
 * 浏览器宿主桥。
 *
 * 注意：本模块**不得**在加载期访问 `window` / `navigator` / `indexedDB`，以便在 Node 单测环境安全 import。
 */
export class BrowserBridge implements PlatformBridge {
  readonly host = 'browser' as const;
  readonly capabilities: BridgeCapabilities;

  private readonly store: KeyValueStore;
  private readonly modelProxyURL: string | null;
  /** 已排程会话 id（浏览器宿主 P1 仅记录，不真正后台排程）。 */
  private lastScheduledSessionID: string | null = null;

  constructor(options: BrowserBridgeOptions = {}) {
    this.store = options.store ?? selectStore();
    this.modelProxyURL = options.modelProxyURL ?? null;
    this.capabilities = {
      watchSync: false,
      backgroundNotification: detectBackgroundNotification(),
      modelParsing: this.modelProxyURL !== null,
      widget: false,
    };
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const role: DeviceRole = 'phone';
    const existing = await this.store.get(DEVICE_ID_KEY);
    if (typeof existing === 'string' && existing !== '') {
      return { id: existing, role };
    }
    const id = globalThis.crypto.randomUUID();
    await this.store.set(DEVICE_ID_KEY, id);
    return { id, role };
  }

  async readSnapshot(): Promise<RoutineSnapshot | null> {
    const raw = await this.store.get(SNAPSHOT_KEY);
    if (typeof raw !== 'string' || raw === '') {
      return null;
    }
    return decodeSnapshot(raw);
  }

  async writeSnapshot(snapshot: RoutineSnapshot): Promise<void> {
    await this.store.set(SNAPSHOT_KEY, encodeSnapshot(snapshot));
  }

  async requestNotificationAuthorization(): Promise<boolean> {
    if (typeof Notification === 'undefined') {
      return false;
    }
    try {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch {
      return false;
    }
  }

  async replaceNotifications(session: RoutineSession | null): Promise<void> {
    this.lastScheduledSessionID = session?.id ?? null;
    await this.store.set(NOTIFICATION_SESSION_KEY, this.lastScheduledSessionID);
  }

  async presentNotification(payload: NotificationPayload): Promise<void> {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return;
    }
    try {
      // 浏览器宿主仅前台/授权后可用；后台推送需 Web Push，此处不做（§1）。
      new Notification(payload.title, { body: payload.body });
    } catch {
      // 静默降级：通知失败不得影响主流程。
    }
  }

  async parseWithModel(): Promise<ParseResult | null> {
    // §7：无代理时一律返回 null，调用方回退纯规则；绝不在此暴露任何 API Key。
    return null;
  }

  onSnapshotChanged(): () => void {
    // 浏览器宿主无外部快照来源（跨标签同步非 P1 范围），空订阅。
    return () => {};
  }

  onNotificationOpened(): () => void {
    return () => {};
  }
}

/** 工厂：供 `bridge.ts` 的 `createBridge()` 调用。 */
export function createBrowserBridge(options: BrowserBridgeOptions = {}): PlatformBridge {
  return new BrowserBridge(options);
}
