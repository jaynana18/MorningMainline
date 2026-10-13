/**
 * core/store.ts — RoutineStore 状态机（LOGIC_PORT_SPEC §3）。
 *
 * 纯内存状态机：不碰 UserDefaults / WCSession / 通知调度；副作用（持久化、广播、重排通知）
 * 通过构造注入的 `onCommit` 收口，便于跨端复用与单测。
 *
 * 三条硬约束：
 *   - 缓冲不可被延误挪用（§5.3 / M3）：`remainingBuffer` 初始化后永不被修改；
 *   - 延误是整条时间线后移（M4）：`consumeDelay` 只对 `index ≥ 起点且未完成` 的项 `dueAt += seconds`；
 *   - 末尾 Deadline 在最后一项实际任务完成时自动完成（M20）。
 */

import type {
  DeviceRole,
  RoutineSession,
  RoutineSnapshot,
  RoutineTemplate,
  StepProgress,
  TemporaryTaskPlacement,
} from './types';
import { createProgress, createSession, createStep, initialSnapshot, randomUUID } from './types';
import {
  deadlineOn,
  isIncomplete,
  remainingWork,
  totalTaskDuration,
} from './session';
import { applyIncoming } from './conflict';
import { defaultTimeZone } from './serialization';

export interface RoutineStoreOptions {
  deviceRole: DeviceRole;
  deviceID?: string;
  tz?: string;
  initialSnapshot?: RoutineSnapshot;
  /** commit 副作用钩子（持久化 / 广播 / 重排通知）。默认 no-op。 */
  onCommit?: (snapshot: RoutineSnapshot) => void;
  /** 可注入时钟，便于确定性测试。默认 `() => new Date()`。 */
  now?: () => Date;
}

export class RoutineStore {
  readonly deviceRole: DeviceRole;

  private _snapshot: RoutineSnapshot;
  private readonly deviceID: string;
  private readonly tz: string;
  private readonly onCommit: (snapshot: RoutineSnapshot) => void;
  private readonly clock: () => Date;

  constructor(options: RoutineStoreOptions) {
    this.deviceRole = options.deviceRole;
    this.deviceID = options.deviceID ?? randomUUID();
    this.tz = options.tz ?? defaultTimeZone();
    this._snapshot = options.initialSnapshot ?? initialSnapshot();
    this.onCommit = options.onCommit ?? (() => {});
    this.clock = options.now ?? (() => new Date());
  }

  get snapshot(): RoutineSnapshot {
    return this._snapshot;
  }

  get deviceId(): string {
    return this.deviceID;
  }

  // ---- §3.0 只读派生 ----

  get session(): RoutineSession | null {
    return this._snapshot.activeSession;
  }

  get currentProgress(): StepProgress | null {
    const session = this._snapshot.activeSession;
    if (!session || session.state !== 'running' || session.activeProgressID === null) {
      return null;
    }
    return (
      session.progress.find(
        (item) => item.id === session.activeProgressID && item.state === 'active',
      ) ?? null
    );
  }

  get nextProgress(): StepProgress[] {
    const session = this._snapshot.activeSession;
    if (!session) {
      return [];
    }
    return session.progress.filter((item) => isIncomplete(item.state));
  }

  template(id: string): RoutineTemplate | undefined {
    return this._snapshot.templates.find((template) => template.id === id);
  }

  /** 插入到 0 位后 commit。 */
  addTemplate(template: RoutineTemplate): void {
    this._snapshot.templates.unshift(template);
    this.commit();
  }

  /** 修改模板不改写已经启动的会话。 */
  replaceTemplate(template: RoutineTemplate): void {
    const index = this._snapshot.templates.findIndex((item) => item.id === template.id);
    if (index < 0) return;
    this._snapshot.templates[index] = template;
    this.commit();
  }

  /** 删除任务线模板，执行中的会话保留自己的步骤快照。 */
  deleteTemplate(id: string): void {
    const index = this._snapshot.templates.findIndex(template => template.id === id);
    if (index < 0) return;
    this._snapshot.templates.splice(index, 1);
    this.commit();
  }

