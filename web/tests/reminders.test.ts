import { describe, expect, it } from 'vitest';
import {
  createProgress,
  createSession,
  createStep,
  type RoutineSession,
  type StepProgress,
} from '../src/core/types';
import {
  COMMUTE_DEPART_TITLE,
  DEADLINE_MILESTONES,
  COMMUTE_LEAD_SECONDS,
  DEFAULT_OVERDUE_POLICY,
  OVERDUE_INTERVAL_RANGE,
  TASK_ADVANCE_TITLE,
  TASK_LEAD_SECONDS,
  activeTaskTitle,
  allReminders,
  deadlineMilestoneReminder,
  focusedTask,
  normalizeOverduePolicy,
  overdueFireOffsets,
  overdueReminder,
  overdueRound,
  planReminders,
  speechText,
  spokenClock,
  taskAdvanceBody,
  taskReminder,
  type OverduePolicy,
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
    // 同样的 progress，仅切换 state：running 有 9 条（1 条当前任务 + 8 里程碑），
    // 非 running 必须为 []。
    expect(allReminders(session)).toHaveLength(9);
    const progress = [taskA, taskB, deadlineProgress];
    expect(
      allReminders(sessionWith({ state: 'completed', targetDeadline: deadlineAt, progress })),
    ).toEqual([]);
    expect(
      allReminders(sessionWith({ state: 'cancelled', targetDeadline: deadlineAt, progress })),
    ).toEqual([]);
  });

  it('targetDeadline=null → 无里程碑，但保留当前任务提醒', () => {
    const { session } = buildTaskSession();
    session.targetDeadline = null;
    const messages = allReminders(session);
    // 无 active → 回落「第一个未完成 task」= P-1（不是 P-2，也不是两条都出）。
    expect(messages.map((m) => m.key)).toEqual(['task:P-1:due']);
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

  it('allReminders 顺序：当前任务一条在前，8 个里程碑按表序在后', () => {
    const { session } = buildTaskSession();
    const messages = allReminders(session);
    expect(messages).toHaveLength(9);
    expect(messages.slice(0, 1).map((m) => m.key)).toEqual(['task:P-1:due']);
    expect(messages.slice(1).map((m) => m.minuteOffset)).toEqual([-10, -5, -3, -1, 0, 2, 4, 6]);
    expect(messages.slice(1).every((m) => m.level === 'timeSensitive')).toBe(true);
    expect(messages.slice(1).every((m) => m.progressID === null)).toBe(true);
  });

  it('里程碑 fireAt = targetDeadline + offset*60 秒', () => {
    const { session } = buildTaskSession();
    const milestones = allReminders(session).filter((m) => m.minuteOffset !== null);
    for (const m of milestones) {
      expect(m.fireAt.getTime()).toBe(deadlineAt.getTime() + m.minuteOffset! * 60 * 1000);
    }
  });

  it('planReminders：now = deadline-6min → 只保留 -5,-3,-1,0,2,4,6 与未过期的当前任务', () => {
    const { session } = buildTaskSession();
    const now = new Date(deadlineAt.getTime() - 6 * 60 * 1000); // 08:04
    const planned = planReminders(session, now);
    expect(planned.map((m) => m.key)).toEqual([
      'task:P-1:due', // 08:10 > 08:04 → 保留（P-1 是「第一个未完成 task」= 当前项）
      `deadline:${SESSION_ID}:-5`,
      `deadline:${SESSION_ID}:-3`,
      `deadline:${SESSION_ID}:-1`,
      `deadline:${SESSION_ID}:0`,
      `deadline:${SESSION_ID}:2`,
      `deadline:${SESSION_ID}:4`,
      `deadline:${SESSION_ID}:6`,
    ]);
    // P-2 不是当前项，即便它未被时间过滤也不该出现。
    expect(planned.some((m) => m.key === 'task:P-2:due')).toBe(false);
  });

  it('planReminders：当前项已过期（fireAt <= now）时不保留它，只留里程碑', () => {
    // now = deadline-5min；P-1 的 dueAt = deadline（08:10）仍 > now，故仍在。
    // 这里改用 deadline+1min 作 now，让当前项彻底过期。
    const { session } = buildTaskSession();
    const now = new Date(deadlineAt.getTime() + 60 * 1000);
    const planned = planReminders(session, now);
    expect(planned.some((m) => m.progressID !== null)).toBe(false);
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
// 4b) Bug 回归：只提醒「当前那一项」（2026-10-14）
// ---------------------------------------------------------------------------

describe('reminders — 只提醒当前那一项（Bug：上一项未结束却弹下一项）', () => {
  const deadlineAt = new Date(2026, 7, 13, 8, 10, 0, 0);

  function twoTasks(): { session: RoutineSession; first: StepProgress; second: StepProgress } {
    const first = createProgress({
      id: 'P-1',
      step: createStep({ title: '刷牙', prompt: '先刷牙', duration: 300 }),
      dueAt: new Date(deadlineAt.getTime() - 20 * 60 * 1000),
    });
    const second = createProgress({
      id: 'P-2',
      step: createStep({ title: '洗脸', prompt: '再洗脸', duration: 300 }),
      dueAt: new Date(deadlineAt.getTime() - 10 * 60 * 1000), // 已到点
    });
    return {
      session: sessionWith({ targetDeadline: deadlineAt, progress: [first, second] }),
      first,
      second,
    };
  }

  it('focusedTask：有 active 时返回 active（哪怕后面还有未完成项）', () => {
    const { session } = twoTasks();
    session.progress[0].state = 'active';
    session.activeProgressID = 'P-1';
    expect(focusedTask(session)?.id).toBe('P-1');
  });

  it('focusedTask：无 active 时回落第一个未完成 task', () => {
    const { session } = twoTasks();
    expect(focusedTask(session)?.id).toBe('P-1');
  });

  it('focusedTask：无 active、首项已完成 → 回落下一个未完成 task', () => {
    const { session } = twoTasks();
    session.progress[0].state = 'completed';
    expect(focusedTask(session)?.id).toBe('P-2');
  });

  it('focusedTask：deadline 项不算候选（它是终点，不是「现在做这个」）', () => {
    const only = createProgress({
      id: 'P-D',
      step: createStep({ title: '出门', duration: 0, role: 'deadline' }),
      dueAt: deadlineAt,
    });
    const session = sessionWith({ targetDeadline: deadlineAt, progress: [only] });
    expect(focusedTask(session)).toBeNull();
  });

  it('🔴 回归：下一项已到点，但提醒仍只指向当前项', () => {
    const { session, second } = twoTasks();
    session.progress[0].state = 'active';
    session.activeProgressID = 'P-1';
    // 下一项确实已到点（正是当初会误弹的场景）。
    expect(second.dueAt.getTime()).toBeLessThan(deadlineAt.getTime());

    const taskKeys = allReminders(session)
      .filter((m) => m.progressID !== null)
      .map((m) => m.key);
    expect(taskKeys).toEqual(['task:P-1:due']);
    expect(taskKeys).not.toContain('task:P-2:due');
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

// ---------------------------------------------------------------------------
// 6) 系统通道专用文案锚点（2026-10-13 新增）
// ---------------------------------------------------------------------------

describe('reminders — 系统通道专用文案（Swift ReminderScheduler）', () => {
  /**
   * 这两类提醒**刻意不产出 ReminderMessage** —— 它们只在「人没在看屏幕」时才有意义，
   * 真正的排期由原生 `ReminderScheduler` 做。这里断言的是**文案常量本身**，
   * 目的是在 Swift 侧改字（哪怕只是全角/半角引号、`·` 间距）时把漂移抓出来。
   */
  it('提前预警文案逐字对应 Swift scheduleTask', () => {
    expect(TASK_ADVANCE_TITLE).toBe('不跑偏 · 还有 2 分钟');
    expect(taskAdvanceBody('刷牙')).toBe('接下来：刷牙');
  });

  it('通勤出发文案逐字对应 Swift scheduleCommuteDepart', () => {
    expect(COMMUTE_DEPART_TITLE).toBe('不跑偏 · 该出发了');
  });

  it('提前量与 Swift 常量一致（各 2 分钟）', () => {
    expect(TASK_LEAD_SECONDS).toBe(120);
    expect(COMMUTE_LEAD_SECONDS).toBe(120);
  });

  it('buildReminders 不产出这两类（页内弹窗不该出现提前预警）', () => {
    const progress = createProgress({
      id: 'P-ANCHOR',
      step: createStep({ title: '刷牙', duration: 60 }),
      dueAt: new Date(2026, 7, 13, 8, 10, 0, 0),
    });
    const session = sessionWith({
      targetDeadline: new Date(2026, 7, 13, 8, 10, 0, 0),
      progress: [progress],
    });
    const titles = allReminders(session).map((m) => m.title);
    expect(titles).not.toContain(TASK_ADVANCE_TITLE);
    expect(titles).not.toContain(COMMUTE_DEPART_TITLE);
  });
});


// ---------------------------------------------------------------------------
// 7) 语音播报正文（2026-10-16 新增）
// ---------------------------------------------------------------------------

describe('reminders — 语音播报正文（speech / speechText）', () => {
  it('spokenClock 用 24 小时制、与设备本地时区一致（不靠 Intl，避免假绿）', () => {
    // TZ=Asia/Shanghai 下 getHours() 即本地钟点。
    expect(spokenClock(new Date(2026, 7, 13, 9, 5, 0))).toBe('9 点 5 分');
    expect(spokenClock(new Date(2026, 7, 13, 14, 30, 0))).toBe('14 点 30 分');
    expect(spokenClock(new Date(2026, 7, 13, 0, 0, 0))).toBe('0 点 0 分');
  });

  it('speechText = 「现在是 X 点 Y 分。」+ 该条播报正文', () => {
    const reminder = taskReminder(
      createProgress({
        id: 'P-SP',
        step: createStep({ title: '写周报', duration: 600 }),
        dueAt: new Date(2026, 7, 13, 12, 0, 0),
      }),
      SESSION_ID,
    )!;
    expect(reminder.speech).toBe('到点了，现在做“写周报”。');
    expect(speechText(reminder, new Date(2026, 7, 13, 9, 5, 0))).toBe(
      '现在是9 点 5 分。到点了，现在做“写周报”。',
    );
  });

  it('⚠️ 时刻取自调用方传入的 now，而非 reminder.fireAt', () => {
    // 起点 11:00、时长 10 分钟 → 11:10 起超时；11:12:05 时超时 125 秒 → floor = 2 分钟
    // （口径同界面 `TimelineCard.overdueText`，见 `overdueReminder` 的注释）。
    const progress = createProgress({
      id: 'P-OVD-SP',
      step: createStep({ title: '写代码', duration: 10 * 60 }),
      dueAt: new Date(2026, 7, 13, 11, 10, 0),
      state: 'active',
      startedAt: new Date(2026, 7, 13, 11, 0, 0),
    });
    const reminder = overdueReminder(progress, SESSION_ID, new Date(2026, 7, 13, 11, 12, 5), 0)!;

    // fireAt 是「构建这条提醒的时刻」；播报时若已过两分钟，念出的应是 11:14 而不是 11:12。
    // 这正是超时循环提醒的真实场景（同一条 reminder 会被反复播报）。
    // 注意：`speech` 里的分钟数在**构造时**就固化了（它描述的是那条提醒的内容），
    // 随 `now` 变化的只有前面的时刻前缀 —— 两条断言的正文因此相同。
    expect(speechText(reminder, new Date(2026, 7, 13, 11, 12, 5))).toBe(
      '现在是11 点 12 分。“写代码”已经延误 2 分钟了，先把它收尾。',
    );
    expect(speechText(reminder, new Date(2026, 7, 13, 11, 14, 0))).toBe(
      '现在是11 点 14 分。“写代码”已经延误 2 分钟了，先把它收尾。',
    );
  });

  it('🔴 超时播报含「延误了几分钟」—— 用户明确要求', () => {
    const progress = createProgress({
      id: 'P-MIN',
      step: createStep({ title: '写代码', duration: 10 * 60 }),
      dueAt: new Date(2026, 7, 13, 11, 10, 0),
      state: 'active',
      startedAt: new Date(2026, 7, 13, 11, 0, 0),
    });
    expect(
      overdueReminder(progress, SESSION_ID, new Date(2026, 7, 13, 11, 12, 5), 0)!.speech,
    ).toBe('“写代码”已经延误 2 分钟了，先把它收尾。');
    // 满 4 分钟那一轮 → 念 4 分钟。
    expect(
      overdueReminder(progress, SESSION_ID, new Date(2026, 7, 13, 11, 14, 0), 1)!.speech,
    ).toBe('“写代码”已经延误 4 分钟了，先把它收尾。');
    // ⚠️ 边界：2 分 59 秒仍算 2 分钟（floor），不能进位成 3 —— 否则又会和页面差一分钟。
    expect(
      overdueReminder(progress, SESSION_ID, new Date(2026, 7, 13, 11, 12, 59), 0)!.speech,
    ).toBe('“写代码”已经延误 2 分钟了，先把它收尾。');
  });

  it('播报正文不含给眼睛看的前缀 / emoji（念出来是噪音）', () => {
    const task = taskReminder(
      createProgress({
        id: 'P-NOISE',
        step: createStep({ title: '刷牙', duration: 180 }),
        dueAt: new Date(2026, 7, 13, 8, 0, 0),
      }),
      SESSION_ID,
    )!;
    expect(task.title).toBe('不跑偏 · 刷牙');
    expect(task.speech).not.toContain('不跑偏');
    expect(task.speech).not.toContain('·');

    // 里程碑三种形态都不该把 emoji / 英文词喂给 TTS。
    const milestone = deadlineMilestoneReminder(
      0,
      '计划时间到了',
      '刷牙',
      SESSION_ID,
      new Date(2026, 7, 13, 12, 0, 0),
    );
    expect(milestone.title).toBe('⏰ Deadline 到了');
    expect(milestone.speech).toBe('计划时间到了。“刷牙”还没完成，请先回到主线。');
    expect(milestone.speech).not.toContain('⏰');
    expect(milestone.speech).not.toContain('Deadline');
  });

  it('里程碑播报的三种形态（提前 / 到点 / 延误）', () => {
    const at = new Date(2026, 7, 13, 12, 0, 0);
    expect(deadlineMilestoneReminder(-5, '还剩 5 分钟', '写周报', SESSION_ID, at).speech).toBe(
      '距离计划结束还有 5 分钟。当前在做“写周报”。',
    );
    // 无当前任务 → 走兜底分支，不得出现「在做“null”」这类嗓音。
    expect(deadlineMilestoneReminder(-5, '还剩 5 分钟', null, SESSION_ID, at).speech).toBe(
      '距离计划结束还有 5 分钟。请确认最重要的任务正在推进。',
    );
    expect(deadlineMilestoneReminder(4, '已延误 4 分钟', '写周报', SESSION_ID, at).speech).toBe(
      '计划已经延误 4 分钟。“写周报”仍未完成，请先把它收尾。',
    );
  });

  it('每个 ReminderMessage 都带非空 speech（漏一个就是一条哑巴提醒）', () => {
    const progress = createProgress({
      id: 'P-ALL',
      step: createStep({ title: '语文', duration: 3600 }),
      dueAt: new Date(2026, 7, 13, 9, 0, 0),
    });
    const session = sessionWith({
      targetDeadline: new Date(2026, 7, 13, 12, 0, 0),
      progress: [progress],
    });
    const reminders = allReminders(session);
    // 1 条 task + 8 条里程碑。
    expect(reminders).toHaveLength(9);
    for (const reminder of reminders) {
      expect(reminder.speech.length).toBeGreaterThan(0);
    }
  });
});

/**
 * 超时提醒间隔策略（2026-10-15 用户需求：可配置 + 分两阶段）。
 *
 * 这个 describe 的重点不是「跑通」，而是**锁住两条不变量的等价性**：
 * ① `overdueFireOffsets`（原生排期物化出的触发点）与 `overdueRound`（tick 里解析式反推的轮次）
 *    必须同口径 —— 两者不一致会让同一轮被算两次或漏算，表现为「刚提醒过又来一条」或「一直不响」。
 * ② **默认策略必须与改动前的旧行为逐字等价**（全程 2 分钟），否则老用户升级后节奏被悄悄改掉。
 */
describe('core/reminders — 超时提醒间隔策略 OverduePolicy', () => {
  /** 用 `fireOffsets` 当真相，反向验证 `overdueRound` 在每一个触发点上都算出正确轮次。 */
  function assertOffsetsMatchRounds(policy: OverduePolicy, limit: number): number[] {
    const offsets = overdueFireOffsets(policy, limit);
    expect(offsets).toHaveLength(limit);
    for (let index = 0; index < offsets.length; index += 1) {
      const seconds = offsets[index];
      // 触发点当刻 → 正好是第 index 轮。
      expect(overdueRound(seconds, policy)).toBe(index);
      // 触发点前 1 秒 → 还是上一轮；第 0 轮之前则尚未触发（-1）。
      expect(overdueRound(Math.max(0, seconds - 1), policy)).toBe(index - 1);
    }
    // 严格递增：一旦重复，说明两阶段算重叠了（同一秒会被排两条通知）。
    for (let index = 1; index < offsets.length; index += 1) {
      expect(offsets[index]).toBeGreaterThan(offsets[index - 1]);
    }
    return offsets;
  }

  it('🔴 默认策略与旧行为等价：全程 2 分钟，首轮在超时满 2 分钟', () => {
    expect(DEFAULT_OVERDUE_POLICY).toEqual({
      earlyInterval: 2,
      switchAfter: 10,
      lateInterval: 2,
    });
    const offsets = overdueFireOffsets(DEFAULT_OVERDUE_POLICY, 6);
    expect(offsets).toEqual([120, 240, 360, 480, 600, 720]);
    // 旧实现是 `floor(seconds / 120) - 1`，逐点比对不能有偏差。
    for (const seconds of [0, 60, 119, 120, 239, 240, 599, 600, 601]) {
      expect(overdueRound(seconds, DEFAULT_OVERDUE_POLICY)).toBe(
        seconds < 120 ? -1 : Math.floor(seconds / 120) - 1,
      );
    }
  });

  it('用户给的例子：10 分钟以内每 2 分钟、超过后每 1 分钟', () => {
    const policy: OverduePolicy = { earlyInterval: 2, switchAfter: 10, lateInterval: 1 };
    // 阶段一 120/240/360/480（严格早于 600），阶段二从 600 起逐 60 秒。
    expect(overdueFireOffsets(policy, 10)).toEqual([
      120, 240, 360, 480, 600, 660, 720, 780, 840, 900,
    ]);
  });

  it('🔴 两阶段无缝衔接：切换点处不留空档（不会 8 分钟响过要等到 12 分钟）', () => {
    const policy: OverduePolicy = { earlyInterval: 4, switchAfter: 10, lateInterval: 1 };
    const offsets = overdueFireOffsets(policy, 6);
    // 阶段一 240/480，阶段二从 600 起 —— 480 → 600 只隔 2 分钟，不是「等一个 4 分钟」。
    expect(offsets).toEqual([240, 480, 600, 660, 720, 780]);
    expect(offsets[2] - offsets[1]).toBe(120);
  });

  it('阶段一为空（切换点比间隔还小）→ 第一条就是切换点本身', () => {
    const policy: OverduePolicy = { earlyInterval: 5, switchAfter: 2, lateInterval: 1 };
    const offsets = overdueFireOffsets(policy, 4);
    expect(offsets).toEqual([120, 180, 240, 300]);
    expect(overdueRound(119, policy)).toBe(-1);
    expect(overdueRound(120, policy)).toBe(0);
  });

  it('切换点正好是阶段一的整倍数 → 切换点归阶段二，不重复计算', () => {
    // early=2 分钟、switchAfter=6 分钟 → 切换点 360 秒 = 3 × 120，是整倍数（边界）。
    // 最容易出的错是「阶段一算到 360、阶段二也从 360 起」→ 同一秒排两条通知。
    const policy: OverduePolicy = { earlyInterval: 2, switchAfter: 6, lateInterval: 1 };
    const offsets = overdueFireOffsets(policy, 5);
    // 阶段一 120/240（360 不满足 `t < 360`），阶段二从 360 起逐 60 秒。
    expect(offsets).toEqual([120, 240, 360, 420, 480]);
    // 360 只出现一次，且它就是第 2 轮 —— 没有「算两遍」。
    expect(offsets.filter((item) => item === 360)).toHaveLength(1);
    expect(overdueRound(360, policy)).toBe(2);
    expect(overdueRound(359, policy)).toBe(1);
  });

  it('🔴 overdueFireOffsets ↔ overdueRound 互证（多组策略含奇数分钟）', () => {
    const policies: OverduePolicy[] = [
      { earlyInterval: 1, switchAfter: 3, lateInterval: 1 },
      { earlyInterval: 3, switchAfter: 10, lateInterval: 1 },
      { earlyInterval: 7, switchAfter: 20, lateInterval: 2 },
      { earlyInterval: 10, switchAfter: 10, lateInterval: 10 },
      { earlyInterval: 9, switchAfter: 60, lateInterval: 4 },
    ];
    for (const policy of policies) {
      assertOffsetsMatchRounds(policy, 8);
    }
  });

  it('轮次只增不减：随时间推进不会回退到上一轮（否则去重键会重放旧提醒）', () => {
    const policy: OverduePolicy = { earlyInterval: 2, switchAfter: 10, lateInterval: 1 };
    let previous = -1;
    for (let seconds = 0; seconds <= 30 * 60; seconds += 7) {
      const round = overdueRound(seconds, policy);
      expect(round).toBeGreaterThanOrEqual(previous);
      previous = round;
    }
    // 走到 30 分钟，轮次确实在推进（不是一直 -1 的假绿）。
    expect(previous).toBeGreaterThan(20);
  });

  it('normalizeOverduePolicy 容忍脏输入：缺键/越界/非数字一律回落合法值', () => {
    // 缺键（旧数据）：与默认一致 —— 老用户升级后行为不变。
    expect(normalizeOverduePolicy(undefined)).toEqual(DEFAULT_OVERDUE_POLICY);
    expect(normalizeOverduePolicy(null)).toEqual(DEFAULT_OVERDUE_POLICY);
    expect(normalizeOverduePolicy({})).toEqual(DEFAULT_OVERDUE_POLICY);

    // 越界 → 夹到边界；非数字 → 该项回落默认。
    expect(normalizeOverduePolicy({ earlyInterval: 0 })).toEqual({
      earlyInterval: OVERDUE_INTERVAL_RANGE.min,
      switchAfter: 10,
      lateInterval: 2,
    });
    expect(normalizeOverduePolicy({ earlyInterval: 99 })).toEqual({
      earlyInterval: OVERDUE_INTERVAL_RANGE.max,
      switchAfter: 10,
      lateInterval: 2,
    });
    expect(
      normalizeOverduePolicy({
        earlyInterval: Number.NaN,
        switchAfter: 999,
        lateInterval: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ earlyInterval: 2, switchAfter: 60, lateInterval: 2 });

    // 归一化后的值一定落在可选范围内 —— 否则界面 select 会绑到「不在列表里的值」而显示空白。
    const dirty = normalizeOverduePolicy({ earlyInterval: -5, switchAfter: 0, lateInterval: 1000 });
    expect(dirty.earlyInterval).toBeGreaterThanOrEqual(OVERDUE_INTERVAL_RANGE.min);
    expect(dirty.earlyInterval).toBeLessThanOrEqual(OVERDUE_INTERVAL_RANGE.max);
    expect(dirty.lateInterval).toBeLessThanOrEqual(OVERDUE_INTERVAL_RANGE.max);
    expect(dirty.switchAfter).toBeGreaterThanOrEqual(1);
  });

  it('🔴 奇数间隔下分钟数仍按 floor 报（ceil 会让播报比页面多 1 分钟）', () => {
    // 间隔 3 分钟 → 第 1 轮在超时 180 秒。若用 ceil 报 3 分钟没错，
    // 但 3 分钟的奇数网格上「2 分 59 秒」这类边界一撞就会露馅，故用 125 秒直接验 floor。
    const progress = createProgress({
      id: 'P-ODD',
      step: createStep({ title: '写代码', duration: 10 * 60 }),
      dueAt: new Date(2026, 7, 13, 11, 10, 0),
      state: 'active',
      startedAt: new Date(2026, 7, 13, 11, 0, 0),
    });
    const policy: OverduePolicy = { earlyInterval: 3, switchAfter: 10, lateInterval: 1 };
    const round = overdueRound(125, policy);
    expect(round).toBe(-1); // 未满 3 分钟，这一轮不该提醒
    expect(overdueRound(180, policy)).toBe(0);
    // 超时 125 秒即便被要求播报，正文也得是 2 分钟。
    expect(
      overdueReminder(progress, SESSION_ID, new Date(2026, 7, 13, 11, 12, 5), 0)!.speech,
    ).toBe('“写代码”已经延误 2 分钟了，先把它收尾。');
  });
});
