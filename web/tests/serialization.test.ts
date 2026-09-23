import { describe, expect, it } from 'vitest';
import {
  APPLE_REFERENCE_EPOCH_OFFSET,
  decodeSnapshot,
  decodeWidgetSnapshot,
  encodeSnapshot,
  encodeWidgetSnapshot,
  getZonedComponents,
  msToRefSeconds,
  normalizeUUID,
  refSecondsToMs,
  setHoursInTz,
  addDaysInTz,
} from '../src/core/serialization';
import {
  cloneTemplate,
  createProgress,
  createSession,
  createSnapshot,
  createStep,
  DISTANT_PAST,
  HOMEWORK_TEMPLATE,
  initialSnapshot,
  MORNING_TEMPLATE,
} from '../src/core/types';
import { effectiveRecurrence, originalDueAt, remainingWork } from '../src/core/session';
import { localDate, TZ } from './helpers';

describe('serialization — Apple 参考日期（最大坑，§5.1）', () => {
  it('APPLE_REFERENCE_EPOCH_OFFSET 固定为 978307200，且 refSeconds↔ms 互逆', () => {
    expect(APPLE_REFERENCE_EPOCH_OFFSET).toBe(978307200);
    // 2001-01-01T00:00:00Z → refSeconds 0 → epochMs = 978307200000
    expect(refSecondsToMs(0)).toBe(978307200000);
    expect(msToRefSeconds(978307200000)).toBe(0);
  });

  it('把参考秒当 Unix 秒会静默偏移约 31 年（锁住该坑）', () => {
    const refSeconds = 779000000;
    const correct = new Date(refSecondsToMs(refSeconds)).getTime();
    const naive = new Date(refSeconds * 1000).getTime();
    expect(correct - naive).toBe(978307200 * 1000);
  });

  it('DISTANT_PAST 与 Swift Date.distantPast 逐字节对齐（锁定哨兵值）', () => {
    // Swift: Date.distantPast = Apple 参考秒 -63114076800
    //        → Unix 毫秒 = (-63114076800 + 978307200) * 1000 = -62135769600000
    expect(msToRefSeconds(DISTANT_PAST.getTime())).toBe(-63114076800);
    expect(DISTANT_PAST.getTime()).toBe(-62135769600000);
    // 反例锁：直觉上的 0001-01-01T00:00:00Z（-62135596800000）与真实值差 2 天，
    // 用它会让跨端冲突裁决出现非对称，必须与 Swift 一致。
    expect(DISTANT_PAST.getTime()).not.toBe(-62135596800000);
    expect(initialSnapshot().updatedAt.getTime()).toBe(DISTANT_PAST.getTime());
  });

  it('encodeSnapshot 把 Date 写成参考秒，且可无损解码回同一时刻', () => {
    const updatedAt = localDate(2026, 8, 13, 12, 0);
    const snapshot = createSnapshot({ templates: [cloneTemplate(MORNING_TEMPLATE)], updatedAt });
    const encoded = JSON.parse(encodeSnapshot(snapshot)) as { updatedAt: number };
    expect(encoded.updatedAt).toBe(msToRefSeconds(updatedAt.getTime()));
    const decoded = decodeSnapshot(encodeSnapshot(snapshot));
    expect(decoded?.updatedAt.getTime()).toBe(updatedAt.getTime());
  });

  it('JSON key 使用 Swift 属性名 camelCase（primaryDevice/plannedDueAt/activeProgressID/originID…）', () => {
    const now = localDate(2026, 8, 13, 12, 0);
    const progress = createProgress({
      step: createStep({ title: '去厕所', duration: 300 }),
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
      progress: [progress],
      remainingBuffer: 0,
      updatedAt: now,
      revision: 1,
    });
    const obj = JSON.parse(
      encodeSnapshot(createSnapshot({ templates: [], activeSession: session, updatedAt: now })),
    ) as Record<string, unknown>;

    expect(Object.keys(obj).sort()).toEqual(['activeSession', 'originID', 'templates', 'updatedAt']);
    const sessionObj = (obj as { activeSession: Record<string, unknown> }).activeSession;
    for (const key of [
      'templateID',
      'templateName',
      'templateSymbol',
      'plannedStartAt',
      'targetDeadline',
      'primaryDevice',
      'remainingBuffer',
      'activeProgressID',
      'suspendedProgressIDs',
    ]) {
      expect(sessionObj).toHaveProperty(key);
    }
    const progressObj = (sessionObj.progress as Record<string, unknown>[])[0];
    for (const key of [
      'plannedDueAt',
      'remainingDuration',
      'startedAt',
      'snoozeCount',
      'isTemporary',
      'completedAt',
    ]) {
      expect(progressObj).toHaveProperty(key);
    }
  });

  it('正常大小写 UUID 比较：normalizeUUID 统一为小写', () => {
    expect(normalizeUUID('5E43ED14-458A-49CF-8673-A96DCA196001')).toBe(
      '5e43ed14-458a-49cf-8673-a96dca196001',
    );
  });
});

