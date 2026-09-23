/**
 * platform/webview.ts — WebView 宿主实现（ARCHITECTURE §3 桥接协议 / §4b.1）。
 *
 * 通过 `window.webkit.messageHandlers.mainline.postMessage({id, method, params})` 发消息，
 * 按 `id` 匹配原生回执 `{id, ok, result, error}`（§3）。
 *
 * 硬性要求（§4b.1）：
 * - **必须带超时**（5s）；
 * - 任何方法抛错或超时都**不得让 UI 卡死** —— 回落到 browser 语义 / 返回 `null`·`false` / 静默 no-op，
 *   并 `console.warn`；
 * - 事件订阅（`snapshot.changed` / `notification.opened`）通过原生反向调用
 *   `window.__mainlineEmit(event, payload)` 触发。
 *
 * 本模块**不得**在加载期访问 `window`，以便在 Node 单测环境安全 import。
 */

import type { ParseResult, ParseSource, RoutineSession, RoutineSnapshot, RoutineStep } from '../core/types';
import { createStep, makeParseResult } from '../core/types';
import { decodeSnapshot, encodeSnapshot, refSecondsToMs } from '../core/serialization';
import { createBrowserBridge } from './browser';
import type {
  BridgeCapabilities,
  DeviceInfo,
  NotificationOpenedPayload,
  NotificationPayload,
  PlatformBridge,
} from './bridge';

/** 桥调用超时（毫秒）。§4b.1 建议 5s。定义在此避免与 bridge.ts 形成值级循环依赖。 */
export const BRIDGE_TIMEOUT_MS = 5000;

interface WebKitMessageHandler {
  postMessage(message: unknown): void;
}

interface WebKitBridge {
  messageHandlers?: { mainline?: WebKitMessageHandler };
}

interface BridgeReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

