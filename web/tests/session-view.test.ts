import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  estimatedCompletion,
  estimatedDueDates,
  isIncomplete,
  isLate,
  originalDueAt,
  setRoutineBridge,
  useRoutineStore,
} from '../src/stores/routine';
import * as coreSession from '../src/core/session';
import { createMockBridge } from '../src/platform/mock';
import type { PlatformBridge } from '../src/platform/bridge';
import {
  MORNING_TEMPLATE,
  createProgress,
  createSession,
  createStep,
  type RoutineSession,
  type StepProgress,
} from '../src/core/types';
import { formatClock, makeCompletionResult, reorderableItems } from '../src/views/session/helpers';

function setup(bridge: PlatformBridge = createMockBridge()): ReturnType<typeof useRoutineStore> {
  setRoutineBridge(bridge);
  setActivePinia(createPinia());
  return useRoutineStore();
}

function progress(overrides: {
  title?: string;
  dueAt: Date;
  plannedDueAt?: Date | null;
  state?: StepProgress['state'];
  role?: 'task' | 'deadline';
  isTemporary?: boolean;
  completedAt?: Date | null;
}): StepProgress {
  return createProgress({
    step: createStep({ title: overrides.title ?? '任务', duration: 300, role: overrides.role ?? 'task' }),
    dueAt: overrides.dueAt,
    plannedDueAt: overrides.plannedDueAt ?? null,
    state: overrides.state ?? 'pending',
    isTemporary: overrides.isTemporary ?? false,
    completedAt: overrides.completedAt ?? null,
  });
}

function session(overrides: Partial<RoutineSession> = {}): RoutineSession {
  const now = new Date(1_700_000_000_000);
  return createSession({
    templateID: 'T',
    templateName: '上班早晨',
    templateSymbol: 'sun.max.fill',
    startedAt: now,
    plannedStartAt: now,
    targetDeadline: null,
    state: 'running',
    primaryDevice: 'phone',
    progress: [],
    remainingBuffer: 600,
    updatedAt: now,
    revision: 1,
    ...overrides,
  });
}

beforeEach(() => {
  setRoutineBridge(null);
});