  // ---- §3.1 启动会话 ----

  start(
    template: RoutineTemplate,
    deadlineOverride: Date | null = null,
    bufferOverride: number | null = null,
    now: Date = this.clock(),
  ): void {
    const deadline =
      template.mode === 'backward' ? deadlineOverride ?? deadlineOn(template, now, this.tz) : null;
    const selectedBuffer = Math.max(0, bufferOverride ?? template.buffer);
    const totalTask = totalTaskDuration(template);
    const plannedStart =
      deadline !== null
        ? new Date(deadline.getTime() - (totalTask + selectedBuffer) * 1000)
        : now;
    let cursor = template.mode === 'backward' ? plannedStart.getTime() : now.getTime();
    const availableSlack =
      deadline !== null ? (deadline.getTime() - now.getTime()) / 1000 - totalTask : null;
    // 缓冲是计划的固定安全垫，不会被后续延误消耗。
    const remainingBuffer = selectedBuffer;
    const deadlineOverrun = Math.max(0, -(availableSlack ?? 0));
    const progress: StepProgress[] = [];

    for (const step of template.steps) {
      if (step.role === 'deadline' && deadline !== null) {
        progress.push(
          createProgress({
            step,
            dueAt: new Date(deadline.getTime() + deadlineOverrun * 1000),
            plannedDueAt: deadline,
          }),
        );
        continue;
      }
      cursor += step.duration * 1000;
      progress.push(
        createProgress({
          step,
          dueAt: new Date(cursor),
          plannedDueAt: new Date(cursor),
          remainingDuration: step.duration,
        }),
      );
    }

    this._snapshot.activeSession = createSession({
      templateID: template.id,
      templateName: template.name,
      templateSymbol: template.symbol,
      startedAt: now,
      plannedStartAt: plannedStart,
      targetDeadline: deadline,
      state: 'running',
      primaryDevice: this.deviceRole,
      progress,
      remainingBuffer,
      updatedAt: now,
      revision: 1,
    });
    this.commit(now);
  }

  /** 点击某一项「开始」→ 它才成为当前任务（§3.2）。 */
  startProgress(progress: StepProgress, now: Date = this.clock()): void {
    const session = this._snapshot.activeSession;
    if (
      !session ||
      session.state !== 'running' ||
      progress.step.role !== 'task' ||
      !isIncomplete(progress.state) ||
      !session.progress.some((item) => item.id === progress.id)
    ) {
      return;
    }

    this.activate(progress.id, session, now, true);
    session.revision += 1;
    session.updatedAt = now;
    this.commit(now);
  }

  /** 启动一个最多两项的并行组；组内任务共享起点，各自按自己的时长计时。 */
  startParallelProgress(progressIDs: string[], now: Date = this.clock()): void {
    const session = this._snapshot.activeSession;
    const ids = [...new Set(progressIDs)].slice(0, 2);
    if (!session || session.state !== 'running' || session.activeProgressID !== null || ids.length < 2) {
      return;
    }

    const selected = ids
      .map((id) => session.progress.find((item) => item.id === id))
      .filter(
        (item): item is StepProgress =>
          item !== undefined &&
          item.step.role === 'task' &&
          (item.state === 'pending' || item.state === 'suspended'),
      );
    if (selected.length !== ids.length) return;

    session.progress = [
      ...selected,
      ...session.progress.filter((item) => !ids.includes(item.id)),
    ];
    for (const item of selected) {
      item.state = 'active';
      item.startedAt = now;
      item.dueAt = new Date(now.getTime() + remainingWork(item) * 1000);
    }
    session.activeProgressID = selected[0].id;
    session.suspendedProgressIDs = (session.suspendedProgressIDs ?? []).filter(
      (id) => !ids.includes(id),
    );
    this.recalculateExpectedSchedule(session, now);
    session.revision += 1;
    session.updatedAt = now;
    this.commit(now);
  }

