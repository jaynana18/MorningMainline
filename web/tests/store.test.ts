import { describe, expect, it } from 'vitest';
import { RoutineStore } from '../src/core/store';
import {
  cloneTemplate,
  createStep,
  HOMEWORK_TEMPLATE,
  MORNING_TEMPLATE,
  type RoutineSession,
} from '../src/core/types';
import { estimatedCompletion, isLate } from '../src/core/session';
import { byTitle, formatHM, localDate, TZ } from './helpers';

function makeStore(now: Date): RoutineStore {
  return new RoutineStore({ deviceRole: 'phone', deviceID: 'dev-1', tz: TZ, now: () => now });
}

function startMorning(store: RoutineStore, now: Date): RoutineSession {
  store.start(cloneTemplate(MORNING_TEMPLATE), null, null, now);
  return store.session!;
}

describe('store — 缓冲不可被延误挪用 / 延误整体后移（M3/M4 / G7）', () => {
  const NOW = localDate(2026, 8, 13, 7, 0);

  it('start：倒推计划开始 = 08:00，remainingBuffer = 600', () => {
    const store = makeStore(NOW);
    const session = startMorning(store, NOW);
    expect(session.remainingBuffer).toBe(600);
    expect(session.plannedStartAt.getTime()).toBe(localDate(2026, 8, 13, 8, 0).getTime());
    expect(session.targetDeadline!.getTime()).toBe(localDate(2026, 8, 13, 8, 35).getTime());
    expect(session.revision).toBe(1);
  });

  it('M3/M4：snooze 只后移未完成项 dueAt，绝不改动 remainingBuffer', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    store.startProgress(byTitle(store.session!, '刷牙'));
    const before = byTitle(store.session!, '下楼').dueAt.getTime();

    store.snoozeCurrent(120);

    expect(store.session!.remainingBuffer).toBe(600);
    expect(byTitle(store.session!, '下楼').dueAt.getTime()).toBe(before + 120 * 1000);
    expect(byTitle(store.session!, '刷牙').snoozeCount).toBe(1);
  });

  it('G7：afterCurrent 临时任务使其后项 +300s，且缓冲仍为 600', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    store.startProgress(byTitle(store.session!, '刷牙'));
    const before = byTitle(store.session!, '下楼').dueAt.getTime();

    store.addTemporaryTask('接电话', 5, 'afterCurrent');

    const session = store.session!;
    expect(session.remainingBuffer).toBe(600);
    const temp = byTitle(session, '接电话');
    expect(temp.isTemporary).toBe(true);
    expect(temp.step.duration).toBe(5 * 60);
    expect(temp.state).toBe('pending');
    expect(byTitle(session, '下楼').dueAt.getTime()).toBe(before + 300 * 1000);
  });

  it('consumeDelay 只迁移 index ≥ 起点且未完成项（绝不前移）', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    // 完成「洗脸」后再 snooze「刷牙」：已完成的项不再被后移
    store.startProgress(byTitle(store.session!, '刷牙'));
    store.complete(byTitle(store.session!, '刷牙'));
    const 弄头发Before = byTitle(store.session!, '弄头发').dueAt.getTime();
    store.snoozeCurrent(60);
    expect(byTitle(store.session!, '弄头发').dueAt.getTime()).toBeGreaterThanOrEqual(弄头发Before);
  });
});

