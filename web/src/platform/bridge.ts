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
import { withAccountSync } from './account';

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
 * 跨设备共用设置（`settings.read` / `settings.write`）。
 *
 * 高德 Key 必须存在这里而不是 localStorage：Apple Watch 是独立容器，
 * 只有经原生写入 App Group 再走 WCSession，手表上的「一句话创建」才拿得到 Key。
 * 浏览器宿主没有这段通道，读写都降级为「仅本页有效」。
 */
export interface SharedSettings {
  /** 高德 Web 服务 Key。空串表示未配置。 */
  amapKey: string;
  /** 出行方式：`driving` | `walking` | `transit`。 */
  travelMode: string;
}

/** 未配置时的空设置。浏览器宿主的回落值。 */
export const EMPTY_SHARED_SETTINGS: SharedSettings = { amapKey: '', travelMode: 'driving' };

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

  /** 读取跨设备共用设置（高德 Key / 出行方式）。无能力时返回 `EMPTY_SHARED_SETTINGS`。 */
  readSettings(): Promise<SharedSettings>;
  /** 写入并广播给配对设备（手表靠这一步拿到 Key）。无能力时静默 no-op。 */
  writeSettings(settings: SharedSettings): Promise<void>;

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
  return withAccountSync(detectWebViewHost() ? createWebViewBridge() : createBrowserBridge({
    modelProxyURL: typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
      ? (import.meta.env.VITE_MODEL_PROXY_URL || '/api/model/chat/completions')
      : null,
  }));
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
