import { describe, expect, it } from 'vitest';
import {
  createProgress,
  createSession,
  createStep,
  type RoutineSession,
  type StepProgress,
} from '../src/core/types';
import {
  DEADLINE_MILESTONES,
  activeTaskTitle,
  allReminders,
  deadlineMilestoneReminder,
  planReminders,
  taskReminder,
} from '../src/core/reminders';

/**
 * reminders 测试对照真相来源：`Shared/Services/ReminderScheduler.swift`（115 行）。
 *
 * 断言风格：**全部逐字字符串比较**，不使用 toContain 之类宽松匹配，
 * 以便文案漂移能被测试抓住。
 */

const SESSION_ID = 'SESSION-1';

interface SessionOptions {
  id?: string;
  state?: RoutineSession['state'];
  targetDeadline?: Date | null;
  progress?: StepProgress[];
  activeProgressID?: string | null;
}

function sessionWith(options: SessionOptions = {}): RoutineSession {
  return createSession({
    id: options.id ?? SESSION_ID,
    templateID: 'T',
    templateName: '测试',
    templateSymbol: 'checkmark',
    startedAt: new Date(0),
    plannedStartAt: new Date(0),
    targetDeadline: options.targetDeadline ?? null,
    state: options.state ?? 'running',
    primaryDevice: 'phone',
    progress: options.progress ?? [],
    remainingBuffer: 0,
    updatedAt: new Date(0),
    revision: 1,
    activeProgressID: options.activeProgressID ?? null,
  });
}

// ---------------------------------------------------------------------------
// 1) DEADLINE_MILESTONES 逐字
// ---------------------------------------------------------------------------

