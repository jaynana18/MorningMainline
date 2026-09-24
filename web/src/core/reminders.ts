/**
 * core/reminders.ts — 提醒文案的**单一来源**（Swift → TypeScript 逐字移植）。
 *
 * 对应真相来源：`Shared/Services/ReminderScheduler.swift`（115 行）。
 *
 * 设计约束（ARCHITECTURE §4 / §5）：
 * - 本文件是 P3「应用内弹窗」与「系统通知」两条通道**共用**的唯一文案来源。
 *   页内弹窗（Vue 组件）与系统通知（`bridge.presentNotification` / 原生
 *   `ReminderScheduler`）都必须调用这里的生成函数，禁止在视图层或 platform 层各写一份。
 * - 因此本模块属于 `core/`：**纯函数、零平台 API 依赖**。
 *   严禁 import `../platform/*`，严禁访问 `window` / `document` / `Notification`。
 * - 文案逐字复刻 Swift，含中文标点（`：` / `“ ”` 全角引号 / `·`）与 emoji（`⏰` / `🚨`）。
 *   这些都不是装饰，是测试要抓的「文案漂移」锚点。
 */

import type { RoutineSession, StepProgress } from './types';
import { isIncomplete } from './session';

// ---------------------------------------------------------------------------
// 类型（签名已与调用方约定冻结）
// ---------------------------------------------------------------------------

/** 提醒级别：映射自 Swift 的 `interruptionLevel`。 */
export type ReminderLevel = 'normal' | 'timeSensitive';

/** 声音意图：Swift 里 `minuteOffset < 0` 用 `.default`，`>= 0` 用自定义音
 *  `deadline-overdue.aiff`。仅供页内弹窗区分紧急度。 */
export type ReminderSound = 'default' | 'overdue';

export interface ReminderMilestone {
  minuteOffset: number;
  label: string;
}

export interface ReminderMessage {
  /** 稳定去重键。task → `task:<progressID>:due`；milestone → `deadline:<sessionID>:<minuteOffset>`。 */
  key: string;
  title: string;
  body: string;
  /** 映射自 interruptionLevel：task 提醒为 'normal'（Swift 未设，即默认 .active）；
   *  全部 8 个里程碑为 'timeSensitive'（Swift 第 96 行在 if/else 之后统一设置）。 */
  level: ReminderLevel;
  /** 声音意图（仅供页内弹窗区分紧急度；platform/bridge.ts 的 NotificationPayload 只带 level）。 */
  sound: ReminderSound;
  /** 该提醒应有的触发时刻。 */
  fireAt: Date;
  /** 里程碑才有；task 提醒为 null。 */
  minuteOffset: number | null;
  /** task 提醒才有；里程碑为 null。 */
  progressID: string | null;
  sessionID: string;
}

// ---------------------------------------------------------------------------
// 里程碑表（逐字复刻 ReminderScheduler.swift:60-69，顺序不可改）
// ---------------------------------------------------------------------------

/** 8 个 deadline 里程碑。顺序即 Swift 声明顺序，不得重排。 */
export const DEADLINE_MILESTONES: readonly ReminderMilestone[] = [
  { minuteOffset: -10, label: '还剩 10 分钟' },
  { minuteOffset: -5, label: '还剩 5 分钟' },
  { minuteOffset: -3, label: '还剩 3 分钟' },
  { minuteOffset: -1, label: '还剩 1 分钟' },
  { minuteOffset: 0, label: '计划时间到了' },
  { minuteOffset: 2, label: '已延误 2 分钟' },
  { minuteOffset: 4, label: '已延误 4 分钟' },
  { minuteOffset: 6, label: '已延误 6 分钟' },
];

/** 里程碑统一使用的时间敏感级别（Swift 第 96 行，写在 if/else 之后）。 */
const MILESTONE_LEVEL: ReminderLevel = 'timeSensitive';
/** 里程碑统一使用的 threadIdentifier（Swift 第 95 行）。页内弹窗可据此归类。 */
const MILESTONE_THREAD_ID = 'morning-mainline-deadline';

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------

/**
 * 当前正在推进的任务标题：`progress.id === activeProgressID && state === 'active'`，
 * 否则 null。复刻 ReminderScheduler.swift:75-77。
 */
export function activeTaskTitle(session: RoutineSession): string | null {
  const active = session.progress.find(
    (progress) => progress.id === session.activeProgressID && progress.state === 'active',
  );
  return active?.step.title ?? null;
}

/**
 * 单个 task 的提醒（复刻 ReminderScheduler.swift:33-53）。
 *
 * 只在 `progress.step.role === 'task'` **且** `progress.state` 未完成
 * （用 core/session.ts 的 `isIncomplete`）时返回，否则返回 null。
 *
 * 注意：**不做 dueAt 时间过滤**（Swift 的 `progress.dueAt > now` 由 `planReminders` 负责）。
 *
 * @param progress 进度项
 * @param sessionID 所属会话 id（用于 key / 关联）
 */
export function taskReminder(progress: StepProgress, sessionID: string): ReminderMessage | null {
  if (progress.step.role !== 'task' || !isIncomplete(progress.state)) {
    return null;
  }
  return {
    key: `task:${progress.id}:due`,
    title: `不跑偏 · ${progress.step.title}`,
    body: progress.step.prompt,
    // Swift 未设置 interruptionLevel → 默认 .active，此处映射为 'normal'。
    level: 'normal',
    sound: 'default',
    fireAt: progress.dueAt,
    minuteOffset: null,
    progressID: progress.id,
    sessionID,
  };
}

