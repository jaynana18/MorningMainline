/**
 * platform/mock.ts — 纯内存桥实现（ARCHITECTURE §4b.1）。
 *
 * 用途：单元测试 + 浏览器无持久化场景。不触碰任何宿主 API（无 IndexedDB / window / Notification），
 * 且**记录所有调用**，便于断言「commit() 是否触发 writeSnapshot + replaceNotifications」等契约。
 */

import type { DeviceRole, ParseResult, RoutineSession, RoutineSnapshot } from '../core/types';
import { cloneSnapshot } from '../core/types';
import type {
  BridgeCapabilities,
  DeviceInfo,
  NotificationOpenedPayload,
  NotificationPayload,
  PlatformBridge,
} from './bridge';

export interface MockBridgeOptions {
  host?: 'webview' | 'browser';
  deviceId?: string;
  deviceRole?: DeviceRole;
  /** 初始已落库快照（模拟二次启动读回）。 */
  initialSnapshot?: RoutineSnapshot | null;
  capabilities?: Partial<BridgeCapabilities>;
  /** `parseWithModel` 的返回值；默认 `null`（模拟无代理/无能力的浏览器宿主）。 */
  modelParseResult?: ParseResult | null;
  /** 通知授权是否授予；默认 false。 */
  notificationAuthorizationGranted?: boolean;
}

export class MockBridge implements PlatformBridge {
  readonly host: 'webview' | 'browser';
  readonly capabilities: BridgeCapabilities;

  // ---- 调用记录（供断言） ----
  readonly writeSnapshotCalls: RoutineSnapshot[] = [];
  readonly replaceNotificationsCalls: (RoutineSession | null)[] = [];
  readonly presentNotificationCalls: NotificationPayload[] = [];
  readonly foregroundReminderReadyStates: boolean[] = [];
  readonly parseWithModelCalls: string[] = [];
  deviceInfoCallCount = 0;
  requestAuthorizationCallCount = 0;

  private readonly deviceId: string;
  private readonly deviceRole: DeviceRole;
  private snapshot: RoutineSnapshot | null;
  private readonly modelParseResult: ParseResult | null;
  private readonly authorizationGranted: boolean;

  private readonly snapshotListeners = new Set<(snapshot: RoutineSnapshot) => void>();
  private readonly notificationListeners = new Set<(payload: NotificationOpenedPayload) => void>();
  private readonly appStateListeners = new Set<(visible: boolean) => void>();
  /** 最近一次已知前后台状态；null = 尚无来源（订阅时不立即回调）。 */
  private lastAppState: boolean | null = null;

  constructor(options: MockBridgeOptions = {}) {
    this.host = options.host ?? 'browser';
    this.deviceId = options.deviceId ?? 'mock-device';
    this.deviceRole = options.deviceRole ?? 'phone';
    this.snapshot = options.initialSnapshot ?? null;
    this.modelParseResult = options.modelParseResult ?? null;
    this.authorizationGranted = options.notificationAuthorizationGranted ?? false;
    this.capabilities = {
      watchSync: false,
      backgroundNotification: false,
      modelParsing: this.modelParseResult !== null,
      widget: false,
      ...options.capabilities,
    };
  }

  async deviceInfo(): Promise<DeviceInfo> {
    this.deviceInfoCallCount += 1;
    return { id: this.deviceId, role: this.deviceRole };
  }

  async readSnapshot(): Promise<RoutineSnapshot | null> {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  async writeSnapshot(snapshot: RoutineSnapshot): Promise<void> {
    // 同步记录 + 同步落库（async 函数体在首个 await 前同步执行），便于测试直接断言。
    this.writeSnapshotCalls.push(cloneSnapshot(snapshot));
    this.snapshot = cloneSnapshot(snapshot);
  }

  async requestNotificationAuthorization(): Promise<boolean> {
    this.requestAuthorizationCallCount += 1;
    return this.authorizationGranted;
  }

  async replaceNotifications(session: RoutineSession | null): Promise<void> {
    this.replaceNotificationsCalls.push(session);
  }

  async presentNotification(payload: NotificationPayload): Promise<void> {
    this.presentNotificationCalls.push({ ...payload });
  }

  async setForegroundReminderReady(ready: boolean): Promise<void> {
    this.foregroundReminderReadyStates.push(ready);
  }

  async parseWithModel(input: string): Promise<ParseResult | null> {
    this.parseWithModelCalls.push(input);
    return this.modelParseResult;
  }

  onSnapshotChanged(cb: (snapshot: RoutineSnapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => {
      this.snapshotListeners.delete(cb);
    };
  }

  onNotificationOpened(cb: (payload: NotificationOpenedPayload) => void): () => void {
    this.notificationListeners.add(cb);
    return () => {
      this.notificationListeners.delete(cb);
    };
  }

  onAppStateChanged(cb: (visible: boolean) => void): () => void {
    this.appStateListeners.add(cb);
    // 订阅时若有已知状态立即回调（与 WebView / 浏览器宿主语义一致）。
    if (this.lastAppState !== null) {
      cb(this.lastAppState);
    }
    return () => {
      this.appStateListeners.delete(cb);
    };
  }

  // ---- 测试辅助：手工推送事件，模拟原生/Watch 侧变更 ----
  emitSnapshotChanged(snapshot: RoutineSnapshot): void {
    for (const listener of this.snapshotListeners) {
      listener(snapshot);
    }
  }

  emitNotificationOpened(payload: NotificationOpenedPayload): void {
    for (const listener of this.notificationListeners) {
      listener(payload);
    }
  }

  emitAppStateChanged(visible: boolean): void {
    this.lastAppState = visible;
    for (const listener of this.appStateListeners) {
      listener(visible);
    }
  }
}

/** 工厂。 */
export function createMockBridge(options: MockBridgeOptions = {}): MockBridge {
  return new MockBridge(options);
}
