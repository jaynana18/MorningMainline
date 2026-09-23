import { describe, expect, it } from 'vitest';
import { getZonedComponents } from '../src/core/serialization';
import { deadlineOn } from '../src/core/session';
import { cloneTemplate, MORNING_TEMPLATE } from '../src/core/types';

describe('timezone — 约束 W1/W2/W3', () => {
  it('W1：测试进程时区被钉死为 Asia/Shanghai (UTC+8)', () => {
    // 2026-08-13 12:00 Asia/Shanghai == 2026-08-13 04:00 UTC
    expect(new Date(Date.UTC(2026, 7, 13, 4, 0, 0)).getHours()).toBe(12);
    expect(new Date(2026, 7, 13, 12, 0).toISOString()).toBe('2026-08-13T04:00:00.000Z');
    expect(getZonedComponents(new Date(2026, 7, 13, 12, 0), 'Asia/Shanghai').hour).toBe(12);
  });

  it('W2：deadline(on:) 是「同日 setHours」而非「下一个该时刻」（once 过期不滚动）', () => {
    const now = new Date(2026, 7, 14, 12, 0); // 已过 08:35
    const once = cloneTemplate(MORNING_TEMPLATE);
    once.recurrence = 'once';
    const deadline = deadlineOn(once, now, 'Asia/Shanghai')!;
    // 同日 08:35（day=14），不跨到 15
    expect([deadline.getDate(), deadline.getHours(), deadline.getMinutes()]).toEqual([14, 8, 35]);
  });
});
