/**
 * stores/reminders.ts — 提醒引擎（ARCHITECTURE §6，P3）。
 *
 * 职责：把 `core/reminders.ts` 的**全量候选提醒**按时间与可见性投递到两条通道：
 * - 前台可见 → 应用内弹窗（`active` / `queue`，由视图层渲染）；
 * - 后台/不可见 → 系统通知（`bridge.presentNotification`，原生能力可用时由
 *   `ReminderScheduler` 自行排期、这里只标记）。
 *
 * 设计要点：
 * - **文案单一来源**：本模块只调用 `core/reminders.ts`，绝不复制任何文案。
 * - **决策点唯一**：所有判断集中在公开的 `tick(now)`；计时器只是它的驱动。
 *   测试直接调 `tick(固定时刻)`，不依赖 `setInterval`。
 * - **前台去重**（§6）分两层：
 *   1. 第一层（本模块）：不可见 → 系统通道，可见 → 弹窗通道，互不重复；
 *   2. 第二层（`platform/browser.ts` / 原生 `willPresent`）：系统通道自身再判一次可见性。
 * - **不补弹过时提醒**：`watchedSince` 记录「引擎开始盯着」的时刻；任何在其之前
 *   就已到点的提醒都不会补弹窗（那段时间由另一条通道负责，或页面本就没开）。
 *
 * 视图层只 import 本模块（不 import `core/` 或 `platform/`）。
 */

import { ref } from 'vue';
import { defineStore } from 'pinia';
import { allReminders, type ReminderMessage } from '../core/reminders';
import type { PlatformBridge } from '../platform/bridge';
import { resolveStoreBridge, useRoutineStore } from './routine';

// 重导出：视图层经本模块取用提醒数据类型（避免直接 import core/）。
// `ReminderOverlay.vue` 及其纯函数缝 `views/reminder/helpers.ts` 依赖这两个导出。
export type { ReminderMessage } from '../core/reminders';

/** 通知回跳请求（系统通知被点击后，经 `notification.opened` 事件写入）。 */
export interface FocusRequest {
  progressID: string | null;
  sessionID: string | null;
  minuteOffset: number | null;
  /** 收到回跳的时刻（供 App.vue/SessionView 的 watch 做一次性消费）。 */
  at: Date;
}

/** 1Hz。与 page 端 useNow 同频；Swift 的 TimelineView(.periodic by: 1) 同频。 */
export const REMINDER_TICK_MS = 1000;

/** 前台可见时，到点已超过此时长的提醒不再弹窗（避免补弹一堆过时提醒）。 */
export const VISIBLE_CATCH_UP_MS = 90_000;

