/**
 * views/reminder/helpers.ts — P3 视图层提醒的**纯函数缝**（唯一可测处）。
 *
 * 环境约束：`vitest.config.ts` 是 `environment: 'node'`（无 DOM），因此把
 * 「回跳裁决」与「弹窗小字标签」抽成纯函数导出，供 `tests/reminder-overlay.test.ts`
 * 直接测；`ReminderOverlay.vue` 只做渲染与事件转发。
 *
 * 架构约束（ARCHITECTURE §6）：弹窗显示的正文必须**逐字**来自 `core/reminders.ts`
 * 产出的 `title` / `body`（文案单一来源）。本文件只负责「小字标签」这一附加 UI，
 * **绝不**改写、拼接或加工 `title` / `body`。
 */

import type { FocusRequest, ReminderMessage } from '../../stores/reminders';

/** 通知点击回跳的裁决结果。 */
export type FocusAction = 'ignore' | 'navigate' | 'stale';

/** 判定回跳是否「属于当前这次执行」所需的上下文。 */
export interface FocusContext {
  /** 当前活动会话 id；无进行中会话时为 null。 */
  sessionID: string | null;
  /** 当前活动会话的全部进度项 id；无会话时为 []。 */
  progressIDs: readonly string[];
}

/**
 * 通知点击回跳的裁决。
 *
 * ⚠️ 为何需要 `progressIDs`：原生 `ReminderScheduler` 的**每个 task 通知**
 * `userInfo` 只带 `progressID`（**不带 sessionID**），只有 8 个 deadline 里程碑带
 * `sessionID`。因此单靠 sessionID 判定会让绝大多数回跳恒为 'navigate'。
 * 故对 task 回跳改用「该 progressID 是否仍属于当前会话」来判 stale。
 *
 * - `request === null` → 'ignore'
 * - 带 sessionID 且与当前不等 → 'stale'（里程碑回跳，或会话已换）
 * - 带 progressID 但不在当前会话的 progress 里 → 'stale'
 *   （该任务所属的会话已结束/已被替换，或该进度项已从本次计划中删除）
 * - 其余 → 'navigate'
 *
 * @param request 待消费的通知回跳请求，或 null
 * @param context 当前执行的上下文（会话 id + 进度项 id 集合）
 */
export function resolveFocusAction(
  request: FocusRequest | null,
  context: FocusContext,
): FocusAction {
  if (request === null) {
    return 'ignore';
  }
  if (request.sessionID !== null && request.sessionID !== context.sessionID) {
    return 'stale';
  }
  if (request.progressID !== null && !context.progressIDs.includes(request.progressID)) {
    return 'stale';
  }
  return 'navigate';
}

/**
 * 弹窗标题：里程碑按紧急度给标签，普通任务提醒给「到点了」。
 *
 * ⚠️ 这里返回的只是卡片顶部的**小字标签**；`message.title` 本身已经是权威文案，
 * 本函数**不得**改写或拼接 `title` / `body`。
 *
 * 规则（逐字，不得改写）：
 * - `minuteOffset !== null` 且 `sound === 'overdue'` → `'Deadline 已延误'`
 * - `minuteOffset !== null` 且 `sound === 'default'` → `'Deadline 临近'`
 * - 否则（`minuteOffset === null`，即 task 提醒）→ `'该做下一件事了'`
 */
export function reminderHeading(message: ReminderMessage): string {
  if (message.minuteOffset !== null) {
    return message.sound === 'overdue' ? 'Deadline 已延误' : 'Deadline 临近';
  }
  return '该做下一件事了';
}