describe('serialization — 旧数据兼容（M15 / 用例 5、9）', () => {
  it('用例 5：模板缺 recurrence 键解码后 effectiveRecurrence 回落 once', () => {
    const now = localDate(2026, 8, 13, 12, 0);
    const snapshot = createSnapshot({
      templates: [cloneTemplate(HOMEWORK_TEMPLATE)],
      updatedAt: now,
    });
    const obj = JSON.parse(encodeSnapshot(snapshot)) as {
      templates: Record<string, unknown>[];
    };
    delete obj.templates[0].recurrence;

    const decoded = decodeSnapshot(JSON.stringify(obj));
    expect(decoded).not.toBeNull();
    expect(decoded?.templates[0].recurrence).toBeNull();
    expect(effectiveRecurrence(decoded!.templates[0])).toBe('once');
  });

  it('用例 9：StepProgress 缺 plannedDueAt/remainingDuration/startedAt 时回落默认值', () => {
    const dueAt = new Date(20000);
    const progress = createProgress({
      step: createStep({ title: '旧任务', duration: 5 * 60 }),
      dueAt,
    });
    const session = createSession({
      templateID: 'T',
      templateName: '测试',
      templateSymbol: 'checkmark',
      startedAt: dueAt,
      plannedStartAt: dueAt,
      targetDeadline: null,
      state: 'running',
      primaryDevice: 'phone',
      progress: [progress],
      remainingBuffer: 0,
      updatedAt: dueAt,
      revision: 1,
    });
    const obj = JSON.parse(
      encodeSnapshot(createSnapshot({ templates: [], activeSession: session, updatedAt: dueAt })),
    ) as { activeSession: { progress: Record<string, unknown>[] } };
    delete obj.activeSession.progress[0].plannedDueAt;
    delete obj.activeSession.progress[0].remainingDuration;
    delete obj.activeSession.progress[0].startedAt;

    const decoded = decodeSnapshot(JSON.stringify(obj));
    const p = decoded!.activeSession!.progress[0];
    expect(originalDueAt(p).getTime()).toBe(dueAt.getTime());
    expect(remainingWork(p)).toBe(5 * 60);
    expect(p.state).toBe('pending');
  });

  it('缺失的 activeSession 解码为 null；损坏 JSON 解码为 null', () => {
    expect(decodeSnapshot('not json')).toBeNull();
    expect(
      decodeSnapshot('{"templates":[],"updatedAt":0,"originID":"x"}')?.activeSession,
    ).toBeNull();
  });
});

describe('serialization — 时区工具（W2/W4）', () => {
  it('setHoursInTz 只改墙上时分、保留日历日（不跨日滚动）', () => {
    const now = localDate(2026, 8, 14, 12, 0);
    const today = setHoursInTz(now, 8, 35, TZ);
    const c = getZonedComponents(today, TZ);
    expect([c.year, c.month, c.day]).toEqual([2026, 8, 14]);
    expect([c.hour, c.minute]).toEqual([8, 35]);
  });

  it('addDaysInTz 保持墙上时间地顺延一天', () => {
    const base = setHoursInTz(localDate(2026, 8, 14, 12, 0), 8, 35, TZ);
    const next = addDaysInTz(base, 1, TZ);
    const c = getZonedComponents(next, TZ);
    expect([c.year, c.month, c.day, c.hour, c.minute]).toEqual([2026, 8, 15, 8, 35]);
  });
});

describe('serialization — widget 快照往返', () => {
  it('encodeWidgetSnapshot / decodeWidgetSnapshot 往返一致', () => {
    const at = localDate(2026, 8, 13, 12, 0);
    const widget = {
      capturedAt: at,
      currentTitle: '刷牙',
      currentDueAt: at,
      originalDueAt: at,
      isHardDeadline: true,
      estimatedCompletion: at,
      isLate: false,
      delayDuration: 0,
      hasActiveSession: true,
      sessionName: '上班早晨',
    };
    const decoded = decodeWidgetSnapshot(encodeWidgetSnapshot(widget));
    expect(decoded?.currentTitle).toBe('刷牙');
    expect(decoded?.capturedAt?.getTime()).toBe(at.getTime());
    expect(decoded?.isHardDeadline).toBe(true);
  });
});
