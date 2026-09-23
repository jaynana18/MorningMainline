/**
 * views/preview/helpers.ts — 预览页（`TaskLinePreviewView` 440–782）的纯展示逻辑。
 *
 * 逐字对齐 `iOS/ContentView.swift`：
 * - `startOfMinute` / `defaultSelectedDeadline` / `defaultSelectedBufferMinutes` ⇄ `init`（447–458）
 * - `planRows` / `planStart` ⇄ `BackwardPlanSummary.planRows`（741–755）
 * - `previewStatus` ⇄ `statusMessage`（661–679）+ `statusSymbol`（682–696）+ `statusColor`（698–702）
 *
 * 本模块**不得** import `core/` 或 `platform/`；所需派生函数全部经 `stores/routine` 门面取用。
 */

import {
  deadlineOn,
  deadlineStep,
  effectiveRecurrence,
  formatMinutes,
  taskSteps,
  totalTaskDuration,
  type RoutineTemplate,
} from '../../stores/routine';

/** 本地时的「该分钟起点」（秒/毫秒归零）——对应 Swift `Calendar.dateInterval(of: .minute).start`。 */
export function startOfMinute(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    0,
    0,
  );
}

/**
 * 复刻 `TaskLinePreviewView.init` 的 `selectedDeadline`（Swift 447–457）：
 * `exactCompletion = now + 总任务时长 + buffer`，再向上取整到**下一分钟**
 * （`minuteStart < exactCompletion ? minuteStart + 1min : minuteStart`）。
 */
export function defaultSelectedDeadline(template: RoutineTemplate, now: Date): Date {
  const exactCompletion = new Date(
    now.getTime() + (totalTaskDuration(template) + template.buffer) * 1000,
  );
  const minuteStart = startOfMinute(exactCompletion);
  return minuteStart.getTime() < exactCompletion.getTime()
    ? new Date(minuteStart.getTime() + 60_000)
    : minuteStart;
}

/** 复刻 `Int(template.buffer / 60)`（Swift `Int` 向零截断）再 `max(0, …)`。 */
export function defaultSelectedBufferMinutes(template: RoutineTemplate): number {
  return Math.max(0, Math.trunc(template.buffer / 60));
}

// --------------------------------------------------------------------------
// 原计划（backward 分支）
// --------------------------------------------------------------------------

/** 原计划截止时刻：`template.deadline(on:) ?? selectedDeadline`（Swift 631–633）。 */
export function originalDeadlineOf(
  template: RoutineTemplate,
  now: Date,
  tz: string,
): Date | null {
  return deadlineOn(template, now, tz);
}

/** 原计划建议开始：`originalDeadline − 总时长 − buffer`（Swift 635–637）。 */
export function originalSuggestedStartOf(template: RoutineTemplate, originalDeadline: Date): Date {
  return new Date(
    originalDeadline.getTime() - (totalTaskDuration(template) + template.buffer) * 1000,
  );
}

/** `effectiveRecurrence == .once && originalDeadline < now`（Swift 639–641）。 */
export function originalIsExpiredOf(
  template: RoutineTemplate,
  originalDeadline: Date,
  now: Date,
): boolean {
  return effectiveRecurrence(template) === 'once' && originalDeadline.getTime() < now.getTime();
}

/** 复刻 `Calendar.current.isDateInTomorrow` —— `date` 是否落在 `now` 的次日（本地日）。 */
export function isDateInTomorrow(date: Date, now: Date): boolean {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return (
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  );
}

export interface PreviewStatus {
  message: string;
  /** SF Symbol 名；由 `iconNameForSymbol` 映射成 web 图标。 */
  symbol: string;
  /** 对应 Swift `statusColor == .red`（糟糕情况）。 */
  isRed: boolean;
}