/**
 * 单个 deadline 里程碑的提醒（复刻 ReminderScheduler.swift:75-100 三形态）。
 *
 * `currentTaskTitle` 为 null 时走 Swift 的 `?? ` 兜底分支。
 * `fireAt` 由调用方算好传入（= targetDeadline + minuteOffset * 60 秒）。
 *
 * 三形态：
 * - `minuteOffset < 0`：`不跑偏 · 距离 Deadline <label>`，声音 .default。
 * - `minuteOffset === 0`：`⏰ Deadline 到了`，声音 overdueSound。
 * - `minuteOffset > 0`：`🚨 Deadline <label>`，声音 overdueSound。
 */
export function deadlineMilestoneReminder(
  minuteOffset: number,
  label: string,
  currentTaskTitle: string | null,
  sessionID: string,
  fireAt: Date,
): ReminderMessage {
  let title: string;
  let body: string;
  let sound: ReminderSound;

  if (minuteOffset < 0) {
    title = `不跑偏 · 距离 Deadline ${label}`;
    body =
      currentTaskTitle !== null
        ? `当前任务：${currentTaskTitle}`
        : '请确认最重要的任务正在推进。';
    sound = 'default';
  } else if (minuteOffset === 0) {
    title = '⏰ Deadline 到了';
    body =
      currentTaskTitle !== null
        ? `当前任务“${currentTaskTitle}”还没完成，请先回到主线。`
        : '计划还没有完成，请先回到主线。';
    sound = 'overdue';
  } else {
    title = `🚨 Deadline ${label}`;
    body =
      currentTaskTitle !== null
        ? `当前任务“${currentTaskTitle}”仍未完成，请先把它收尾。`
        : '计划仍未完成，请立即回到主线。';
    sound = 'overdue';
  }

  return {
    key: `deadline:${sessionID}:${minuteOffset}`,
    title,
    body,
    // Swift 第 96 行在 if/else 之后对全部 8 个里程碑统一设置 .timeSensitive。
    level: MILESTONE_LEVEL,
    sound,
    fireAt,
    minuteOffset,
    progressID: null,
    sessionID,
  };
}

/**
 * 构建该会话的**全量候选**提醒（不做时间过滤）。私有，供
 * `allReminders` / `planReminders` 共用。
 *
 * 顺序 = Swift 声明顺序：
 * 1. 先按 `session.progress` 顺序输出所有未完成 task 的提醒；
 * 2. 再按 `DEADLINE_MILESTONES` 表序输出 8 个里程碑。
 *
 * 前置条件（任一条不满足则 return 相应空结果）：
 * - `session === null` 或 `session.state !== 'running'` → 无任何提醒。
 * - 里程碑额外要求：`targetDeadline !== null` **且** 存在未完成项且其 role 为
 *   `task` 或 `deadline`（deadline 项本身也算数）。否则不产出里程碑（task 提醒不受影响）。
 */
function buildReminders(session: RoutineSession | null): ReminderMessage[] {
  if (session === null || session.state !== 'running') {
    return [];
  }

  const incomplete = session.progress.filter((progress) => isIncomplete(progress.state));
  const result: ReminderMessage[] = [];

  // 1) 未完成 task 的提醒（顺序 = session.progress 顺序）。
  for (const progress of incomplete) {
    const reminder = taskReminder(progress, session.id);
    if (reminder !== null) {
      result.push(reminder);
    }
  }

  // 2) deadline 里程碑（顺序 = DEADLINE_MILESTONES 表序）。
  const hasTaskOrDeadlineIncomplete = incomplete.some(
    (progress) => progress.step.role === 'task' || progress.step.role === 'deadline',
  );
  const targetDeadline = session.targetDeadline;
  if (targetDeadline !== null && hasTaskOrDeadlineIncomplete) {
    const currentTaskTitle = activeTaskTitle(session);
    for (const milestone of DEADLINE_MILESTONES) {
      const fireAt = new Date(
        targetDeadline.getTime() + milestone.minuteOffset * 60 * 1000,
      );
      result.push(
        deadlineMilestoneReminder(
          milestone.minuteOffset,
          milestone.label,
          currentTaskTitle,
          session.id,
          fireAt,
        ),
      );
    }
  }

  return result;
}

/**
 * 该会话的**全量候选**提醒（不做时间过滤）。
 * 顺序见 `buildReminders`。前置条件不满足时返回空数组。
 */
export function allReminders(session: RoutineSession | null): ReminderMessage[] {
  return buildReminders(session);
}

/**
 * 等价于 Swift 实际排入通知中心的那一批：只保留 `fireAt > now` 的项。
 * （用于对照原生排期与写测试。）
 *
 * 复刻 ReminderScheduler.swift:35 的 `progress.dueAt > now` 与第 73 行的
 * `guard fireAt > now else { continue }`。
 */
export function planReminders(session: RoutineSession | null, now: Date): ReminderMessage[] {
  return buildReminders(session).filter(
    (reminder) => reminder.fireAt.getTime() > now.getTime(),
  );
}

/** 供视图层标注「这条是 deadline 密集提醒」，等价 Swift 的 threadIdentifier。 */
export function isMilestoneReminder(reminder: ReminderMessage): boolean {
  return reminder.minuteOffset !== null;
}

/** 里程碑线程标识常量（与 Swift 第 95 行一致，导出供平台层复用）。 */
export const DEADLINE_THREAD_IDENTIFIER = MILESTONE_THREAD_ID;