describe('store — 任务线生命周期（M20/M21 / G2/G8/G9/G10/G11/G12/G13）', () => {
  const NOW = localDate(2026, 8, 13, 7, 0);

  it('M21：进入任务线不等于开始计时（activeProgressID 初始为 null）', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    expect(store.session!.activeProgressID).toBeNull();
    store.startProgress(byTitle(store.session!, '刷牙'));
    expect(store.session!.activeProgressID).toBe(byTitle(store.session!, '刷牙').id);
  });

  it('G2：无截止 forward 模板顺排，targetDeadline=null，isLate=false', () => {
    const noon = localDate(2026, 8, 13, 12, 0);
    const store = makeStore(noon);
    store.start(cloneTemplate(HOMEWORK_TEMPLATE), null, null, noon);
    const session = store.session!;
    expect(session.targetDeadline).toBeNull();
    expect(session.progress.map((progress) => formatHM(progress.dueAt))).toEqual([
      '14:00',
      '15:00',
      '15:30',
    ]);
    expect(estimatedCompletion(session, noon)!.getTime()).toBe(
      localDate(2026, 8, 13, 15, 30).getTime(),
    );
    expect(isLate(session, noon)).toBe(false);
  });

  it('G8/M20：完成最后一项实际任务 → 末尾 Deadline 自动完成，会话 completed', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    for (const title of ['刷牙', '洗脸', '弄头发', '装午饭', '下楼']) {
      store.complete(byTitle(store.session!, title));
    }
    const session = store.session!;
    expect(session.state).toBe('completed');
    expect(byTitle(session, '出门').state).toBe('completed');
    expect(byTitle(session, '出门').remainingDuration).toBe(0);
  });

  it('G9：提前完成 → 后续项从真实完成时刻起顺排', () => {
    const store = makeStore(localDate(2026, 8, 13, 12, 0));
    store.start(cloneTemplate(HOMEWORK_TEMPLATE), null, null, localDate(2026, 8, 13, 12, 0));
    store.startProgress(byTitle(store.session!, '语文'), localDate(2026, 8, 13, 12, 0));
    store.complete(byTitle(store.session!, '语文'), localDate(2026, 8, 13, 11, 50));
    const session = store.session!;
    expect(byTitle(session, '英语').dueAt.getTime()).toBe(
      localDate(2026, 8, 13, 12, 50).getTime(),
    );
    expect(byTitle(session, '数学').dueAt.getTime()).toBe(
      localDate(2026, 8, 13, 13, 20).getTime(),
    );
  });

  it('G10：addTemporaryTask(.now) 挂起当前任务、临时项置顶为 active、其后 +300s', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    store.startProgress(byTitle(store.session!, '刷牙'));

    store.addTemporaryTask('接电话', 5, 'now');

    const session = store.session!;
    const temp = byTitle(session, '接电话');
    expect(session.progress[0].id).toBe(temp.id);
    expect(temp.state).toBe('active');
    expect(temp.startedAt!.getTime()).toBe(NOW.getTime());
    expect(session.activeProgressID).toBe(temp.id);
    const suspended = byTitle(session, '刷牙');
    expect(suspended.state).toBe('suspended');
    expect(session.suspendedProgressIDs).toContain(suspended.id);
  });

  it('G11：挂起/恢复栈 —— 启动新任务挂起当前，完成后恢复最近挂起', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    store.startProgress(byTitle(store.session!, '刷牙'));
    store.startProgress(byTitle(store.session!, '洗脸'));

    let session = store.session!;
    expect(byTitle(session, '刷牙').state).toBe('suspended');
    expect(byTitle(session, '洗脸').state).toBe('active');
    expect(session.suspendedProgressIDs).toEqual([byTitle(session, '刷牙').id]);

    store.complete(byTitle(session, '洗脸'));
    session = store.session!;
    expect(byTitle(session, '刷牙').state).toBe('active');
    expect(session.activeProgressID).toBe(byTitle(session, '刷牙').id);
  });

  it('G12：reorderPendingTasks 集合不等 → no-op；相等 → 按传入顺序重排', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    const ids = store.session!.progress
      .filter((progress) => progress.step.role === 'task')
      .map((progress) => progress.id);

    const revisionBefore = store.session!.revision;
    store.reorderPendingTasks([...ids, 'extra-id']);
    expect(store.session!.revision).toBe(revisionBefore);

    const reversed = [...ids].reverse();
    store.reorderPendingTasks(reversed);
    const reordered = store.session!.progress
      .filter((progress) => progress.step.role === 'task')
      .map((progress) => progress.id);
    expect(reordered).toEqual(reversed);
  });

  it('G13：删除会话内任务不改模板；删除 active 后恢复/顺延下一项', () => {
    const store = makeStore(NOW);
    const templateStepCount = cloneTemplate(MORNING_TEMPLATE).steps.length;
    startMorning(store, NOW);

    store.deleteFromCurrentSession(byTitle(store.session!, '洗脸'));
    expect(store.session!.progress.some((progress) => progress.step.title === '洗脸')).toBe(false);
    expect(store.template(MORNING_TEMPLATE.id)!.steps).toHaveLength(templateStepCount);

    store.startProgress(byTitle(store.session!, '刷牙'));
    store.deleteFromCurrentSession(byTitle(store.session!, '刷牙'));
    const session = store.session!;
    expect(session.progress.some((progress) => progress.step.title === '刷牙')).toBe(false);
    expect(session.activeProgressID).not.toBeNull();
  });

  it('cancel / finish 只改会话状态', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    store.cancel();
    expect(store.session!.state).toBe('cancelled');
    store.finish();
    expect(store.session!.state).toBe('completed');
  });

  it('addTemplate / template / nextProgress / currentProgress', () => {
    const store = makeStore(NOW);
    const custom = cloneTemplate(HOMEWORK_TEMPLATE);
    custom.id = 'custom-1';
    custom.name = '自定义';
    store.addTemplate(custom);
    expect(store.snapshot.templates[0].id).toBe('custom-1');
    expect(store.template('custom-1')?.name).toBe('自定义');

    startMorning(store, NOW);
    expect(store.nextProgress).toHaveLength(6);
    expect(store.currentProgress).toBeNull();
    store.startProgress(byTitle(store.session!, '刷牙'));
    expect(store.currentProgress?.step.title).toBe('刷牙');
  });

  it('commit 钩子在每次变更后被调用，并刷新 originID/updatedAt', () => {
    const NOW2 = localDate(2026, 8, 13, 7, 0);
    let commits = 0;
    const store = new RoutineStore({
      deviceRole: 'pad',
      deviceID: 'dev-2',
      tz: TZ,
      now: () => NOW2,
      onCommit: () => {
        commits += 1;
      },
    });
    store.start(cloneTemplate(HOMEWORK_TEMPLATE), null, null, NOW2);
    expect(commits).toBe(1);
    expect(store.snapshot.originID).toBe('dev-2');
    expect(store.snapshot.updatedAt.getTime()).toBe(NOW2.getTime());
    expect(store.session!.primaryDevice).toBe('pad');
  });

  it('backward 但无 deadline 时 deadline 步当 0 时长任务落入普通分支', () => {
    // deadlineHour/Minute 为 null 的 backward 模板
    const template = cloneTemplate(MORNING_TEMPLATE);
    template.mode = 'backward';
    template.deadlineHour = null;
    template.deadlineMinute = null;
    const store = makeStore(NOW);
    store.start(template, null, null, NOW);
    const session = store.session!;
    expect(session.targetDeadline).toBeNull();
    const deadlineProgress = session.progress.find((p) => p.step.role === 'deadline')!;
    expect(deadlineProgress.remainingDuration).toBe(0);
  });

  it('start 的 guard：非 running / 非 task / 已完成项不激活', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    const deadlineProgress = byTitle(store.session!, '出门'); // role=deadline
    store.startProgress(deadlineProgress);
    expect(store.session!.activeProgressID).toBeNull();

    const notInSession = { ...byTitle(store.session!, '刷牙'), id: 'ghost' };
    store.startProgress(notInSession);
    expect(store.session!.activeProgressID).toBeNull();
  });

  it('complete 的 guard：不在会话中的进度被忽略', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    const revision = store.session!.revision;
    store.complete({ ...byTitle(store.session!, '刷牙'), id: 'ghost' });
    expect(store.session!.revision).toBe(revision);
  });

  it('addTemporaryTask 的 guard：minutes <= 0 不生效', () => {
    const store = makeStore(NOW);
    startMorning(store, NOW);
    const before = store.session!.progress.length;
    store.addTemporaryTask('无效', 0, 'now');
    expect(store.session!.progress).toHaveLength(before);
  });

  it('无会话时各操作安全 no-op', () => {
    const store = new RoutineStore({ deviceRole: 'phone', deviceID: 'd', tz: TZ, now: () => NOW });
    expect(store.session).toBeNull();
    store.complete(createStepProgressForTest());
    store.snoozeCurrent();
    store.reorderPendingTasks(['x']);
    store.cancel();
    expect(store.session).toBeNull();
  });
});

function createStepProgressForTest() {
  return {
    id: 'p',
    step: createStep({ title: 'x', duration: 1 }),
    dueAt: new Date(),
    state: 'pending' as const,
    snoozeCount: 0,
    completedAt: null,
    isTemporary: false,
    plannedDueAt: null,
    remainingDuration: null,
    startedAt: null,
  };
}
