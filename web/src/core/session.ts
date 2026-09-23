/**
 * core/session.ts — RoutineTemplate / RoutineSession / StepProgress 的计算属性
 * （LOGIC_PORT_SPEC §2.2–§2.5）。
 *
 * 全部是纯函数；时间只用到 `now` 与绝对毫秒运算，不读全局时区。
 */

import type {
  Recurrence,
  RoutineSession,
  RoutineStep,
  RoutineTemplate,
  StepProgress,
  StepState,
} from './types';
import { addDaysInTz, setHoursInTz } from './serialization';

/** StepState.isIncomplete：pending / active / suspended 视为未完成。 */
export function isIncomplete(state: StepState): boolean {
  return state === 'pending' || state === 'active' || state === 'suspended';
}

// --------------------------------------------------------------------------
// RoutineTemplate 计算属性
// --------------------------------------------------------------------------

/** 旧数据可能缺 recurrence → 回落 `once`。 */
export function effectiveRecurrence(template: RoutineTemplate): Recurrence {
  return template.recurrence ?? 'once';
}

/** 首个 role=="deadline" 的步骤。 */
export function deadlineStep(template: RoutineTemplate): RoutineStep | undefined {
  return template.steps.find((step) => step.role === 'deadline');
}

/** 只保留 role=="task" 的步骤。 */
export function taskSteps(template: RoutineTemplate): RoutineStep[] {
  return template.steps.filter((step) => step.role === 'task');
}

/** 只累加 role=="task" 的时长；deadline 节点（duration=0）不计入。 */
export function totalTaskDuration(template: RoutineTemplate): number {
  return taskSteps(template).reduce((sum, step) => sum + step.duration, 0);
}

/**
 * 计算模板在某天的截止时刻（对应 `RoutineTemplate.deadline(on:calendar:)`）。
 * 语义（约束 W2）：先在**同一日历日**上设定 h:m:00（不跨日），
 * 若该时刻已早于 `date`：daily → +1 天；once → 保留当日过期时刻。
 */
export function deadlineOn(template: RoutineTemplate, date: Date, tz: string): Date | null {
  if (template.deadlineHour === null || template.deadlineMinute === null) {
    return null;
  }
  const today = setHoursInTz(date, template.deadlineHour, template.deadlineMinute, tz);
  if (today.getTime() >= date.getTime()) {
    return today;
  }
  return effectiveRecurrence(template) === 'daily' ? addDaysInTz(today, 1, tz) : today;
}

// --------------------------------------------------------------------------
// StepProgress 计算属性
// --------------------------------------------------------------------------

/** plannedDueAt 回落 dueAt。 */
export function originalDueAt(progress: StepProgress): Date {
  return progress.plannedDueAt ?? progress.dueAt;
}

/** max(0, remainingDuration ?? step.duration)。 */
export function remainingWork(progress: StepProgress): number {
  return Math.max(0, progress.remainingDuration ?? progress.step.duration);
}

// --------------------------------------------------------------------------
// RoutineSession 计算属性
// --------------------------------------------------------------------------

/** 首个 role=="deadline" 的进度项。 */
export function deadlineProgress(session: RoutineSession): StepProgress | undefined {
  return session.progress.find((item) => item.step.role === 'deadline');
}

/** deadlineProgress?.dueAt ?? targetDeadline ?? null。 */
export function expectedDeadline(session: RoutineSession): Date | null {
  return deadlineProgress(session)?.dueAt ?? session.targetDeadline ?? null;
}

/** 正序、active 提到最前的未完成任务列表（私有语义，供 estimatedDueDates 使用）。 */
function orderedIncompleteTasks(session: RoutineSession): StepProgress[] {
  const tasks = session.progress.filter(
    (item) => isIncomplete(item.state) && item.step.role === 'task',
  );
  const activeID = session.activeProgressID;
  if (activeID === null) {
    return tasks;
  }
  const active = tasks.find((item) => item.id === activeID);
  if (!active) {
    return tasks;
  }
  return [active, ...tasks.filter((item) => item.id !== activeID)];
}

/**
 * 预计各未完成项的完成时间（`estimatedDueDates(at:)`）。
 * - 无 active 时 `cursor = now` 顺排 remainingWork；
 * - active 项 `estimated = max(dueAt, now)`；
 * - deadline 项 `estimated = max(cursor, now)`（随实际推进变化）。
 */
export function estimatedDueDates(session: RoutineSession, at: Date): Map<string, Date> {
  const result = new Map<string, Date>();
  let cursor = at.getTime();

  for (const item of orderedIncompleteTasks(session)) {
    let estimated: number;
    if (item.state === 'active') {
      estimated = Math.max(item.dueAt.getTime(), at.getTime());
    } else {
      estimated = cursor + remainingWork(item) * 1000;
    }
    result.set(item.id, new Date(estimated));
    cursor = estimated;
  }

  const deadline = session.progress.find(
    (item) => isIncomplete(item.state) && item.step.role === 'deadline',
  );
  if (deadline) {
    result.set(deadline.id, new Date(Math.max(cursor, at.getTime())));
  }
  return result;
}

/** 预计整体完成时间（`estimatedCompletion(at:)`）。 */
export function estimatedCompletion(session: RoutineSession, at: Date): Date | null {
  const estimates = estimatedDueDates(session, at);
  const deadline = session.progress.find(
    (item) => isIncomplete(item.state) && item.step.role === 'deadline',
  );
  if (deadline) {
    return estimates.get(deadline.id) ?? null;
  }
  const lastTask = session.progress
    .filter((item) => isIncomplete(item.state) && item.step.role === 'task')
    .at(-1);
  return lastTask ? estimates.get(lastTask.id) ?? null : null;
}

/** 是否已晚于目标截止时间（`isLate(at:)`）。 */
export function isLate(session: RoutineSession, now: Date): boolean {
  if (session.targetDeadline === null) {
    return false;
  }
  const estimated = estimatedCompletion(session, now);
  return estimated !== null && estimated.getTime() > session.targetDeadline.getTime();
}