/**
 * 状态行（消息 + 图标 + 颜色）。
 *
 * 分支顺序**严格**对齐 Swift（消息 661–679、图标 682–696、颜色 698–702）：
 * 1. 原计划过期 → 红 / `calendar.badge.exclamationmark`
 * 2. 顺延到明天 → 红? 否（见下）/ `calendar.badge.clock`
 * 3. 按原计划来不及（`available < totalTaskDuration`）→ 红 / `exclamationmark.triangle.fill`
 * 4. 距建议开始 > 1h → 橙 / `clock.arrow.circlepath`
 * 5. 未到建议开始 → 橙 / `clock.arrow.circlepath`
 * 6. 兜底 → 橙 / `checkmark.circle.fill`
 *
 * 注：Swift `statusColor` 只在「过期」或「来不及」时为红；「顺延到明天」为橙。
 */
export function previewStatus(
  template: RoutineTemplate,
  now: Date,
  originalDeadline: Date,
  originalSuggestedStart: Date,
): PreviewStatus {
  const total = totalTaskDuration(template);
  const isExpired = originalIsExpiredOf(template, originalDeadline, now);
  const availableSeconds = (originalDeadline.getTime() - now.getTime()) / 1000;
  const isTooLate = availableSeconds < total;

  let message: string;
  let symbol: string;
  if (isExpired) {
    message = '原计划时间已经过去。单次计划不会自动顺延，请使用本次计划。';
    symbol = 'calendar.badge.exclamationmark';
  } else if (isDateInTomorrow(originalDeadline, now)) {
    message = '今天的原计划时间已经过去，已自动顺延到明天。也可以按本次计划从现在开始。';
    symbol = 'calendar.badge.clock';
  } else if (isTooLate) {
    const overrun = total - availableSeconds;
    message = `按原计划已经来不及，预计会晚 ${formatMinutes(overrun)}。建议使用本次计划。`;
    symbol = 'exclamationmark.triangle.fill';
  } else if ((originalSuggestedStart.getTime() - now.getTime()) / 1000 > 3600) {
    message = '现在距离原计划建议开始较远。你可以调整本次时间，或按原计划开始。';
    symbol = 'clock.arrow.circlepath';
  } else if (originalSuggestedStart.getTime() > now.getTime()) {
    message = '还没到原计划建议开始时间；现在开始会比原计划更从容。';
    symbol = 'clock.arrow.circlepath';
  } else {
    message = '现在已经进入建议执行时间，选择计划进入后，再开始具体任务。';
    symbol = 'checkmark.circle.fill';
  }

  return { message, symbol, isRed: isExpired || isTooLate };
}

// --------------------------------------------------------------------------
// BackwardPlanSummary（714–782）
// --------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  title: string;
  time: Date;
  isDeadline: boolean;
}

/**
 * 倒推行（Swift 745–755，**注意方向**）：
 * ```
 * cursor = deadline − buffer
 * rows = deadlineStep ? [row(deadlineStep, time: deadline, isDeadline: true)] : []
 * for step of taskSteps.reversed():
 *     cursor += −step.duration
 *     rows.push(row(step, time: cursor, isDeadline: false))
 * return rows.reversed()
 * ```
 * 即 deadline 行时间 = `deadline`（**不减 buffer**），第一个任务行 = `deadline − buffer − Σduration`。
 */
export function planRows(template: RoutineTemplate, deadline: Date, buffer: number): PlanRow[] {
  let cursor = deadline.getTime() - buffer * 1000;
  const rows: PlanRow[] = [];

  const node = deadlineStep(template);
  if (node) {
    rows.push({ id: node.id, title: node.title, time: deadline, isDeadline: true });
  }

  for (const step of [...taskSteps(template)].reverse()) {
    cursor -= step.duration * 1000;
    rows.push({ id: step.id, title: step.title, time: new Date(cursor), isDeadline: false });
  }

  return rows.reverse();
}

/** `LabeledContent("倒推开始")` 的值：`deadline − 总时长 − buffer`（Swift 721–726）。 */
export function planStart(template: RoutineTemplate, deadline: Date, buffer: number): Date {
  return new Date(deadline.getTime() - (totalTaskDuration(template) + buffer) * 1000);
}
