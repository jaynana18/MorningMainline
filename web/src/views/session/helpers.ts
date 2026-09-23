/**
 * views/session/helpers.ts — 会话页的纯展示逻辑。
 *
 * 逐字对齐 `iOS/ContentView.swift`：
 * - `formatClock` ⇄ `Date.formatted(date: .omitted, time: .shortened)`（24 小时 HH:mm）
 * - `CompletionResult` / `makeCompletionResult` ⇄ `CompletionResult`（236–270）
 * - `reorderableItems` ⇄ `TimelineCard.reorderableItems(in:)`（1052–1058）
 *
 * 这里只放「视图胶水」。core 已提供 `estimatedCompletion` / `estimatedDueDates` /
 * `isLate` / `originalDueAt` 等纯函数，视图层经 `stores/routine` 门面取用；
 * 本模块**不得** import `core/` 或 `platform/`。
 */

import { isIncomplete, type RoutineSession, type StepProgress } from '../../stores/routine';

/** 复刻 Swift `Date.formatted(date: .omitted, time: .shortened)` → 24 小时零填充 HH:mm。 */
export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * 完成结算浮层的数据模型（对应 Swift `CompletionResult`，236–270）。
 *
 * Swift 用 `Identifiable.id = UUID()` 只为 `.sheet` 的展示身份，Web 端以会话 id 即可，
 * 故不额外生成随机 id；派生字段在构造时一次算清，模板直接读。
 */
export interface CompletionResult {
  /** 对应 Swift `sessionID`：用于「同一次会话只弹一次」。 */
  sessionID: string;
  targetDeadline: Date | null;
  completedAt: Date;
  /** offset > 0。无 deadline 时为 false（对应 Swift `(offset ?? 0) > 0`）。 */
  isAhead: boolean;
  headline: string;
  emphasis: string;
  /** 原计划时间（HH:mm）；无 deadline 时为 null。 */
  plannedTime: string | null;
}

/**
 * 由会话构造结算结果（对应 Swift `CompletionResult.init(session:)` 236–246）。
 *
 * `completedAt = 所有已完成步骤里最大的 completedAt`（Swift `compactMap(\.completedAt).max()`，
 * 空集合时回落 `Date()`）。
 */
export function makeCompletionResult(
  session: RoutineSession,
  fallbackNow: Date = new Date(),
): CompletionResult {
  const completedTimes = session.progress
    .map((item) => item.completedAt)
    .filter((value): value is Date => value !== null)
    .map((value) => value.getTime());
  const completedAt =
    completedTimes.length > 0 ? new Date(Math.max(...completedTimes)) : fallbackNow;

  const targetDeadline = session.targetDeadline;
  // 换算成秒，口径与 Swift `TimeInterval` 一致（`abs(offset) < 60` 判「刚好」）。
  const offsetSeconds =
    targetDeadline !== null ? (targetDeadline.getTime() - completedAt.getTime()) / 1000 : null;

  const isAhead = (offsetSeconds ?? 0) > 0;

  let headline: string;
  if (offsetSeconds === null) {
    headline = '恭喜你，完成啦';
  } else if (Math.abs(offsetSeconds) < 60) {
    headline = '恭喜你，刚刚好完成';
  } else {
    headline = offsetSeconds > 0 ? '恭喜你，成功提前了' : '很遗憾，你本次延误了';
  }

  let emphasis: string;
  if (offsetSeconds === null) {
    emphasis = '完成';
  } else if (Math.abs(offsetSeconds) < 60) {
    emphasis = '准时';
  } else {
    // Swift `Int(abs(offset)/60)` 向零截断；再 `max(1, ...)` 保证至少 1 分钟。
    emphasis = `${Math.max(1, Math.trunc(Math.abs(offsetSeconds) / 60))} 分钟`;
  }

  return {
    sessionID: session.id,
    targetDeadline,
    completedAt,
    isAhead,
    headline,
    emphasis,
    plannedTime: targetDeadline !== null ? formatClock(targetDeadline) : null,
  };
}

/**
 * 可重排的待办项：未完成 + role==task + 非当前 active 项
 * （对应 Swift `TimelineCard.reorderableItems(in:)` 1052–1058）。
 */
export function reorderableItems(session: RoutineSession): StepProgress[] {
  return session.progress.filter(
    (item) =>
      isIncomplete(item.state) &&
      item.step.role === 'task' &&
      item.id !== session.activeProgressID,
  );
}
