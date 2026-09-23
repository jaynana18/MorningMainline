import { describe, expect, it } from 'vitest';
import {
  createProgress,
  createSession,
  createStep,
  type RoutineSession,
} from '../src/core/types';
import {
  estimatedCompletion,
  estimatedDueDates,
  isIncomplete,
  isLate,
} from '../src/core/session';

function buildOverdueSession(): RoutineSession {
  const now = new Date(10000);
  const target = new Date(now.getTime() - 10 * 60 * 1000);
  const first = createProgress({
    step: createStep({ title: '当前任务', duration: 5 * 60 }),
    dueAt: target,
  });
  const second = createProgress({
    step: createStep({ title: '后续任务', duration: 5 * 60 }),
    dueAt: new Date(target.getTime() + 5 * 60 * 1000),
  });
  const deadline = createProgress({
    step: createStep({ title: '完成', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
    dueAt: new Date(target.getTime() + 5 * 60 * 1000),
  });
  return createSession({
    templateID: 'T',
    templateName: '测试',
    templateSymbol: 'checkmark',
    startedAt: target,
    plannedStartAt: target,
    targetDeadline: target,
    state: 'running',
    primaryDevice: 'phone',
    progress: [first, second, deadline],
    remainingBuffer: 0,
    updatedAt: target,
    revision: 1,
  });
}

describe('session — 预计排程（M17/M18/M19，用例 8）', () => {
  it('用例 8：已逾期会话按 now 重新顺排，deadline 恒在末位', () => {
    const session = buildOverdueSession();
    const now = new Date(10000);
    const [first, second, deadline] = session.progress;

    const estimates = estimatedDueDates(session, now);
    expect(estimates.get(first.id)!.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
    expect(estimates.get(second.id)!.getTime()).toBe(now.getTime() + 10 * 60 * 1000);
    expect(estimates.get(deadline.id)!.getTime()).toBe(now.getTime() + 10 * 60 * 1000);

    expect(estimatedCompletion(session, now)!.getTime()).toBe(now.getTime() + 10 * 60 * 1000);
    expect(isLate(session, now)).toBe(true);
  });

  it('M17：无 active 时 cursor=now 正序顺排 remainingWork', () => {
    const session = buildOverdueSession();
    const now = new Date(10000);
    const estimates = estimatedDueDates(session, now);
    const [first, second] = session.progress;
    expect(
      estimates.get(second.id)!.getTime() - estimates.get(first.id)!.getTime(),
    ).toBe(5 * 60 * 1000);
  });

  it('M17：active 项排最前，estimated = max(dueAt, now)', () => {
    const session = buildOverdueSession();
    const now = new Date(10000);
    const [first, second, deadline] = session.progress;
    session.activeProgressID = second.id;
    session.progress = [
      { ...first },
      { ...second, state: 'active' },
      { ...deadline },
    ];
    const estimates = estimatedDueDates(session, now);
    // active(second) 排在最前，dueAt = target+300 < now → 夹到 now
    expect(estimates.get(second.id)!.getTime()).toBe(now.getTime());
    // 随后是 first：now + 300s
    expect(estimates.get(first.id)!.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
    // deadline 随推进变化 = max(cursor, now)
    expect(estimates.get(deadline.id)!.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
  });

  it('M18：无 deadline 节点时，estimatedCompletion = 最后一个未完成 task 的估计', () => {
    const now = new Date(10000);
    const a = createProgress({
      step: createStep({ title: 'A', duration: 5 * 60 }),
      dueAt: now,
    });
    const b = createProgress({
      step: createStep({ title: 'B', duration: 5 * 60 }),
      dueAt: now,
    });
    const session = createSession({
      templateID: 'T',
      templateName: '测试',
      templateSymbol: 'checkmark',
      startedAt: now,
      plannedStartAt: now,
      targetDeadline: null,
      state: 'running',
      primaryDevice: 'phone',
      progress: [a, b],
      remainingBuffer: 0,
      updatedAt: now,
      revision: 1,
    });
    expect(estimatedCompletion(session, now)!.getTime()).toBe(now.getTime() + 10 * 60 * 1000);
  });

  it('M19：无 targetDeadline 或无法估计 ⇒ isLate=false', () => {
    const session = buildOverdueSession();
    const now = new Date(10000);
    expect(isLate(session, now)).toBe(true);
    session.targetDeadline = null;
    expect(isLate(session, now)).toBe(false);
  });
});

describe('session — 基础派生态', () => {
  it('isIncomplete：pending/active/suspended 为 true', () => {
    expect(isIncomplete('pending')).toBe(true);
    expect(isIncomplete('active')).toBe(true);
    expect(isIncomplete('suspended')).toBe(true);
    expect(isIncomplete('completed')).toBe(false);
    expect(isIncomplete('skipped')).toBe(false);
  });
});