declare global {
  interface Window {
    webkit?: WebKitBridge;
    __mainlineReply?: (reply: BridgeReply) => void;
    __mainlineEmit?: (event: string, payload: unknown) => void;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** WebView 宿主桥。 */
export class WebViewBridge implements PlatformBridge {
  readonly host = 'webview' as const;
  readonly capabilities: BridgeCapabilities = {
    // §1：WebView 宿主四项能力齐备；modelParsing 由原生代发（Key 不出设备）。
    watchSync: true,
    backgroundNotification: true,
    modelParsing: true,
    widget: true,
  };

  private readonly pending = new Map<string, PendingCall>();
  private readonly snapshotListeners = new Set<(snapshot: RoutineSnapshot) => void>();
  private readonly notificationListeners = new Set<(payload: NotificationOpenedPayload) => void>();
  /** 桥不可用/出错时的降级实现（复用浏览器语义，保证 UI 不卡死）。 */
  private readonly fallback: PlatformBridge = createBrowserBridge();
  private installed = false;

  constructor() {
    this.install();
  }

  /** 挂载原生 → JS 的回执与事件入口。幂等。 */
  private install(): void {
    if (this.installed || typeof window === 'undefined') {
      return;
    }
    this.installed = true;
    window.__mainlineReply = (reply) => this.handleReply(reply);
    window.__mainlineEmit = (event, payload) => this.handleEmit(event, payload);
  }

  private handleReply(reply: BridgeReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(reply.id);
    if (reply.ok) {
      entry.resolve(reply.result);
    } else {
      entry.reject(new Error(reply.error ?? '原生桥返回失败'));
    }
  }

  private handleEmit(event: string, payload: unknown): void {
    if (event === 'snapshot.changed') {
      const snapshot = this.decodeSnapshotPayload((payload as { snapshot?: unknown })?.snapshot);
      if (snapshot) {
        for (const listener of this.snapshotListeners) {
          listener(snapshot);
        }
      }
      return;
    }
    if (event === 'notification.opened') {
      const data = (payload ?? {}) as NotificationOpenedPayload;
      for (const listener of this.notificationListeners) {
        listener(data);
      }
    }
  }

  /** 发消息并等待同 id 回执；超时或抛错都 reject（由公开方法统一降级）。 */
  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const handler =
        typeof window !== 'undefined' ? window.webkit?.messageHandlers?.mainline : undefined;
      if (!handler) {
        reject(new Error('WebView 桥不可用'));
        return;
      }

      const id = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`原生桥调用超时：${method}`));
      }, BRIDGE_TIMEOUT_MS);

      this.pending.set(id, {
        resolve,
        reject: (error: Error) => reject(error),
        timer,
      });

      try {
        handler.postMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private warn(method: string, error: unknown): void {
    // 静默降级但保留可观测线索（§4b.1）。
    console.warn(`[MainlineBridge] ${method} 失败，已降级：`, error);
  }

  async deviceInfo(): Promise<DeviceInfo> {
    try {
      const result = (await this.call('device.info')) as { id?: unknown; role?: unknown } | null;
      if (result && typeof result.id === 'string') {
        const role = result.role === 'watch' || result.role === 'pad' ? result.role : 'phone';
        return { id: result.id, role };
      }
      throw new Error('device.info 结果非法');
    } catch (error) {
      this.warn('device.info', error);
      return this.fallback.deviceInfo();
    }
  }

  async readSnapshot(): Promise<RoutineSnapshot | null> {
    try {
      const result = await this.call('snapshot.read');
      return this.decodeSnapshotPayload(result);
    } catch (error) {
      this.warn('snapshot.read', error);
      return this.fallback.readSnapshot();
    }
  }

  async writeSnapshot(snapshot: RoutineSnapshot): Promise<void> {
    try {
      await this.call('snapshot.write', { snapshot: encodeSnapshot(snapshot) });
    } catch (error) {
      this.warn('snapshot.write', error);
      await this.fallback.writeSnapshot(snapshot);
    }
  }

  async requestNotificationAuthorization(): Promise<boolean> {
    try {
      const result = (await this.call('notifications.requestAuthorization')) as {
        granted?: unknown;
      } | null;
      return result?.granted === true;
    } catch (error) {
      this.warn('notifications.requestAuthorization', error);
      return false;
    }
  }

  async replaceNotifications(session: RoutineSession | null): Promise<void> {
    try {
      await this.call('notifications.replace', { session: this.encodeSession(session) });
    } catch (error) {
      this.warn('notifications.replace', error);
    }
  }

  async presentNotification(payload: NotificationPayload): Promise<void> {
    try {
      await this.call('notifications.present', { ...payload });
    } catch (error) {
      this.warn('notifications.present', error);
    }
  }

  async parseWithModel(input: string): Promise<ParseResult | null> {
    try {
      const result = await this.call('parse.withModel', { input });
      return decodeParseResultWire(result);
    } catch (error) {
      this.warn('parse.withModel', error);
      return null;
    }
  }

  onSnapshotChanged(cb: (snapshot: RoutineSnapshot) => void): () => void {
    this.install();
    this.snapshotListeners.add(cb);
    return () => {
      this.snapshotListeners.delete(cb);
    };
  }

  onNotificationOpened(cb: (payload: NotificationOpenedPayload) => void): () => void {
    this.install();
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  /** 把会话编码成与 Swift Codable 一致的线格式（Apple 参考秒）。 */
  private encodeSession(session: RoutineSession | null): unknown {
    if (!session) {
      return null;
    }
    const wire = JSON.parse(
      encodeSnapshot({
        templates: [],
        activeSession: session,
        updatedAt: new Date(),
        originID: '',
      }),
    ) as { activeSession?: unknown };
    return wire.activeSession ?? null;
  }

  /** 快照线格式可为 JSON 字符串或已解析对象，统一走 decodeSnapshot。 */
  private decodeSnapshotPayload(raw: unknown): RoutineSnapshot | null {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw === 'string') {
      return decodeSnapshot(raw);
    }
    try {
      return decodeSnapshot(JSON.stringify(raw));
    } catch {
      return null;
    }
  }
}

/** 解析 `parse.withModel` 的线格式结果（含 Apple 参考秒 deadline）为内存 `ParseResult`。 */
export function decodeParseResultWire(raw: unknown): ParseResult | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as {
    steps?: unknown;
    deadline?: unknown;
    source?: unknown;
    leftover?: unknown;
  };
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    return null;
  }
  const steps: RoutineStep[] = obj.steps.map((item) => {
    const source = (item ?? {}) as {
      id?: unknown;
      title?: unknown;
      prompt?: unknown;
      duration?: unknown;
      importance?: unknown;
      role?: unknown;
    };
    return createStep({
      id: typeof source.id === 'string' ? source.id : undefined,
      title: typeof source.title === 'string' ? source.title : '',
      prompt: typeof source.prompt === 'string' ? source.prompt : null,
      duration: typeof source.duration === 'number' ? source.duration : 0,
      importance: source.importance === 'hardDeadline' ? 'hardDeadline' : 'normal',
      role: source.role === 'deadline' ? 'deadline' : 'task',
    });
  });
  const deadline =
    typeof obj.deadline === 'number' ? new Date(refSecondsToMs(obj.deadline)) : null;
  const source: ParseSource = obj.source === 'enhanced' ? 'enhanced' : 'rule';
  const leftover = typeof obj.leftover === 'string' ? obj.leftover : '';
  return makeParseResult({ steps, deadline, source, leftover });
}

/** 工厂：供 `bridge.ts` 的 `createBridge()` 调用。 */
export function createWebViewBridge(): PlatformBridge {
  return new WebViewBridge();
}
