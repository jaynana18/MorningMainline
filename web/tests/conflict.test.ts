import { describe, expect, it } from 'vitest';
import { applyIncoming, shouldAdopt } from '../src/core/conflict';
import { RoutineStore } from '../src/core/store';
import { createSession, createSnapshot, type RoutineSnapshot } from '../src/core/types';
import { localDate, TZ } from './helpers';

const SELF = 'AAAA-BBBB';

function snapshotWith(
  originID: string,
  revision: number,
  updatedAt: Date,
  hasSession = true,
): RoutineSnapshot {
  if (!hasSession) {
    return createSnapshot({ templates: [], activeSession: null, updatedAt, originID });
  }
  const session = createSession({
    templateID: 'T',
    templateName: '测试',
    templateSymbol: 'checkmark',
    startedAt: updatedAt,
    plannedStartAt: updatedAt,
    targetDeadline: null,
    state: 'running',
    primaryDevice: 'phone',
    progress: [],
    remainingBuffer: 0,
    updatedAt,
    revision,
  });
  return createSnapshot({ templates: [], activeSession: session, updatedAt, originID });
}

describe('conflict — 严格 > 且 revision/updatedAt 为 OR（M22 / G6）', () => {
  const t1 = localDate(2026, 8, 13, 10, 0);
  const t2 = localDate(2026, 8, 13, 11, 0);

  it('originID === 本机 → 最先短路拒收（即使版本/时间更新）', () => {
    const current = snapshotWith(SELF, 1, t1);
    const incoming = snapshotWith(SELF, 5, t2);
    expect(shouldAdopt(incoming, current, SELF)).toBe(false);
  });

  it('originID 大小写不敏感地视为同一设备', () => {
    const current = snapshotWith('aaaa-bbbb', 1, t1);
    const incoming = snapshotWith('AAAA-BBBB', 5, t2);
    expect(shouldAdopt(incoming, current, SELF)).toBe(false);
  });

  it('revision 严格更大 → 采纳', () => {
    const current = snapshotWith('OTHER', 1, t2);
    const incoming = snapshotWith('OTHER', 2, t1); // 时间更旧，但版本更新
    expect(shouldAdopt(incoming, current, SELF)).toBe(true);
  });

  it('updatedAt 严格更新可单独胜出（与 revision 为 OR）', () => {
    const current = snapshotWith('OTHER', 3, t1);
    const incoming = snapshotWith('OTHER', 3, t2); // revision 相等，时间更新
    expect(shouldAdopt(incoming, current, SELF)).toBe(true);
  });

  it('相等即拒绝（严格 >，不是 >=）', () => {
    const current = snapshotWith('OTHER', 3, t2);
    const incoming = snapshotWith('OTHER', 3, t2);
    expect(shouldAdopt(incoming, current, SELF)).toBe(false);
  });

  it('两者都不严格更新 → 拒绝（时钟回拨 + revision 未增）', () => {
    const current = snapshotWith('OTHER', 3, t2);
    const incoming = snapshotWith('OTHER', 2, t1);
    expect(shouldAdopt(incoming, current, SELF)).toBe(false);
  });

  it('current 无 session、incoming 有 session（revision>=1 > 0）→ 采纳', () => {
    const current = snapshotWith('OTHER', 0, t2, false);
    const incoming = snapshotWith('OTHER', 1, t1);
    expect(shouldAdopt(incoming, current, SELF)).toBe(true);
  });

  it('applyIncoming：拒绝返回原引用，采纳返回整体替换的副本', () => {
    const current = snapshotWith('OTHER', 3, t2);
    const rejected = snapshotWith('OTHER', 2, t1);
    expect(applyIncoming(rejected, current, SELF)).toBe(current);

    const adopted = snapshotWith('OTHER', 4, t1);
    const next = applyIncoming(adopted, current, SELF);
    expect(next).not.toBe(current);
    expect(next.originID).toBe('OTHER');
    expect(next.activeSession?.revision).toBe(4);
  });

  it('RoutineStore.applyIncomingSnapshot 走同一裁决器', () => {
    const store = new RoutineStore({
      deviceRole: 'phone',
      deviceID: SELF,
      tz: TZ,
      initialSnapshot: snapshotWith(SELF, 1, t1),
    });
    // 回声（originID=本机）→ 拒绝
    expect(store.applyIncomingSnapshot(snapshotWith(SELF, 9, t2))).toBe(false);
    // 更旧的外部快照 → 拒绝
    expect(store.applyIncomingSnapshot(snapshotWith('OTHER', 1, t1))).toBe(false);
    // 更新的外部快照 → 采纳
    expect(store.applyIncomingSnapshot(snapshotWith('OTHER', 2, t2))).toBe(true);
    expect(store.snapshot.originID).toBe('OTHER');
  });
});
