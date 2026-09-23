/**
 * views/session/useNow.ts — 每秒刷新的「当前时间」源。
 *
 * 对应 Swift 各卡片里的 `TimelineView(.periodic(from: .now, by: 1))`：倒计时、预计结束、
 * 迟到判定都需要每秒重算。整个会话页共用一个 `now`，避免多个定时器各跑一套。
 *
 * 生命周期：定时器**必须在组件卸载时清理**（`onUnmounted`），否则会泄漏。
 */

import { onUnmounted, ref, type Ref } from 'vue';

/** 返回一个每秒自增的 `now`；组件卸载时自动清定时器。 */
export function useNow(intervalMs = 1000): Ref<Date> {
  const now = ref(new Date());
  const timer = setInterval(() => {
    now.value = new Date();
  }, intervalMs);

  onUnmounted(() => {
    clearInterval(timer);
  });

  return now;
}