export const useRemindersStore = defineStore('reminders', () => {
  const routineStore = useRoutineStore();
  const bridge: PlatformBridge = resolveStoreBridge();

  // ---- state ----
  /**
   * 页面可见性。默认 true（桥回调到达前按前台处理）。来源是桥的 `app.state` 事件
   * （`onAppStateChanged`），不再自行读 `document.visibilityState` —— 后者在 iOS WKWebView
   * 里不可靠（后台可能不派发 `visibilitychange`）。外部/测试仍可直接赋值以构造决策用例。
   */
  const visible = ref(true);
  /** 当前显示的弹窗（同一时刻至多一条）。 */
  const active = ref<ReminderMessage | null>(null);
  /** 待显示队列（FIFO）。 */
  const queue = ref<ReminderMessage[]>([]);
  /** 通知回跳请求（供视图一次性消费）。 */
  const focusRequest = ref<FocusRequest | null>(null);
  /** 三通道计数（可观测性 + 测试）。 */
  const stats = ref({ local: 0, system: 0, skipped: 0 });

  /** 已处理提醒的去重键（非响应式）。会话结束/换会话后按候选集自动裁剪。 */
  let firedKeys = new Set<string>();
  /** 「引擎开始盯着」的时刻；null 表示引擎未在盯着（未 start / 已 stop）。 */
  let watchedSince: Date | null = null;

  // ---- 运行时句柄 ----
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeNotificationOpened: (() => void) | null = null;
  let unsubscribeAppState: (() => void) | null = null;
  let started = false;

  /** 入队弹窗：`active` 为空则直接显示，否则压入队列；同 key 不重复入队。 */
  function enqueuePopup(reminder: ReminderMessage): void {
    if (
      active.value?.key === reminder.key ||
      queue.value.some((item) => item.key === reminder.key)
    ) {
      return;
    }
    if (active.value === null) {
      active.value = reminder;
    } else {
      queue.value.push(reminder);
    }
  }

  /**
   * 引擎唯一决策点。默认用当前时刻，测试可传固定时刻。
   *
   * 步骤见 ARCHITECTURE §6 与任务规格；两条通道严格互斥：
   * 不可见 → 系统通道；可见 → 弹窗通道（并跳过「引擎未盯着期间」就已到点者）。
   */
  function tick(now: Date = new Date()): void {
    const candidates = allReminders(routineStore.session);

    // 裁剪去重集：会话结束/换会话后，旧键不再出现在候选集里 → 自动失效。
    firedKeys = new Set(
      [...firedKeys].filter((key) => candidates.some((candidate) => candidate.key === key)),
    );

    const due = candidates.filter(
      (reminder) => reminder.fireAt.getTime() <= now.getTime() && !firedKeys.has(reminder.key),
    );

    if (!visible.value) {
      for (const reminder of due) {
        if (bridge.capabilities.backgroundNotification) {
          // 原生 ReminderScheduler 已排了这条；只标记，不投递（避免前台重复打扰）。
        } else {
          // 浏览器宿主无 Web Push：当场发一条系统通知，充当后台通道。
          void bridge.presentNotification({
            title: reminder.title,
            body: reminder.body,
            level: reminder.level,
          });
        }
        firedKeys.add(reminder.key);
        stats.value.system += 1;
      }
      return;
    }

    for (const reminder of due) {
      const staleForEngine =
        watchedSince !== null && reminder.fireAt.getTime() < watchedSince.getTime();
      // 兜住「页面可见但 JS 被冻结」的恢复突发（笔记本合盖休眠、主线程被长任务阻塞、
      // 标签页虽 visible 但被系统节流）：此时 watchedSince 不会更新，若只看它会把冻结期间
      // 到点的一整批提醒一次性补弹出来。本 App 的价值是「现在该做什么」，不是「补播错过的
      // 时间线」；过时提醒的实际状态已由 TimelineCard 的预计时间/延误标记体现，弹一串过时
      // 弹窗只会制造噪音。故到点已超过 VISIBLE_CATCH_UP_MS 的不再弹窗。
      const staleForNow = now.getTime() - reminder.fireAt.getTime() > VISIBLE_CATCH_UP_MS;
      if (staleForEngine || staleForNow) {
        // 引擎没盯着期间到点，或早已过时：不补弹窗（stats.skipped 保留可观测性）。
        stats.value.skipped += 1;
      } else {
        enqueuePopup(reminder);
        stats.value.local += 1;
      }
      firedKeys.add(reminder.key);
    }
  }

  /**
   * 应用一次前后台状态（来源：桥的 `app.state` 事件）。
   *
   * 注意顺序：hidden → visible 时**先**重置 `watchedSince` **再** tick，否则会把
   * 刚切换瞬间就已过期的提醒也补弹出来。
   */
  function applyVisibility(next: boolean): void {
    if (next === visible.value) {
      return;
    }
    const wasHidden = !visible.value;
    visible.value = next;
    if (wasHidden && next) {
      watchedSince = new Date();
    }
    tick();
  }

  /** 启动引擎（幂等）。数据未就绪时仍启动计时器 —— 提醒不能因 init 失败而整个不工作。 */
  async function start(): Promise<void> {
    if (started) {
      return;
    }
    started = true;

    try {
      await routineStore.ensureReady();
    } catch {
      routineStore.notice = '数据还没准备好，请稍后再试。';
    }

    watchedSince = new Date();

    unsubscribeNotificationOpened = bridge.onNotificationOpened((payload) => {
      focusRequest.value = {
        progressID: payload.progressID ?? null,
        sessionID: payload.sessionID ?? null,
        minuteOffset: payload.minuteOffset ?? null,
        at: new Date(),
      };
    });

    // 前后台由桥驱动（`app.state` 事件）。桥会在订阅时**立即回调当前态**，
    // 故不再手动读 `document.visibilityState`（在 iOS WKWebView 里不可靠）。
    unsubscribeAppState = bridge.onAppStateChanged(applyVisibility);

    timer = setInterval(() => tick(), REMINDER_TICK_MS);
    tick();

    // 订阅、计时器和首次 tick 都已就位。从这一刻起，前台提醒由页内弹窗承接，
    // 原生可以安全抑制横幅。
    void bridge.setForegroundReminderReady(true);
  }

  /** 停止引擎（幂等）。清计时器、退订。 */
  function stop(): void {
    // 先撤销 ready：若卸载窗口内恰好有系统通知到达，应让原生横幅兜底，不能静默吞掉。
    void bridge.setForegroundReminderReady(false);
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    unsubscribeAppState?.();
    unsubscribeAppState = null;
    unsubscribeNotificationOpened?.();
    unsubscribeNotificationOpened = null;
    watchedSince = null;
    started = false;
  }

  /** 关闭当前弹窗；队列非空则显示下一条。 */
  function dismiss(): void {
    if (queue.value.length > 0) {
      active.value = queue.value.shift()!;
    } else {
      active.value = null;
    }
  }

  /** 关闭全部弹窗（连同队列）。 */
  function dismissAll(): void {
    active.value = null;
    queue.value = [];
  }

  /** 视图消费完通知回跳后清空。 */
  function clearFocusRequest(): void {
    focusRequest.value = null;
  }

  return {
    // state
    visible,
    active,
    queue,
    focusRequest,
    stats,
    // actions
    start,
    stop,
    tick,
    dismiss,
    dismissAll,
    clearFocusRequest,
  };
});
