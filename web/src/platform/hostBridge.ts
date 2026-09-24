/**
 * platform/hostBridge.ts — 模块级单例宿主桥。
 *
 * 为什么需要：`bridge.ts` 的 `createBridge()` 每次调用都 new 一个实现。
 * 而 `WebViewBridge` 的 `install()` 会把自己挂到 `window.__mainlineReply` /
 * `window.__mainlineEmit`（单一全局槽位）——多实例会互相覆盖，先建的那个实例的
 * 所有 pending 调用将永远等不到回执，逐个静默超时。
 * 故宿主桥必须全进程唯一：所有 store 都经此取桥。
 */

import { createBridge, type PlatformBridge } from './bridge';

let instance: PlatformBridge | null = null;

/** 取全进程唯一的宿主桥（首次调用时按 §3 规则探测宿主）。 */
export function resolveBridge(): PlatformBridge {
  if (instance === null) {
    instance = createBridge();
  }
  return instance;
}
