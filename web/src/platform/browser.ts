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
import { randomUUID } from '../core/types';
import { decodeSnapshot, encodeSnapshot } from '../core/serialization';
import type {
  BridgeCapabilities,
  DeviceInfo,
  NotificationPayload,
  PlatformBridge,
  SharedSettings,
} from './bridge';
import { EMPTY_SHARED_SETTINGS } from './bridge';
import { isPageForeground } from './foreground';
import { createRemoteParsingConfiguration, RemoteRoutineParsingService } from '../core/remote';

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
/** 跨设备设置的本地存放键。WebView 宿主下这份值会经原生同步到手表。 */
const SETTINGS_KEY = 'morning-mainline.settings.v1';

/**
 * `Notification.requestPermission()` 的兜底超时。
 *
 * 该 API 在若干真实场景下**不会 settle**：用户在弹窗上既不点允许也不点拒绝（直接忽略/切走），
 * 或浏览器因「非用户手势触发」而挂起 UI。裸 `await` 会让调用方永久挂起。
 * 桥的契约要求每个方法都在有限时间内 settle，故此处 race 一个超时（超时按未授权处理）。
 */
const PERMISSION_TIMEOUT_MS = 5_000;

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

/** 浏览器 TTS 能力探测。Node 测试环境（无 `window`）恒为 false。 */
function detectSpeech(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return typeof (window as { speechSynthesis?: unknown }).speechSynthesis !== 'undefined';
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
      speech: detectSpeech(),
    };
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const role: DeviceRole = 'phone';
    const existing = await this.store.get(DEVICE_ID_KEY);
    if (typeof existing === 'string' && existing !== '') {
      return { id: existing, role };
    }
    const id = randomUUID();
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

  /**
   * 浏览器宿主的设置读写。
   *
   * 与 WebView 宿主的**语义差异必须说清**：浏览器里没有 Apple Watch 可同步，
   * 也没有 App Group 可落 —— 这里的 Key 只存在本页存储里，仅本页有效。
   * 换句话说，浏览器宿主下「手机上填一次、手表就能用」这件事**物理上做不到**，
   * 因此这里不做任何假装：读得到就读，读不到就空。
   */
  async readSettings(): Promise<SharedSettings> {
    const raw = await this.store.get(SETTINGS_KEY);
    if (typeof raw !== 'string' || raw === '') {
      return { ...EMPTY_SHARED_SETTINGS };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SharedSettings>;
      return {
        amapKey: typeof parsed.amapKey === 'string' ? parsed.amapKey : '',
        travelMode: typeof parsed.travelMode === 'string' ? parsed.travelMode : 'driving',
        // 字段缺失（旧版本写下的数据）时回落默认开，而不是当成 false ——
        // `boolean` 用 `!== false` 而不是 `=== true`，正是为了这一步。
        speechEnabled: parsed.speechEnabled !== false,
      };
    } catch {
      return { ...EMPTY_SHARED_SETTINGS };
    }
  }

  async writeSettings(settings: SharedSettings): Promise<void> {
    await this.store.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  async requestNotificationAuthorization(): Promise<boolean> {
    if (typeof Notification === 'undefined') {
      return false;
    }
    try {
      // 必须 race 超时：`requestPermission()` 在用户忽略弹窗时可能永不 settle（见常量注释）。
      const permission = await Promise.race<NotificationPermission>([
        Notification.requestPermission(),
        new Promise<NotificationPermission>((resolve) => {
          setTimeout(() => resolve('default'), PERMISSION_TIMEOUT_MS);
        }),
      ]);
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
    // 前台去重（ARCHITECTURE §6）：页面可见时该提醒由应用内弹窗负责，这里不再重复打扰。
    // 注意：这是第二层防线。第一层在 stores/reminders.ts 的引擎里（可见 → 弹窗，不可见 → 这里）。
    if (isPageForeground()) {
      return;
    }
    try {
      // 浏览器宿主仅前台/授权后可用；后台推送需 Web Push，此处不做（§1）。
      new Notification(payload.title, { body: payload.body });
    } catch {
      // 静默降级：通知失败不得影响主流程。
    }
  }

  async setForegroundReminderReady(): Promise<void> {
    // 浏览器宿主没有原生 willPresent；前台去重由本文件的可见性判断负责。
  }

  /**
   * 浏览器宿主的语音播报：走 Web Speech API。
   *
   * 与 WebView 宿主的差别：这里**没有**原生 TTS 可托付，只能靠页面自己的能力。
   * Chrome/Safari 都支持，但发声质量、是否要求用户手势、系统语音包是否装了中文，
   * 全都不可控 —— 因此它只是「尽力而为」，失败一律静默（§4b.1：绝不可拖住提醒引擎）。
   *
   * 每次播报前先 `cancel()`：提醒是**此时的这一件事**，上一句念到一半也该让位；
   * 排队会导致用户听到的内容与屏幕上显示的那条对不上。
   */
  async speak(text: string): Promise<void> {
    if (text === '' || typeof window === 'undefined') {
      return;
    }
    const synthesis = (window as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      return;
    }
    try {
      synthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      // 中文语音包名随系统而变，交给系统按 lang 自动挑，不硬编码 voice。
      utterance.lang = 'zh-CN';
      synthesis.speak(utterance);
    } catch {
      // 静默降级：播报失败不得影响主流程。
    }
  }

  async parseWithModel(input: string): Promise<ParseResult | null> {
    if (!this.modelProxyURL) return null;
    // 复用原来的提示词、宽松解码和降级策略；凭据只由服务器注入。
    const service = new RemoteRoutineParsingService(createRemoteParsingConfiguration({
      endpoint: this.modelProxyURL,
      model: 'cosmo-mind-coder',
      timeout: 60,
    }));
    return service.parse(input, new Date());
  }

  onSnapshotChanged(): () => void {
    // 浏览器宿主无外部快照来源（跨标签同步非 P1 范围），空订阅。
    return () => {};
  }

  onNotificationOpened(): () => void {
    return () => {};
  }

  onAppStateChanged(cb: (visible: boolean) => void): () => void {
    // 订阅时立即给出当前态（与 WebView 宿主语义对齐：两种宿主都「订阅即得当前值」）。
    cb(isPageForeground());
    if (typeof document === 'undefined') {
      return () => {};
    }
    const listener = (): void => {
      cb(isPageForeground());
    };
    document.addEventListener('visibilitychange', listener);
    return () => {
      document.removeEventListener('visibilitychange', listener);
    };
  }
}

/** 工厂：供 `bridge.ts` 的 `createBridge()` 调用。 */
export function createBrowserBridge(options: BrowserBridgeOptions = {}): PlatformBridge {
  return new BrowserBridge(options);
}
