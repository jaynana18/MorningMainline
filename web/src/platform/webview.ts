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

/** 订阅者未就绪时暂存的「通知点击」事件上限。与原生 `WebHost.pendingEvents` 的 32 条上限对称。
 *  超出时丢最旧：最新的一次点击才代表用户当下的意图。 */
const MAX_PENDING_NOTIFICATION_EVENTS = 64;

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

  /**
   * 订阅者尚未就绪时到达的「最新快照」事件。
   *
   * 只保留最新：快照表达的是**状态**而非事件流，丢掉中间态不损失语义，
   * 补发最新一份即可让订阅者看到权威状态。用于修掉「原生在页面刚加载、store 尚未
   * 调 `onSnapshotChanged` 之前 emit」的静默丢弃窗口。
   */
  private pendingSnapshotEvent: RoutineSnapshot | null = null;

  /**
   * 订阅者尚未就绪时到达的「通知点击」事件。
   *
   * 通知点击是**一次性事件**（用户点了系统通知冷启动 App），语义上必须逐条投递、
   * 不可合并，故按到达顺序保留队列。
   */
  private pendingNotificationEvents: NotificationOpenedPayload[] = [];
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
        if (this.snapshotListeners.size === 0) {
          // 订阅者尚未就绪：暂存「最新快照」，待 onSnapshotChanged 补发（快照是状态而非事件流）。
          this.pendingSnapshotEvent = snapshot;
        } else {
          for (const listener of this.snapshotListeners) {
            listener(snapshot);
          }
        }
      }
      return;
    }
    if (event === 'notification.opened') {
      const data = (payload ?? {}) as NotificationOpenedPayload;
      if (this.notificationListeners.size === 0) {
        // 订阅者尚未就绪：入队（一次性事件，按到达顺序保留，不合并）。
        // 封顶防无界增长（页面长期未订阅时）；超界丢最旧 —— 最新的一次点击才代表用户当下的意图。
        this.pendingNotificationEvents.push(data);
        if (this.pendingNotificationEvents.length > MAX_PENDING_NOTIFICATION_EVENTS) {
          this.pendingNotificationEvents.shift();
        }
      } else {
        for (const listener of this.notificationListeners) {
          listener(data);
        }
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
    // 补发订阅前到达的「最新快照」（若存在）。此刻集合内只有刚加入的 cb，
    // 因此对集合分发等价于对 cb 单发；沿用 for...of 与既有风格一致。
    if (this.pendingSnapshotEvent !== null) {
      const snapshot = this.pendingSnapshotEvent;
      this.pendingSnapshotEvent = null;
      for (const listener of this.snapshotListeners) {
        listener(snapshot);
      }
    }
    return () => {
      this.snapshotListeners.delete(cb);
    };
  }

  onNotificationOpened(cb: (payload: NotificationOpenedPayload) => void): () => void {
    this.install();
    this.notificationListeners.add(cb);
    // 补发订阅前到达的通知点击事件，按到达顺序逐条**只调 cb**：
    // 点击是一次性事件，若广播给集合内所有 listener，会对更早的订阅者造成重复投递；
    // 此分支下集合内只有新加入的 cb，两种写法可观测结果一致，这里明确只投给本次订阅者。
    // 投递完毕即清空队列，避免同一条事件被后续订阅者重复消费。
    for (const payload of this.pendingNotificationEvents) {
      cb(payload);
    }
    this.pendingNotificationEvents = [];
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
