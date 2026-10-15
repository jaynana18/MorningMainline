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
import { createStep, makeParseResult, randomUUID } from '../core/types';
import { decodeSnapshot, encodeSnapshot, refSecondsToMs } from '../core/serialization';
// `overduePolicy` 读回来必须过 `normalizeOverduePolicy`：原生侧可能是**旧版本**（没有这个键），
// 也可能是未来版本塞了脏值（负数/超范围/非数字）。不归一化会在 tick 里算出 NaN 轮次 → 永不提醒。
import { normalizeOverduePolicy, type OverduePolicy } from '../core/reminders';
import { createBrowserBridge } from './browser';
import type {
  BridgeCapabilities,
  DeviceInfo,
  NotificationOpenedPayload,
  NotificationPayload,
  PlatformBridge,
  SharedSettings,
} from './bridge';

/** 桥调用超时（毫秒）。§4b.1 建议 5s。定义在此避免与 bridge.ts 形成值级循环依赖。 */
export const BRIDGE_TIMEOUT_MS = 5000;

/** 订阅者未就绪时暂存的「通知点击」事件上限。与原生 `WebHost.pendingEvents` 的 32 条上限对称。
 *  超出时丢最旧：最新的一次点击才代表用户当下的意图。 */
const MAX_PENDING_NOTIFICATION_EVENTS = 64;
let nativeBridge: WebViewBridge | null = null;
export function nativeRequest(method: string, params: Record<string, unknown> = {}, timeout = 25000): Promise<unknown> {
  if (!nativeBridge) return Promise.reject(new Error('原生连接尚未就绪'));
  return nativeBridge.request(method, params, timeout);
}

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
    // 原生 `AVSpeechSynthesizer` 负责念。与系统「播报通知」无关（那条只在锁屏生效）。
    speech: true,
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

  /**
   * 订阅者未就绪时暂存的最近一次前后台状态（单一槽位）。
   *
   * 与快照同理：这是**状态**而非事件流，只留最新即可。用于「原生在 store 订阅
   * `onAppStateChanged` 之前就 emit 了 `app.state`（例如冷启动时原生补发当前态）」的窗口。
   */
  private pendingAppState: boolean | null = null;

  private readonly appStateListeners = new Set<(visible: boolean) => void>();

  constructor() {
    nativeBridge = this;
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
      return;
    }
    if (event === 'app.state') {
      // 严格 `=== true` 判定：脏载荷（缺失/非布尔）一律视为「不在前台」，
      // 宁可保守按后台处理，也不要把非法值误判成前台而漏发系统通知。
      const visible = (payload as { visible?: unknown })?.visible === true;
      if (this.appStateListeners.size === 0) {
        this.pendingAppState = visible;
      } else {
        for (const listener of this.appStateListeners) {
          listener(visible);
        }
      }
    }
  }

  /** 发消息并等待同 id 回执；超时或抛错都 reject（由公开方法统一降级）。 */
  request(method: string, params: Record<string, unknown> = {}, timeout = BRIDGE_TIMEOUT_MS): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const handler =
        typeof window !== 'undefined' ? window.webkit?.messageHandlers?.mainline : undefined;
      if (!handler) {
        reject(new Error('WebView 桥不可用'));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`原生桥调用超时：${method}`));
      }, timeout);

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

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(method, params);
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

  /**
   * 读取跨设备设置。原生经 App Group 落地，并由 WCSession 与手表互通。
   *
   * 失败时**回落到本地存储**而不是空值：原生桥短暂不可用不该让用户刚填的 Key 消失。
   */
  async readSettings(): Promise<SharedSettings> {
    try {
      const result = (await this.call('settings.read')) as Record<string, unknown> | null;
      if (result && typeof result === 'object') {
        return {
          amapKey: typeof result.amapKey === 'string' ? result.amapKey : '',
          travelMode: typeof result.travelMode === 'string' ? result.travelMode : 'driving',
          // 原生侧同样用 `decodeIfPresent` 兜底；这里再兜一层，防旧原生包不返回该字段。
          speechEnabled: result.speechEnabled !== false,
          // 旧原生包不返回该字段 → `normalize` 补成默认（全程 2 分钟）。
          overduePolicy: normalizeOverduePolicy(
            result.overduePolicy as Partial<OverduePolicy> | null | undefined,
          ),
        };
      }
      throw new Error('settings.read 结果非法');
    } catch (error) {
      this.warn('settings.read', error);
      return this.fallback.readSettings();
    }
  }

  /**
   * 写入并广播给配对设备。**这一步是手表拿到高德 Key 的唯一路径** ——
   * 写 localStorage 手表读不到（跨设备、跨容器）。
   */
  async writeSettings(settings: SharedSettings): Promise<void> {
    try {
      await this.call('settings.write', { ...settings });
    } catch (error) {
      this.warn('settings.write', error);
      // 原生不可达时至少让本页记住，不至于当次输入白填。
      await this.fallback.writeSettings(settings);
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

  async setForegroundReminderReady(ready: boolean): Promise<void> {
    try {
      await this.call('notifications.foregroundReady', { ready });
    } catch (error) {
      this.warn('notifications.foregroundReady', error);
    }
  }

  /**
   * 交给原生念。**刻意不 await 结果细节** —— 播报是「发出即完成」的动作，
   * 念多久不该拖住调用方；只保留超时/失败的可观测线索。
   *
   * 不复用 `fallback.speak`：WebView 宿主里页面的 `speechSynthesis` 与原生 TTS
   * 会**同时出声**，变成双声。原生不可用时宁可这一条不念，也不叠加。
   */
  async speak(text: string): Promise<void> {
    if (text === '') {
      return;
    }
    try {
      await this.call('speech.speak', { text });
    } catch (error) {
      this.warn('speech.speak', error);
    }
  }

  async parseWithModel(input: string): Promise<ParseResult | null> {
    try {
      const result = await this.request('parse.withModel', { input }, 65000);
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

  onAppStateChanged(cb: (visible: boolean) => void): () => void {
    this.install();
    this.appStateListeners.add(cb);
    // 补发订阅前到达的最近一次前后台状态（若存在）。此处**只调 cb**：状态是单一槽位，
    // 补发仅面向本次新订阅者；若广播给集合内的老订阅者，会把同一状态重复投递（老订阅者
    // 早已通过实时分发收到过）。此刻集合内也只有它，两种写法可观测结果一致，明确只投给
    // 本次订阅者，避免语义含糊。补发后置空，防止后续订阅者重复消费。
    if (this.pendingAppState !== null) {
      const visible = this.pendingAppState;
      this.pendingAppState = null;
      cb(visible);
    }
    return () => {
      this.appStateListeners.delete(cb);
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
