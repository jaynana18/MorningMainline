/**
 * platform/bridge.ts — 双宿主能力收口（ARCHITECTURE §1 / §3 / §4b.1）。
 *
 * 同一份 Vue 代码在两种宿主下能力不同，差异**只在这里**收口；core 层与视图层
 * 禁止感知宿主。宿主探测规则（§3）：
 *   `window.webkit?.messageHandlers?.mainline` 存在 ⇒ WebView 宿主；否则浏览器宿主。
 *
 * 本文件只放「接口 + 能力矩阵 + 探测工厂」，具体实现在 webview.ts / browser.ts / mock.ts。
 * 为避免运行时循环依赖，实现侧只从这里 `import type`（编译期擦除），
 * 工厂侧（本文件）才从实现侧 import 值。
 */

import type {
  DeviceRole,
  ParseResult,
  RoutineSession,
  RoutineSnapshot,
} from '../core/types';
import { createBrowserBridge } from './browser';
import { createWebViewBridge } from './webview';

/** 设备信息（§3 方法表 `device.info`）。 */
export interface DeviceInfo {
  id: string;
  role: DeviceRole;
}

/**
 * 宿主能力矩阵（§1）。四格与宿主一一对应：
 * - WebView：watchSync=true / backgroundNotification=true / modelParsing=看原生是否接入 / widget=true
 * - 浏览器：watchSync=false / backgroundNotification=仅前台 / modelParsing=看代理 / widget=false
 */
export interface BridgeCapabilities {
  /** Apple Watch 同步：WebView=true，浏览器=false（物理边界）。 */
  watchSync: boolean;
  /** 后台/锁屏系统通知：WebView=true；浏览器仅在 Web Push 可用时为 true。 */
  backgroundNotification: boolean;
  /** 是否有可用的云端语义解析（原生代发 / 后端代理）。 */
  modelParsing: boolean;
  /** 主屏小组件 / 表盘：WebView=true，浏览器=false。 */
  widget: boolean;
}

/** 通知级别（`notifications.present`）。 */
export interface NotificationPayload {
  title: string;
  body: string;
  level?: 'normal' | 'timeSensitive';
}

/** 通知点击回跳负载（事件 `notification.opened`）。 */
export interface NotificationOpenedPayload {
  progressID?: string;
  sessionID?: string;
  minuteOffset?: number;
}

/**
 * 平台桥接口（§4b.1，冻结）。
 *
 * 所有方法在宿主能力不足时**必须降级**（返回 `null` / `false` / 静默 no-op），
 * 绝不可抛错令 UI 卡死（§4b.1 硬性要求）。
 */
export interface PlatformBridge {
  readonly host: 'webview' | 'browser';
  readonly capabilities: BridgeCapabilities;

  deviceInfo(): Promise<DeviceInfo>;
  readSnapshot(): Promise<RoutineSnapshot | null>;
  writeSnapshot(snapshot: RoutineSnapshot): Promise<void>;

  requestNotificationAuthorization(): Promise<boolean>;
  replaceNotifications(session: RoutineSession | null): Promise<void>;
  presentNotification(payload: NotificationPayload): Promise<void>;
  /** 告知原生前台页内提醒通道是否已就绪；未就绪时原生保留系统横幅兜底。 */
  setForegroundReminderReady(ready: boolean): Promise<void>;

  /** 云端语义解析。宿主无能力时 resolve(null)，调用方静默回退纯规则。 */
  parseWithModel(input: string): Promise<ParseResult | null>;

  /** 返回取消订阅函数。 */
  onSnapshotChanged(cb: (snapshot: RoutineSnapshot) => void): () => void;
  onNotificationOpened(cb: (payload: NotificationOpenedPayload) => void): () => void;
  /** App/页面前后台状态变化（事件 `app.state`）。返回取消订阅函数。
   *  订阅时会**立即**收到当前已知状态（若已知），随后每次变化再回调。 */
  onAppStateChanged(cb: (visible: boolean) => void): () => void;
}

/**
 * 探测宿主并返回对应实现。
 *
 * 注意：探测必须在**调用时**（而非模块加载时）进行，以便单测/SSR 环境无 `window` 时安全回落到浏览器实现。
 */
export function createBridge(): PlatformBridge {
  return detectWebViewHost() ? createWebViewBridge() : createBrowserBridge();
}

/** WebView 宿主探测（§3 唯一判据）。 */
function detectWebViewHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const webkit = (window as unknown as {
    webkit?: { messageHandlers?: { mainline?: unknown } };
  }).webkit;
  return Boolean(webkit?.messageHandlers?.mainline);
}