describe('stores/routine — 会话页门面重导出（与 core 逐一对齐）', () => {
  it('五个派生纯函数就是 core/session 的同名引用（门面未另起实现）', () => {
    expect(estimatedCompletion).toBe(coreSession.estimatedCompletion);
    expect(estimatedDueDates).toBe(coreSession.estimatedDueDates);
    expect(isIncomplete).toBe(coreSession.isIncomplete);
    expect(isLate).toBe(coreSession.isLate);
    expect(originalDueAt).toBe(coreSession.originalDueAt);
  });

  it('isIncomplete / originalDueAt 行为符合会话页用法', () => {
    expect(isIncomplete('suspended')).toBe(true);
    expect(isIncomplete('completed')).toBe(false);

    const dueAt = new Date(1_700_000_300_000);
    const planned = new Date(1_700_000_100_000);
    expect(originalDueAt(progress({ dueAt, plannedDueAt: planned }))).toEqual(planned);
    // plannedDueAt 为空 → 回落 dueAt。
    expect(originalDueAt(progress({ dueAt, plannedDueAt: null }))).toEqual(dueAt);
  });

  it('estimatedCompletion / estimatedDueDates / isLate 经门面可用于会话页', () => {
    const now = new Date(10_000);
    const target = new Date(now.getTime() + 10 * 60 * 1000);
    const active = progress({ title: '当前', dueAt: new Date(now.getTime() + 5 * 60 * 1000), state: 'active' });
    const deadline = progress({
      title: '出门',
      dueAt: target,
      role: 'deadline',
      state: 'pending',
    });
    const s = session({
      targetDeadline: target,
      activeProgressID: active.id,
      progress: [active, deadline],
    });

    const estimates = estimatedDueDates(s, now);
    expect(estimates.get(active.id)!.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
    expect(estimatedCompletion(s, now)!.getTime()).toBe(estimates.get(deadline.id)!.getTime());
    expect(isLate(s, now)).toBe(false);
  });

  it('经 Pinia store 端到端：start 后 session 可用门面派生（含 isLate）', async () => {
    const store = setup();
    await store.ensureReady();
    store.start(MORNING_TEMPLATE);
    const s = store.session;
    expect(s).not.toBeNull();
    const at = new Date();
    // 首项 dueAt 在未来 → 未迟到；estimatedCompletion 有值。
    expect(estimatedCompletion(s!, at)).not.toBeNull();
    expect(isIncomplete(s!.progress[0].state)).toBe(true);
    expect(typeof isLate(s!, at)).toBe('boolean');
  });
});

describe('views/session/helpers — formatClock', () => {
  it('零填充 24 小时 HH:mm（对应 Swift .shortened）', () => {
    expect(formatClock(new Date(2026, 7, 13, 8, 5))).toBe('08:05');
    expect(formatClock(new Date(2026, 7, 13, 18, 30))).toBe('18:30');
    expect(formatClock(new Date(2026, 7, 13, 0, 0))).toBe('00:00');
  });
});

describe('views/session/helpers — makeCompletionResult（ContentView 236–270）', () => {
  const completedAt = new Date(2026, 7, 13, 18, 30);

  function withCompleted(target: Date | null): RoutineSession {
    return session({
      targetDeadline: target,
      progress: [
        progress({ title: '去厕所', dueAt: completedAt, state: 'completed', completedAt }),
        progress({
          title: '完成',
          dueAt: completedAt,
          role: 'deadline',
          state: 'completed',
          completedAt,
        }),
      ],
    });
  }

  it('无 deadline → 「恭喜你，完成啦」/「完成」/ plannedTime 为空', () => {
    const result = makeCompletionResult(withCompleted(null));
    expect(result.headline).toBe('恭喜你，完成啦');
    expect(result.emphasis).toBe('完成');
    expect(result.isAhead).toBe(false);
    expect(result.plannedTime).toBeNull();
    expect(result.completedAt).toEqual(completedAt);
  });

  it('提前 5 分钟 → 「成功提前了」/「5 分钟」/ isAhead=true', () => {
    const target = new Date(completedAt.getTime() + 5 * 60 * 1000);
    const result = makeCompletionResult(withCompleted(target));
    expect(result.headline).toBe('恭喜你，成功提前了');
    expect(result.emphasis).toBe('5 分钟');
    expect(result.isAhead).toBe(true);
    expect(result.plannedTime).toBe('18:35');
  });

  it('延误 2 分钟 → 「你本次延误了」/「2 分钟」/ isAhead=false', () => {
    const target = new Date(completedAt.getTime() - 2 * 60 * 1000);
    const result = makeCompletionResult(withCompleted(target));
    expect(result.headline).toBe('很遗憾，你本次延误了');
    expect(result.emphasis).toBe('2 分钟');
    expect(result.isAhead).toBe(false);
  });

  it('±60 秒内 → 「刚刚好完成」/「准时」', () => {
    expect(makeCompletionResult(withCompleted(new Date(completedAt.getTime() + 30_000))).headline).toBe(
      '恭喜你，刚刚好完成',
    );
    expect(makeCompletionResult(withCompleted(new Date(completedAt.getTime() + 30_000))).emphasis).toBe(
      '准时',
    );
    expect(makeCompletionResult(withCompleted(new Date(completedAt.getTime() - 30_000))).headline).toBe(
      '恭喜你，刚刚好完成',
    );
    // -30s：offset<0 但 |offset|<60 → isAhead=false。
    expect(makeCompletionResult(withCompleted(new Date(completedAt.getTime() - 30_000))).isAhead).toBe(
      false,
    );
  });

  it('向下取整到整分钟：90 秒 → 1 分钟；3600 秒 → 60 分钟', () => {
    expect(
      makeCompletionResult(withCompleted(new Date(completedAt.getTime() + 90 * 1000))).emphasis,
    ).toBe('1 分钟');
    expect(
      makeCompletionResult(withCompleted(new Date(completedAt.getTime() + 3600 * 1000))).emphasis,
    ).toBe('60 分钟');
  });

  it('completedAt 取所有已完成项的 max；全空时回落 fallbackNow', () => {
    const earlier = new Date(completedAt.getTime() - 60 * 1000);
    const later = new Date(completedAt.getTime() + 120 * 1000);
    const s = session({
      targetDeadline: null,
      progress: [
        progress({ dueAt: earlier, state: 'completed', completedAt: earlier }),
        progress({ dueAt: later, state: 'completed', completedAt: later }),
      ],
    });
    expect(makeCompletionResult(s).completedAt).toEqual(later);

    const fallback = new Date(2_000_000_000_000);
    const none = session({
      targetDeadline: null,
      progress: [progress({ dueAt: completedAt, state: 'pending' })],
    });
    expect(makeCompletionResult(none, fallback).completedAt).toEqual(fallback);
  });
});

describe('views/session/helpers — reorderableItems（ContentView 1052–1058）', () => {
  it('仅保留「未完成 + task + 非 active」', () => {
    const active = progress({ title: '当前', dueAt: new Date(1), state: 'active' });
    const pending = progress({ title: '待办', dueAt: new Date(1) });
    const done = progress({ title: '已完成', dueAt: new Date(1), state: 'completed' });
    const deadline = progress({ title: '完成', dueAt: new Date(1), role: 'deadline' });
    const s = session({
      activeProgressID: active.id,
      progress: [active, pending, done, deadline],
    });
    expect(reorderableItems(s).map((item) => item.id)).toEqual([pending.id]);
  });
});