  // ---- §3.3 完成 ----

  complete(progress: StepProgress, now: Date = this.clock()): void {
    const session = this._snapshot.activeSession;
    if (!session) {
      return;
    }
    const index = session.progress.findIndex((item) => item.id === progress.id);
    if (index < 0) {
      return;
    }

    const wasActive = session.activeProgressID === progress.id;
    session.progress[index].state = 'completed';
    session.progress[index].completedAt = now;
    // 已发生任务保留真实起点，供时间轴在完成后继续固定显示开始/结束边界。
    session.progress[index].remainingDuration = 0;
    if (wasActive) {
      session.activeProgressID =
        session.progress.find((item) => item.state === 'active' && item.id !== progress.id)?.id ??
        null;
    }

    const onlyDeadlineRemains =
      progress.step.role === 'task' &&
      session.progress.every(
        (item) => !isIncomplete(item.state) || item.step.role === 'deadline',
      );

    if (onlyDeadlineRemains) {
      // 最后一项实际任务完成即代表整条任务线完成；末尾 Deadline 不再要求二次确认。
      for (let i = 0; i < session.progress.length; i += 1) {
        if (session.progress[i].step.role === 'deadline' && isIncomplete(session.progress[i].state)) {
          session.progress[i].state = 'completed';
          session.progress[i].completedAt = now;
          session.progress[i].remainingDuration = 0;
        }
      }
      session.state = 'completed';
    } else {
      this.resumeMostRecentTaskIfNeeded(session, now);
      this.startNextTaskIfNeeded(session, now);
      this.recalculateExpectedSchedule(session, now);
    }

    session.revision += 1;
    session.updatedAt = now;
    if (session.progress.every((item) => !isIncomplete(item.state))) {
      session.state = 'completed';
    }
    this.commit(now);
  }

  // ---- §3.4 稍后提醒 ----

  snoozeCurrent(by = 2 * 60, now: Date = this.clock()): void {
    const current = this.currentProgress;
    if (!current) {
      return;
    }
    this.applyDelay(current.id, by, true, now);
  }

  // ---- §3.7 临时任务 ----

  addTemporaryTask(
    title: string,
    minutes: number,
    placement: TemporaryTaskPlacement,
    now: Date = this.clock(),
  ): void {
    const session = this._snapshot.activeSession;
    if (!session || !(minutes > 0)) {
      return;
    }

    const duration = minutes * 60;
    const temporary = createStep({
      title,
      prompt: '这是临时插入的事，做完立刻回主线',
      duration,
    });

    const temporaryProgress = createProgress({
      step: temporary,
      dueAt: new Date(now.getTime() + duration * 1000),
      state: placement === 'now' ? 'active' : 'pending',
      isTemporary: true,
      plannedDueAt: new Date(now.getTime() + duration * 1000),
      remainingDuration: duration,
      startedAt: placement === 'now' ? now : null,
    });

    if (placement === 'now') {
      this.suspendCurrentTask(session, now);
      session.progress.unshift(temporaryProgress);
      session.activeProgressID = temporaryProgress.id;
      this.consumeDelay(session, 1, duration);
    } else {
      const currentIndex =
        session.activeProgressID !== null
          ? session.progress.findIndex((item) => item.id === session.activeProgressID)
          : -1;
      const insertionIndex =
        currentIndex >= 0 ? Math.min(currentIndex + 1, session.progress.length) : 0;
      session.progress.splice(insertionIndex, 0, temporaryProgress);
      this.consumeDelay(session, insertionIndex + 1, duration);
    }

    this.recalculateExpectedSchedule(session, now);
    session.revision += 1;
    session.updatedAt = now;
    this.commit(now);
  }

  // ---- §3.8 重排未完成项 ----