describe('reminders — DEADLINE_MILESTONES（Swift 60-69 逐字）', () => {
  it('长度 8、offset 序列、8 个 label 精确相等', () => {
    expect(DEADLINE_MILESTONES).toHaveLength(8);
    expect(DEADLINE_MILESTONES.map((m) => m.minuteOffset)).toEqual([
      -10, -5, -3, -1, 0, 2, 4, 6,
    ]);
    expect(DEADLINE_MILESTONES.map((m) => m.label)).toEqual([
      '还剩 10 分钟',
      '还剩 5 分钟',
      '还剩 3 分钟',
      '还剩 1 分钟',
      '计划时间到了',
      '已延误 2 分钟',
      '已延误 4 分钟',
      '已延误 6 分钟',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2) taskReminder
// ---------------------------------------------------------------------------

describe('reminders — taskReminder（Swift 33-53）', () => {
  it('role=task 且 pending：文案 / level / sound / key / progressID / fireAt 逐字正确', () => {
    const dueAt = new Date(500000);
    const progress = createProgress({
      id: 'P-1',
      step: createStep({ title: '刷牙', prompt: '先刷牙，不开新任务', duration: 3 * 60 }),
      dueAt,
    });
    const reminder = taskReminder(progress, SESSION_ID);
    expect(reminder).not.toBeNull();
    expect(reminder!.key).toBe('task:P-1:due');
    expect(reminder!.title).toBe('不跑偏 · 刷牙');
    expect(reminder!.body).toBe('先刷牙，不开新任务');
    expect(reminder!.level).toBe('normal');
    expect(reminder!.sound).toBe('default');
    expect(reminder!.fireAt.getTime()).toBe(dueAt.getTime());
    expect(reminder!.minuteOffset).toBeNull();
    expect(reminder!.progressID).toBe('P-1');
    expect(reminder!.sessionID).toBe(SESSION_ID);
  });

  it('反证：role=deadline 的进度项返回 null', () => {
    const progress = createProgress({
      id: 'P-D',
      step: createStep({ title: '出门', duration: 0, role: 'deadline' }),
      dueAt: new Date(0),
    });
    expect(taskReminder(progress, SESSION_ID)).toBeNull();
  });

  it('反证：state=completed 的 task 返回 null', () => {
    const progress = createProgress({
      id: 'P-C',
      step: createStep({ title: '刷牙', duration: 60 }),
      dueAt: new Date(0),
      state: 'completed',
    });
    expect(taskReminder(progress, SESSION_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3) deadlineMilestoneReminder 三形态逐字 + 各两种 body
// ---------------------------------------------------------------------------

describe('reminders — deadlineMilestoneReminder（Swift 75-100 三形态）', () => {
  it('负 offset（-10）：不跑偏 · 距离 Deadline 还剩 10 分钟 + 当前任务 body', () => {
    const reminder = deadlineMilestoneReminder(-10, '还剩 10 分钟', '刷牙', SESSION_ID, new Date(1000));
    expect(reminder.title).toBe('不跑偏 · 距离 Deadline 还剩 10 分钟');
    expect(reminder.body).toBe('当前任务：刷牙');
    expect(reminder.sound).toBe('default');
    expect(reminder.level).toBe('timeSensitive');
    expect(reminder.key).toBe(`deadline:${SESSION_ID}:-10`);
    expect(reminder.minuteOffset).toBe(-10);
    expect(reminder.progressID).toBeNull();
    expect(reminder.sessionID).toBe(SESSION_ID);
  });

  it('零 offset（0）：⏰ Deadline 到了（含全角引号）+ overdue sound', () => {
    const reminder = deadlineMilestoneReminder(0, '计划时间到了', '刷牙', SESSION_ID, new Date(1000));
    expect(reminder.title).toBe('⏰ Deadline 到了');
    expect(reminder.body).toBe('当前任务“刷牙”还没完成，请先回到主线。');
    expect(reminder.sound).toBe('overdue');
    expect(reminder.level).toBe('timeSensitive');
    expect(reminder.key).toBe(`deadline:${SESSION_ID}:0`);
  });

  it('正 offset（2）：🚨 Deadline 已延误 2 分钟（含全角引号）+ overdue sound', () => {
    const reminder = deadlineMilestoneReminder(2, '已延误 2 分钟', '刷牙', SESSION_ID, new Date(1000));
    expect(reminder.title).toBe('🚨 Deadline 已延误 2 分钟');
    expect(reminder.body).toBe('当前任务“刷牙”仍未完成，请先把它收尾。');
    expect(reminder.sound).toBe('overdue');
    expect(reminder.level).toBe('timeSensitive');
    expect(reminder.key).toBe(`deadline:${SESSION_ID}:2`);
  });

  it('currentTaskTitle=null：三个兜底 body 逐字', () => {
    expect(
      deadlineMilestoneReminder(-10, '还剩 10 分钟', null, SESSION_ID, new Date(0)).body,
    ).toBe('请确认最重要的任务正在推进。');
    expect(
      deadlineMilestoneReminder(0, '计划时间到了', null, SESSION_ID, new Date(0)).body,
    ).toBe('计划还没有完成，请先回到主线。');
    expect(
      deadlineMilestoneReminder(2, '已延误 2 分钟', null, SESSION_ID, new Date(0)).body,
    ).toBe('计划仍未完成，请立即回到主线。');
  });

  it('全 8 项 level=timeSensitive；<0 sound=default，0/+2/+4/+6 sound=overdue', () => {
    for (const milestone of DEADLINE_MILESTONES) {
      const reminder = deadlineMilestoneReminder(
        milestone.minuteOffset,
        milestone.label,
        '任意任务',
        SESSION_ID,
        new Date(0),
      );
      expect(reminder.level).toBe('timeSensitive');
      if (milestone.minuteOffset < 0) {
        expect(reminder.sound).toBe('default');
      } else {
        expect(reminder.sound).toBe('overdue');
      }
    }
  });

  it('fireAt 原样透传（调用方已算好 = targetDeadline + offset*60）', () => {
    const fireAt = new Date(123456789);
    const reminder = deadlineMilestoneReminder(-3, '还剩 3 分钟', null, SESSION_ID, fireAt);
    expect(reminder.fireAt.getTime()).toBe(fireAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// 4) allReminders / planReminders
// ---------------------------------------------------------------------------

describe('reminders — allReminders / planReminders（Swift 29-113）', () => {
  const deadlineAt = new Date(2026, 7, 13, 8, 10, 0, 0); // 2026-08-13 08:10 本地

  function buildTaskSession(): {
    session: RoutineSession;
    taskA: StepProgress;
    taskB: StepProgress;
    deadlineProgress: StepProgress;
  } {
    const taskA = createProgress({
      id: 'P-1',
      step: createStep({ title: '刷牙', prompt: '先刷牙', duration: 60 }),
      dueAt: new Date(deadlineAt.getTime()), // 08:10
    });
    const taskB = createProgress({
      id: 'P-2',
      step: createStep({ title: '洗脸', prompt: '再洗脸', duration: 60 }),
      dueAt: new Date(deadlineAt.getTime() - 10 * 60 * 1000), // 08:00
    });
    const deadlineProgress = createProgress({
      id: 'P-3',
      step: createStep({ title: '出门', duration: 0, role: 'deadline' }),
      dueAt: deadlineAt,
    });
    const session = sessionWith({
      targetDeadline: deadlineAt,
      progress: [taskA, taskB, deadlineProgress],
    });
    return { session, taskA, taskB, deadlineProgress };
  }

  it('session=null → []', () => {
    expect(allReminders(null)).toEqual([]);
  });

  it('非 running 会话（completed / cancelled）→ []（即便有未完成 task + deadline）', () => {
    const { session, taskA, taskB, deadlineProgress } = buildTaskSession();
    // 同样的 progress，仅切换 state：running 有 10 条，非 running 必须为 []。
    expect(allReminders(session)).toHaveLength(10);
    const progress = [taskA, taskB, deadlineProgress];
    expect(
      allReminders(sessionWith({ state: 'completed', targetDeadline: deadlineAt, progress })),
    ).toEqual([]);
    expect(
      allReminders(sessionWith({ state: 'cancelled', targetDeadline: deadlineAt, progress })),
    ).toEqual([]);
  });

  it('targetDeadline=null → 无里程碑，但保留 task 提醒', () => {
    const { session } = buildTaskSession();
    session.targetDeadline = null;
    const messages = allReminders(session);
    expect(messages.map((m) => m.key)).toEqual(['task:P-1:due', 'task:P-2:due']);
  });

  it('有 targetDeadline 但无未完成的 task/deadline 项 → 无里程碑', () => {
    const onlyCompleted = createProgress({
      id: 'P-C',
      step: createStep({ title: '刷牙', duration: 60 }),
      dueAt: deadlineAt,
      state: 'completed',
    });
    const session = sessionWith({ targetDeadline: deadlineAt, progress: [onlyCompleted] });
    expect(allReminders(session)).toEqual([]);
  });

  it('allReminders 顺序：task 按 session.progress 顺序在前，8 个里程碑按表序在后', () => {
    const { session } = buildTaskSession();
    const messages = allReminders(session);
    expect(messages).toHaveLength(10);
    expect(messages.slice(0, 2).map((m) => m.key)).toEqual(['task:P-1:due', 'task:P-2:due']);
    expect(messages.slice(2).map((m) => m.minuteOffset)).toEqual([-10, -5, -3, -1, 0, 2, 4, 6]);
    expect(messages.slice(2).every((m) => m.level === 'timeSensitive')).toBe(true);
    expect(messages.slice(2).every((m) => m.progressID === null)).toBe(true);
  });

  it('里程碑 fireAt = targetDeadline + offset*60 秒', () => {
    const { session } = buildTaskSession();
    const milestones = allReminders(session).filter((m) => m.minuteOffset !== null);
    for (const m of milestones) {
      expect(m.fireAt.getTime()).toBe(deadlineAt.getTime() + m.minuteOffset! * 60 * 1000);
    }
  });

  it('planReminders：now = deadline-6min → 只保留 -5,-3,-1,0,2,4,6 与未过期 task', () => {
    const { session } = buildTaskSession();
    const now = new Date(deadlineAt.getTime() - 6 * 60 * 1000); // 08:04
    const planned = planReminders(session, now);
    expect(planned.map((m) => m.key)).toEqual([
      'task:P-1:due', // 08:10 > 08:04 → 保留
      `deadline:${SESSION_ID}:-5`,
      `deadline:${SESSION_ID}:-3`,
      `deadline:${SESSION_ID}:-1`,
      `deadline:${SESSION_ID}:0`,
      `deadline:${SESSION_ID}:2`,
      `deadline:${SESSION_ID}:4`,
      `deadline:${SESSION_ID}:6`,
    ]);
    // task P-2（08:00 < 08:04）被时间过滤掉。
    expect(planned.some((m) => m.key === 'task:P-2:due')).toBe(false);
  });

  it('planReminders：fireAt === now 不保留（严格 > now）', () => {
    // now 恰好 = deadline-5min ⇒ offset -5 的 fireAt === now → 应被排除。
    const { session } = buildTaskSession();
    const now = new Date(deadlineAt.getTime() - 5 * 60 * 1000);
    const offsets = planReminders(session, now)
      .filter((m) => m.minuteOffset !== null)
      .map((m) => m.minuteOffset);
    expect(offsets).toEqual([-3, -1, 0, 2, 4, 6]);
  });

  it('activeProgressID 命中时，里程碑 body 使用当前任务标题', () => {
    const { session } = buildTaskSession();
    session.progress = session.progress.map((p) =>
      p.id === 'P-1' ? { ...p, state: 'active' as const } : p,
    );
    session.activeProgressID = 'P-1';
    const milestoneZero = allReminders(session).find((m) => m.minuteOffset === 0)!;
    expect(milestoneZero.body).toBe('当前任务“刷牙”还没完成，请先回到主线。');
  });
});

// ---------------------------------------------------------------------------
// 5) activeTaskTitle
// ---------------------------------------------------------------------------

describe('reminders — activeTaskTitle（Swift 75-77）', () => {
  function activeSession(state: StepProgress['state']): RoutineSession {
    const progress = createProgress({
      id: 'P-ACT',
      step: createStep({ title: '当前任务', duration: 60 }),
      dueAt: new Date(0),
      state,
    });
    return sessionWith({ progress: [progress], activeProgressID: 'P-ACT' });
  }

  it('id 匹配且 state=active → 返回标题', () => {
    expect(activeTaskTitle(activeSession('active'))).toBe('当前任务');
  });

  it('id 匹配但 state≠active → null', () => {
    expect(activeTaskTitle(activeSession('pending'))).toBeNull();
    expect(activeTaskTitle(activeSession('suspended'))).toBeNull();
    expect(activeTaskTitle(activeSession('completed'))).toBeNull();
  });

  it('activeProgressID 不匹配或为 null → null', () => {
    const session = activeSession('active');
    session.activeProgressID = 'NOT-EXIST';
    expect(activeTaskTitle(session)).toBeNull();
    session.activeProgressID = null;
    expect(activeTaskTitle(session)).toBeNull();
  });
});
