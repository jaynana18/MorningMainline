import type { RoutineSession, StepProgress } from '../src/core/types';

/** 约束 W1：测试运行在钉死时区下（vitest.config.ts 设 TZ=Asia/Shanghai）。 */
export const TZ = 'Asia/Shanghai';

/** 本地日历日 + 时刻（与 Swift 测试的 `Calendar(identifier:.gregorian).date(from:)` 锚点等价）。 */
export function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** 2026-08-13 12:00 —— assertDeadline 统一锚点。 */
export function anchorNoon(): Date {
  return localDate(2026, 8, 13, 12, 0);
}

/** 格式化为 `H:mm`（与 Swift 测试的 `String(format:"%d:%02d", hour, minute)` 等价）。 */
export function formatHM(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function byTitle(session: RoutineSession, title: string): StepProgress {
  const item = session.progress.find((progress) => progress.step.title === title);
  if (!item) {
    throw new Error(`找不到任务进度：${title}`);
  }
  return item;
}

export function titles(session: RoutineSession): string[] {
  return session.progress.map((progress) => progress.step.title);
}