  reorderPendingTasks(ids: string[], now: Date = this.clock()): void {
    const session = this._snapshot.activeSession;
    if (!session) {
      return;
    }

    const activeID = session.activeProgressID;
    const reorderable = session.progress.filter(
      (item) => isIncomplete(item.state) && item.step.role === 'task' && item.id !== activeID,
    );
    if (!setEquals(new Set(ids), new Set(reorderable.map((item) => item.id)))) {
      return;
    }

    const byID = new Map(reorderable.map((item) => [item.id, item]));
    const ordered = ids
      .map((id) => byID.get(id))
      .filter((item): item is StepProgress => item !== undefined);
    let cursor = 0;

    for (let i = 0; i < session.progress.length; i += 1) {
      const item = session.progress[i];
      if (isIncomplete(item.state) && item.step.role === 'task' && item.id !== activeID) {
        if (cursor < ordered.length) {
          session.progress[i] = ordered[cursor];
          cursor += 1;
        }
      }
    }

    this.recalculateExpectedSchedule(session, now);
    session.revision += 1;
    session.updatedAt = now;
    this.commit(now);
  }

  // ---- §3.9 会话内删除 ----

  deleteFromCurrentSession(progress: StepProgress, now: Date = this.clock()): void {
    const session = this._snapshot.activeSession;
    if (!session || progress.step.role !== 'task') {
      return;
    }
    const index = session.progress.findIndex((item) => item.id === progress.id);
    if (index < 0) {
      return;
    }

    const wasActive = session.activeProgressID === progress.id;
    session.progress.splice(index, 1);
    if (session.suspendedProgressIDs) {
      session.suspendedProgressIDs = session.suspendedProgressIDs.filter(
        (id) => id !== progress.id,
      );
    }
    if (wasActive) {
      session.activeProgressID = null;
      this.resumeMostRecentTaskIfNeeded(session, now);
      this.startNextTaskIfNeeded(session, now);
    }

    this.recalculateExpectedSchedule(session, now);
    session.revision += 1;
    session.updatedAt = now;
    if (session.progress.every((item) => !isIncomplete(item.state))) {
      session.state = 'completed';
    }
    this.commit(now);
  }

  // ---- §3.10 取消 / 结束 ----

  cancel(): void {
    if (this._snapshot.activeSession) {
      this._snapshot.activeSession.state = 'cancelled';
    }
    this.commit();
  }

  finish(): void {
    if (this._snapshot.activeSession) {
      this._snapshot.activeSession.state = 'completed';
    }
    this.commit();
  }

  // ---- 远端快照采纳（§4 冲突裁决） ----

  applyIncomingSnapshot(incoming: RoutineSnapshot): boolean {
    const next = applyIncoming(incoming, this._snapshot, this.deviceID);
    if (next === this._snapshot) {
      return false;
    }
    this._snapshot = next;
    this.onCommit(this._snapshot);
    return true;
  }

  // ---- 私有：§3.5 / §3.6 延误 ----

  private applyDelay(
    progressID: string,
    seconds: number,
    incrementSnooze: boolean,
    now: Date = this.clock(),
  ): void {
    const session = this._snapshot.activeSession;
    if (!session) {
      return;
    }
    const index = session.progress.findIndex((item) => item.id === progressID);
    if (index < 0) {
      return;
    }

    this.consumeDelay(session, index, seconds);
    if (incrementSnooze) {
      session.progress[index].snoozeCount += 1;
    }

    session.revision += 1;
    session.updatedAt = now;
    this.commit(now);
  }

  /** 延误代表整条时间线后移；固定缓冲只用于计划展示，不参与扣减。 */
  private consumeDelay(session: RoutineSession, startingAt: number, seconds: number): void {
    if (!(seconds > 0) || startingAt >= session.progress.length) {
      return;
    }
    for (let i = startingAt; i < session.progress.length; i += 1) {
      if (isIncomplete(session.progress[i].state)) {
        session.progress[i].dueAt = new Date(session.progress[i].dueAt.getTime() + seconds * 1000);
      }
    }
  }

  // ---- 私有：§3.11 重算预计排程 ----

