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
import {
  allReminders,
  overdueReminder,
  overdueRound,
  overdueSecondsOf,
  speechText,
  type ReminderMessage,
} from '../core/reminders';
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

/**
 * 超时循环提醒的弹窗停留时长：约几秒自动关闭，之后下一轮再弹。
 *
 * 为什么不一直挂着：常驻不走的弹窗会挡住时间线，而用户可能正需要看它来决定
 * 「砍哪一步」。所以它是**间歇性**的打断（弹 → 自动收 → 过一会再弹），
 * 而不是一个需要用户手动关掉的障碍。
 */
export const OVERDUE_AUTO_DISMISS_MS = 6_000;

/**
 * 超时循环提醒的候选（可见通道）。
 *
 * 与前两类提醒的关键差别：**它不看 `firedKeys` 去重，而是看「第几轮」**。
 * 每一轮有自己的 key（`overdue:<id>:<round>`），所以天然「每 2 分钟重新入队一次」；
 * 反过来，同一轮即使 tick 了很多次也只入队一次。
 *
 * 只对**当前任务**判定（与 `focusedTask` 同口径）：上一项没结束就提醒下一项，
 * 正是本轮要修掉的 bug。
 */
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
  /** 超时弹窗的自动关闭计时器，`stop()` 时统一清理。 */
  const overdueTimers = new Set<ReturnType<typeof setTimeout>>();
  let unsubscribeNotificationOpened: (() => void) | null = null;
  let unsubscribeAppState: (() => void) | null = null;
  let started = false;

  /**
   * **显示**一条弹窗并同步播报。
   *
   * 这是「看的」与「听的」的唯一汇合点 —— 保证两者永远不会错位：
   * 屏幕上出现哪一条，耳朵里听到的就是哪一条；队列里排队的那些**不播**，
   * 等轮到它显示时再播（否则用户会听到一条屏幕上根本没显示的提醒）。
   *
   * 播报正文的**时刻前缀在这里拼**：`new Date()` 取的是「正在播的这一刻」，
   * 而不是 `reminder.fireAt`。超时提醒会持续好几轮，用 `fireAt` 会念出一个
   * 早已过去的时刻，与「现在几点」的诉求正好相反。
   *
   * ⚠️ 不 await：播报是副作用，念多久都不该拖住 tick（`tick` 是 1Hz 驱动的
   * 同步决策点）。桥自身已保证失败静默（§4b.1）。
   */
  function present(reminder: ReminderMessage): void {
    active.value = reminder;
    if (bridge.capabilities.speech) {
      void bridge.speak(speechText(reminder, new Date()));
    }
  }

  /**
   * 入队弹窗：`active` 为空则直接显示，否则压入队列；同 key 不重复入队。
   *
   * 超时提醒额外挂一个自动关闭计时器（弹几秒 → 收起 → 下一轮再弹）。
   */
  function enqueuePopup(reminder: ReminderMessage): void {
    if (
      active.value?.key === reminder.key ||
      queue.value.some((item) => item.key === reminder.key)
    ) {
      return;
    }
    if (active.value === null) {
      present(reminder);
    } else {
      queue.value.push(reminder);
    }
    if (isOverdueReminder(reminder)) {
      scheduleOverdueAutoDismiss(reminder.key);
    }
  }

  /**
   * 给超时弹窗安排自动关闭。
   *
   * ⚠️ 必须**按 key 比对**再关：这几秒内用户可能已经点了「知道了」，
   * 甚至队列里已经换上另一条提醒。不看 key 就会把别人的弹窗关掉。
   *
   * 计时器统一记录在 `overdueTimers` 里，`stop()` 时全部清掉，
   * 免得多实例/热更新下泄漏。
   */
  function scheduleOverdueAutoDismiss(key: string): void {
    const timer = setTimeout(() => {
      overdueTimers.delete(timer);
      if (active.value?.key !== key) {
        // 已经换人（用户关过 / 队列前进）→ 什么都不做。
        return;
      }
      // 队列里还有别的提醒时也让它先播完，不在这里抢。
      if (queue.value.length > 0) {
        return;
      }
      active.value = null;
    }, OVERDUE_AUTO_DISMISS_MS);
    overdueTimers.add(timer);
  }

  /** 是否为超时循环提醒（key 前缀判定，文案单一来源仍归 core）。 */
  function isOverdueReminder(reminder: ReminderMessage): boolean {
    return reminder.key.startsWith('overdue:');
  }

  /** 从 `overdue:<progressID>:<round>` 取出 progressID。 */
  function overdueKeyProgressID(key: string): string {
    return key.split(':')[1] ?? '';
  }

  /**
   * 超时循环提醒的候选。
   *
   * 与前两类提醒的关键差别：**它不看 `firedKeys` 去重，而是看「第几轮」**。
   * 每一轮有自己的 key（`overdue:<id>:<round>`），所以天然「每 2 分钟重新投递一次」；
   * 反过来，同一轮即使 tick 了很多次也只投递一次。
   *
   * 只对**当前任务**判定（与 `focusedTask` 同口径）：上一项没结束就提醒下一项，
   * 正是本轮要修掉的 bug。
   */
  function overdueCandidate(now: Date): ReminderMessage | null {
    const session = routineStore.session;
    if (session === null || session.state !== 'running') {
      return null;
    }
    const current = routineStore.currentProgress;
    if (current === null) {
      return null;
    }
    const seconds = overdueSecondsOf(current, now);
    const round = overdueRound(seconds);
    if (round < 0) {
      return null;
    }
    return overdueReminder(current, session.id, now, round);
  }

  /**
   * 引擎唯一决策点。默认用当前时刻，测试可传固定时刻。
   *
   * 步骤见 ARCHITECTURE §6 与任务规格；两条通道严格互斥：
   * 不可见 → 系统通道；可见 → 弹窗通道（并跳过「引擎未盯着期间」就已到点者）。
   */
  function tick(now: Date = new Date()): void {
    const candidates = allReminders(routineStore.session);
    // 当前会话的 progress id 集合：用来判定一条超时轮次记录是否还有意义。
    const liveProgressIDs = new Set(
      (routineStore.session?.progress ?? []).map((item) => item.id),
    );

    // 裁剪去重集：会话结束/换会话后，旧键不再出现在候选集里 → 自动失效。
    // ⚠️ 超时提醒的 key 不在 `candidates` 里（它按轮次独立判定），不能一并裁掉 ——
    // 否则每 tick 都被裁掉、同一轮反复投递，通知中心会被刷屏。
    // 但也不能无限累积：只保留「其 progress 仍在当前会话里」的那些（换会话/任务删除后回收）。
    firedKeys = new Set(
      [...firedKeys].filter((key) => {
        if (key.startsWith('overdue:')) {
          return liveProgressIDs.has(overdueKeyProgressID(key));
        }
        return candidates.some((candidate) => candidate.key === key);
      }),
    );

    const due = candidates.filter(
      (reminder) => reminder.fireAt.getTime() <= now.getTime() && !firedKeys.has(reminder.key),
    );

    // 超时循环提醒：独立于 `candidates` 判定（它按「轮次」而非一次性去重）。
    const overdue = overdueCandidate(now);

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
      // 不可见时超时提醒同样交系统通道。
      // ⚠️ 用 `firedKeys` 记已投递的**轮次**：本分支每次 tick 都会走到，
      // 不记的话同一轮会在 1Hz 下被投递无数次（通知中心被刷屏）。
      if (overdue !== null && !firedKeys.has(overdue.key)) {
        if (bridge.capabilities.backgroundNotification) {
          // 原生已预排了一串超时重复通知（`scheduleOverdueRepeats`），只标记。
        } else {
          void bridge.presentNotification({
            title: overdue.title,
            body: overdue.body,
            level: overdue.level,
          });
        }
        firedKeys.add(overdue.key);
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

    // 超时循环：`round` 变化即重新弹一次；同一轮内 tick 多次只弹一次。
    // 不走 `staleForNow` 闸门 —— 超时越久越要提醒，正是那两道闸门要防的相反情形。
    if (overdue !== null && !firedKeys.has(overdue.key)) {
      firedKeys.add(overdue.key);
      enqueuePopup(overdue);
      stats.value.local += 1;
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
    for (const pending of overdueTimers) {
      clearTimeout(pending);
    }
    overdueTimers.clear();
    unsubscribeAppState?.();
    unsubscribeAppState = null;
    unsubscribeNotificationOpened?.();
    unsubscribeNotificationOpened = null;
    watchedSince = null;
    started = false;
  }

  /** 关闭当前弹窗；队列非空则显示下一条（并同步播报下一条）。 */
  function dismiss(): void {
    if (queue.value.length > 0) {
      // 经 present 而非直接赋值：队列前进也是「一条新提醒开始显示」，
      // 漏掉这里就会出现「看得见、听不到」的哑巴弹窗。
      present(queue.value.shift()!);
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
