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
 * **此刻唯一该被提醒的那一项**：优先「正在进行」的，其次「第一个未完成的任务」。
 *
 * 为什么只挑一项（2026-10-14 修 bug）：原来对**所有**未完成 task 都产出提醒，
 * 于是「上一项还没结束、下一项已到点」时会弹出下一项 —— 用户被从手头这件事上拽走，
 * 而真正该做的恰恰是先把手头这项收尾。提醒的语义是「现在做这个」，
 * 不是「今天还有这些」；全景由时间线负责，提醒只负责一件。
 *
 * 无 active 项时回落第一个未完成 task（等价于「该开始了」），
 * 否则「用户没点开始就忘了」这种情况会彻底收不到提醒。
 *
 * 与 Swift `ReminderScheduler.focusedTask(in:)` 严格同语义，改动必须同步。
 */
export function focusedTask(session: RoutineSession): StepProgress | null {
  const active = session.progress.find(
    (progress) => progress.id === session.activeProgressID && progress.state === 'active',
  );
  if (active) {
    return active;
  }
  return (
    session.progress.find(
      (progress) => progress.step.role === 'task' && isIncomplete(progress.state),
    ) ?? null
  );
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
 * 1. 先输出**当前那一项**任务的提醒（有 active 用 active，否则第一个未完成 task）；
 * 2. 再按 `DEADLINE_MILESTONES` 表序输出 8 个里程碑。
 *
 * ⚠️ **只提醒一项，不是所有未完成项**（2026-10-14 修 bug）。原实现对全部未完成
 * task 都产出提醒，导致「上一项未结束、下一项已到点」时弹出下一项。提醒的语义是
 * 「现在做这个」；完整排期由时间线表达。Swift `replaceNotifications` 同口径。
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

  // 1) 当前那一项的提醒（唯一一条）。
  const focused = focusedTask(session);
  if (focused !== null) {
    const reminder = taskReminder(focused, session.id);
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

// ---------------------------------------------------------------------------
// 系统通道专用提醒（2026-10-13 新增，刻意不进页内弹窗）
// ---------------------------------------------------------------------------

/**
 * `ReminderScheduler` 在 2026-10-13 新增了两类提醒，用于「人没在看屏幕」的场景：
 *
 * 1. **普通任务的提前预警**（`taskAdvanceReminder`）：到点前 2 分钟先响一次，
 *    留出收尾时间。原文案见 Swift `scheduleTask`。
 * 2. **通勤段的出发提醒**（`commuteDepartReminder`）：通勤不像任务可以随时收尾，
 *    晚了就是晚了，所以单独给一条「该出发了」。触发点是「离开时刻 = 到达时刻 − 路程」
 *    再提前一点（短途按路程一半封顶）。原文案见 Swift `scheduleCommuteDepart`。
 *
 * **为什么这里的 `buildReminders` 不产出它们**：本文件服务于页内弹窗通道，
 * 而页内弹窗只在「用户正盯着屏幕」时出现 —— 那种情况下提前 2 分钟弹一次是噪音，
 * 真正的到点弹窗已经够用。提前预警的全部价值在于屏幕没亮的时候，
 * 那正是系统通知通道的职责，由原生 `ReminderScheduler` 自己排。
 *
 * **仍然放在这里的理由**：文案是单一来源。把文案抄成常量供测试锚定，
 * 一旦 Swift 侧改了字（含全角引号 / `·` / 间距），下面的断言会失败。
 */
export const TASK_ADVANCE_TITLE = '不跑偏 · 还有 2 分钟';
/** 通勤出发提醒标题。 */
export const COMMUTE_DEPART_TITLE = '不跑偏 · 该出发了';
/** 普通任务提前预警量（秒）。与 Swift `ReminderScheduler.taskLead` 一致。 */
export const TASK_LEAD_SECONDS = 2 * 60;
/** 通勤出发提醒的最大提前量（秒）。与 Swift `ReminderScheduler.commuteLead` 一致。 */
export const COMMUTE_LEAD_SECONDS = 2 * 60;

/** 提前预警正文。逐字对应 Swift `"接下来：\(progress.step.title)"`。 */
export function taskAdvanceBody(title: string): string {
  return `接下来：${title}`;
}

// ---------------------------------------------------------------------------
// 超时循环提醒（2026-10-14 新增）—— 两条通道都要，且要能**重复**
// ---------------------------------------------------------------------------

/**
 * 任务超时后的循环提醒。
 *
 * 与前两类提醒的根本差别：**它是重复的**。到点提醒是「一次性事件」，弹过就完了；
 * 而「这件事还没做完」是一个**持续为真的状态**，所以必须周期性重提，
 * 直到用户真的把它收尾。
 *
 * 两条通道的处理方式不同（见 `stores/reminders.ts` 与 Swift `scheduleOverdueRepeats`）：
 * - App 内（页面可见）：页内常驻弹窗，弹出后几秒自动关闭，再过一会重新弹，循环；
 * - App 不在前台：系统通知，由原生预先排好一串定时通知
 *   —— 因为 App 退到后台后 JS 定时器会被挂起，只有系统排期的通知才响得起来。
 *
 * ⚠️ 「超时」的口径必须与界面一致：`startedAt + step.duration`，即
 * `TimelineCard.overdueSeconds`。用 `dueAt` 不行 —— 它在某些动作里会被前推，
 * 会出现「界面显示已超时、提醒却说不超时」的矛盾。
 */
export const OVERDUE_TITLE = '不跑偏 · 超时了';

/** 超时提醒的重提间隔（秒）。与 Swift `ReminderScheduler.overdueRepeat` 一致。 */
export const OVERDUE_REPEAT_SECONDS = 2 * 60;

/** 超时提醒正文。逐字对应 Swift `overdueBody(title:minutes:)`。 */
export function overdueBody(title: string, minutes: number): string {
  return `“${title}”已经超了 ${minutes} 分钟，先把它收尾。`;
}

/**
 * 任务超时秒数；未在进行中或未超时返回 0。
 * 口径同 `TimelineCard.overdueSeconds`（`startedAt + step.duration`）。
 */
export function overdueSecondsOf(progress: StepProgress, now: Date): number {
  if (progress.state !== 'active' || progress.startedAt === null) {
    return 0;
  }
  return Math.max(
    0,
    (now.getTime() - progress.startedAt.getTime()) / 1000 - progress.step.duration,
  );
}

/**
 * 当前任务的超时提醒；未满 {@link OVERDUE_REPEAT_SECONDS} 时返回 null。
 *
 * `round` 是「第几轮」：0 = 超时满 2 分钟那一次，1 = 满 4 分钟，依此类推。
 * 它只进 `key`（让每一轮都是独立的一条，不被一次性去重吃掉），
 * 文案里用的是**实际超时分钟数**（向上取整，至少 1）。
 */
export function overdueReminder(
  progress: StepProgress,
  sessionID: string,
  now: Date,
  round: number,
): ReminderMessage | null {
  const seconds = overdueSecondsOf(progress, now);
  if (seconds <= 0 || round < 0) {
    return null;
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return {
    key: `overdue:${progress.id}:${round}`,
    title: OVERDUE_TITLE,
    body: overdueBody(progress.step.title, minutes),
    // 超时是「持续为真」的状态，值得打断 —— 与 deadline 里程碑同级。
    level: 'timeSensitive',
    sound: 'overdue',
    fireAt: new Date(now.getTime()),
    minuteOffset: null,
    progressID: progress.id,
    sessionID,
  };
}

/**
 * 超时第几轮：0 起算，**首次出现在超时满 2 分钟时**，之后每 2 分钟一轮。
 * 不满 2 分钟返回 -1（此时不提醒）。
 *
 * 为什么首次不是「刚超时那一刻」：任务到点的提醒（`taskReminder`）已经在
 * `dueAt` 那一刻响过了，而 `dueAt` 就是 `startedAt + duration`。若超时提醒也从
 * 第 0 秒起算，同一秒会弹两条 —— 一条「该做这个了」、一条「已经超时了」。
 * 用户的原话也是「每超时 2 分钟提醒一次」，从 2 分钟起算正好。
 */
export function overdueRound(overdueSeconds: number): number {
  if (overdueSeconds < OVERDUE_REPEAT_SECONDS) {
    return -1;
  }
  return Math.floor(overdueSeconds / OVERDUE_REPEAT_SECONDS) - 1;
}