  private recalculateExpectedSchedule(session: RoutineSession, now: Date = this.clock()): void {
    let cursor = now.getTime();
    for (let i = 0; i < session.progress.length; i += 1) {
      if (!isIncomplete(session.progress[i].state)) {
        continue;
      }
      if (session.progress[i].step.role === 'deadline') {
        session.progress[i].dueAt = new Date(cursor);
        continue;
      }
      if (session.progress[i].state === 'active') {
        session.progress[i].dueAt = new Date(
          Math.max(session.progress[i].dueAt.getTime(), now.getTime()),
        );
      } else {
        session.progress[i].dueAt = new Date(cursor + remainingWork(session.progress[i]) * 1000);
      }
      // 并行任务可能长短不同，游标只能向后走，不能被较短支线拉回。
      cursor = Math.max(cursor, session.progress[i].dueAt.getTime());
    }
  }

  // ---- 私有：§3.12 激活 ----

  private activate(
    progressID: string,
    session: RoutineSession,
    now: Date,
    suspendingCurrent: boolean,
  ): void {
    if (suspendingCurrent && session.activeProgressID !== progressID) {
      this.suspendCurrentTask(session, now);
    }

    const sourceIndex = session.progress.findIndex((item) => item.id === progressID);
    if (sourceIndex < 0) {
      return;
    }
    const [selected] = session.progress.splice(sourceIndex, 1);
    selected.state = 'active';
    selected.startedAt = now;
    selected.dueAt = new Date(now.getTime() + remainingWork(selected) * 1000);
    session.progress.unshift(selected);
    session.activeProgressID = selected.id;
    if (session.suspendedProgressIDs) {
      session.suspendedProgressIDs = session.suspendedProgressIDs.filter(
        (id) => id !== selected.id,
      );
    }
    this.recalculateExpectedSchedule(session, now);
  }

  // ---- 私有：§3.13 挂起当前任务 ----

  private suspendCurrentTask(session: RoutineSession, now: Date): void {
    const activeID = session.activeProgressID;
    if (activeID === null) {
      return;
    }
    const index = session.progress.findIndex((item) => item.id === activeID);
    if (index < 0 || session.progress[index].state !== 'active') {
      return;
    }

    session.progress[index].remainingDuration = Math.max(
      0,
      (session.progress[index].dueAt.getTime() - now.getTime()) / 1000,
    );
    session.progress[index].state = 'suspended';
    session.progress[index].startedAt = null;

    const stack = (session.suspendedProgressIDs ?? []).filter((id) => id !== activeID);
    stack.push(activeID);
    session.suspendedProgressIDs = stack;
    session.activeProgressID = null;
  }

  // ---- 私有：§3.14 恢复最近挂起任务 ----

  private resumeMostRecentTaskIfNeeded(session: RoutineSession, now: Date): void {
    if (session.activeProgressID !== null) {
      return;
    }
    const stack = [...(session.suspendedProgressIDs ?? [])];
    while (stack.length > 0) {
      const candidate = stack.pop() as string;
      const item = session.progress.find((progress) => progress.id === candidate);
      if (!item || item.state !== 'suspended') {
        continue;
      }
      session.suspendedProgressIDs = stack;
      this.activate(candidate, session, now, false);
      return;
    }
    session.suspendedProgressIDs = stack;
  }

  // ---- 私有：§3.15 顺延下一项 ----

  private startNextTaskIfNeeded(session: RoutineSession, now: Date): void {
    if (session.activeProgressID !== null) {
      return;
    }
    const next = session.progress.find(
      (item) => item.step.role === 'task' && isIncomplete(item.state),
    );
    if (!next) {
      return;
    }
    this.activate(next.id, session, now, false);
  }

  // ---- 私有：§3.17 commit ----

  private commit(now: Date = this.clock()): void {
    this._snapshot.updatedAt = now;
    this._snapshot.originID = this.deviceID;
    this.onCommit(this._snapshot);
  }
}

/** 集合完全相等（对应 Swift `Set(ids) == Set(...)`）。 */
function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}
