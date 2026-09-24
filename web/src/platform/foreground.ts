/**
 * platform/foreground.ts — 页面前台可见性判定（ARCHITECTURE §6 前台去重）。
 *
 * 前台去重分两层：
 * - 第一层在 `stores/reminders.ts` 的提醒引擎里（页面可见 → 应用内弹窗，不可见 → 系统通知）；
 * - 第二层（本模块）是宿主侧的兜底闸门，防止系统通知与应用内弹窗对同一条提醒重复打扰。
 *
 * 判定与宿主无关：WebView 与浏览器都用 `document.visibilityState`。
 * 非 DOM 环境（vitest 的 node 环境）一律按前台处理（返回 `true`）——无 `document` 可读时，
 * 宁可少发一条系统通知，也不要在未知可见性下错误打扰。
 *
 * 注意：本模块**不得**在加载期访问 `document`，以便在 Node 单测环境安全 import（沿用 browser.ts 约定）。
 */

/** 页面是否处于前台可见状态。宿主无关：两种宿主都用 `document.visibilityState`。 */
export function isPageForeground(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.visibilityState === 'visible';
}
