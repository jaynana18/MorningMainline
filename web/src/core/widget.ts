/**
 * core/widget.ts — 小组件快照/时间线等价实现（LOGIC_PORT_SPEC §5.4–§5.5）。
 *
 * - `makeWidgetSnapshot(snapshot, at)`：把会话压缩成 MainlineWidgetSnapshot
 *   （RoutineStore.makeWidgetSnapshot(at:) 的等价物）。
 * - `widgetEntry(widgetSnapshot, at)`：MainlineWidgetProvider.entry(for:) 的等价物，
 *   叠加「快照生成后继续流逝的延误」（liveOverrun / additionalOverrun）。
 */

import type {
  MainlineWidgetEntry,
  MainlineWidgetSnapshot,
  RoutineSession,
  RoutineSnapshot,
} from './types';
import { estimatedCompletion, originalDueAt } from './session';

/** 空小组件快照（MainlineWidgetSnapshot.empty）。 */
export function emptyWidgetSnapshot(): MainlineWidgetSnapshot {
  return {
    capturedAt: null,
    currentTitle: null,
    currentDueAt: null,
    originalDueAt: null,
    isHardDeadline: false,
    estimatedCompletion: null,
    isLate: false,
    delayDuration: 0,
    hasActiveSession: false,
    sessionName: null,
  };
}

/** 把会话压缩成小组件快照；无 running 会话时返回空快照。 */
export function makeWidgetSnapshot(snapshot: RoutineSnapshot, at: Date): MainlineWidgetSnapshot {
  const session: RoutineSession | null = snapshot.activeSession;
  if (!session || session.state !== 'running') {
    return emptyWidgetSnapshot();
  }

  const current =
    session.progress.find((item) => item.id === session.activeProgressID && item.state === 'active') ??
    null;

  const completion = estimatedCompletion(session, at);
  let delayDuration: number;
  if (session.targetDeadline !== null && completion !== null) {
    delayDuration = Math.max(0, (completion.getTime() - session.targetDeadline.getTime()) / 1000);
  } else if (current) {
    delayDuration = Math.max(0, (current.dueAt.getTime() - originalDueAt(current).getTime()) / 1000);
  } else {
    delayDuration = 0;
  }

  return {
    capturedAt: at,
    currentTitle: current ? current.step.title : null,
    currentDueAt: current ? current.dueAt : null,
    originalDueAt: current ? originalDueAt(current) : null,
    isHardDeadline: current ? current.step.importance === 'hardDeadline' : false,
    estimatedCompletion: completion,
    isLate: delayDuration > 0,
    delayDuration,
    hasActiveSession: true,
    sessionName: session.templateName,
  };
}

/**
 * 由共享小组件快照生成时间线条目（叠加 live 延误）。
 * 无进行中的会话时返回占位空条目。
 */
export function widgetEntry(widgetSnapshot: MainlineWidgetSnapshot, at: Date): MainlineWidgetEntry {
  if (!widgetSnapshot.hasActiveSession) {
    return {
      date: at,
      currentTitle: null,
      currentDueAt: null,
      isHardDeadline: false,
      estimatedCompletion: null,
      isLate: false,
      delayDuration: 0,
      hasActiveSession: false,
      sessionName: null,
    };
  }

  const dueAt = widgetSnapshot.currentDueAt;
  const capturedAt = widgetSnapshot.capturedAt;
  const liveOverrun =
    dueAt !== null ? Math.max(0, (at.getTime() - dueAt.getTime()) / 1000) : 0;
  const additionalOverrun =
    dueAt !== null
      ? Math.max(
          0,
          (at.getTime() - Math.max(dueAt.getTime(), (capturedAt ?? dueAt).getTime())) / 1000,
        )
      : 0;
  const liveDelay = Math.max(widgetSnapshot.delayDuration ?? 0, liveOverrun);
  const liveEstimatedCompletion = widgetSnapshot.estimatedCompletion
    ? new Date(widgetSnapshot.estimatedCompletion.getTime() + additionalOverrun * 1000)
    : null;

  return {
    date: at,
    currentTitle: widgetSnapshot.currentTitle,
    currentDueAt: widgetSnapshot.currentDueAt,
    isHardDeadline: widgetSnapshot.isHardDeadline,
    estimatedCompletion: liveEstimatedCompletion,
    isLate: widgetSnapshot.isLate || liveDelay > 0,
    delayDuration: liveDelay,
    hasActiveSession: true,
    sessionName: widgetSnapshot.sessionName,
  };
}
