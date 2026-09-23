import { describe, expect, it } from 'vitest';
import { emptyWidgetSnapshot, makeWidgetSnapshot, widgetEntry } from '../src/core/widget';
import {
  createProgress,
  createSession,
  createSnapshot,
  createStep,
  type MainlineWidgetSnapshot,
  type RoutineSnapshot,
} from '../src/core/types';

function overdueSnapshot(): { snapshot: RoutineSnapshot; now: Date } {
  const now = new Date(10000);
  const target = new Date(now.getTime() - 10 * 60 * 1000);
  const first = createProgress({
    step: createStep({ title: '当前任务', duration: 5 * 60 }),
    dueAt: target,
  });
  const deadline = createProgress({
    step: createStep({ title: '完成', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
    dueAt: target,
  });
  const session = createSession({
    templateID: 'T',
    templateName: '测试',
    templateSymbol: 'checkmark',
    startedAt: target,
    plannedStartAt: target,
    targetDeadline: target,
    state: 'running',
    primaryDevice: 'phone',
    progress: [first, deadline],
    remainingBuffer: 0,
    updatedAt: target,
    revision: 1,
  });
  return { snapshot: createSnapshot({ templates: [], activeSession: session, updatedAt: target }), now };
}

describe('widget — 快照与时间线', () => {
  it('无 running 会话 → 空快照', () => {
    const snapshot = createSnapshot({ templates: [], activeSession: null, updatedAt: new Date() });
    expect(makeWidgetSnapshot(snapshot, new Date())).toEqual(emptyWidgetSnapshot());
  });

  it('running 会话：延误 = max(0, 预计完成 − 目标截止)，isLate 相应置位', () => {
    const { snapshot, now } = overdueSnapshot();
    const widget = makeWidgetSnapshot(snapshot, now);
    expect(widget.hasActiveSession).toBe(true);
    expect(widget.sessionName).toBe('测试');
    // 预计完成 = 唯一任务完成时刻 = now+300s；目标截止 = now-600s ⇒ 延误 900s
    expect(widget.delayDuration).toBe(900);
    expect(widget.isLate).toBe(true);
  });

  it('当前 active 任务被带出标题/截止/硬截止标记', () => {
    const { snapshot, now } = overdueSnapshot();
    const session = snapshot.activeSession!;
    const active = session.progress[0];
    active.state = 'active';
    session.activeProgressID = active.id;

    const widget = makeWidgetSnapshot(snapshot, now);
    expect(widget.currentTitle).toBe('当前任务');
    expect(widget.currentDueAt?.getTime()).toBe(active.dueAt.getTime());
    expect(widget.originalDueAt?.getTime()).toBe(active.dueAt.getTime());
    expect(widget.isHardDeadline).toBe(false);
  });

  it('widgetEntry：叠加快照之后继续流逝的 live 延误', () => {
    const capturedAt = new Date(10000);
    const dueAt = new Date(10000);
    const snapshot: MainlineWidgetSnapshot = {
      capturedAt,
      currentTitle: '刷牙',
      currentDueAt: dueAt,
      originalDueAt: dueAt,
      isHardDeadline: false,
      estimatedCompletion: dueAt,
      isLate: false,
      delayDuration: 0,
      hasActiveSession: true,
      sessionName: '上班早晨',
    };
    const entry = widgetEntry(snapshot, new Date(10000 + 90 * 1000));
    expect(entry.delayDuration).toBe(90);
    expect(entry.isLate).toBe(true);
    expect(entry.estimatedCompletion?.getTime()).toBe(dueAt.getTime() + 90 * 1000);
  });

  it('widgetEntry：无进行中会话返回空条目', () => {
    const entry = widgetEntry(emptyWidgetSnapshot(), new Date());
    expect(entry.hasActiveSession).toBe(false);
    expect(entry.delayDuration).toBe(0);
  });
});
