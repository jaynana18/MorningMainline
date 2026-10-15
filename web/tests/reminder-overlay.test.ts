/**
 * tests/reminder-overlay.test.ts — P3 视图层提醒纯函数测试。
 *
 * 环境约束：`vitest.config.ts` 是 `environment: 'node'`（无 DOM），所以**不挂载**
 * `.vue` 组件；只测 `views/reminder/helpers.ts` 的纯函数（这正是把它单独拆出来的原因）。
 * 风格照抄 `tests/session-view.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import {
  reminderHeading,
  resolveFocusAction,
  type FocusContext,
} from '../src/views/reminder/helpers';
import type { FocusRequest, ReminderMessage } from '../src/stores/reminders';

/** 构造一个完整的 FocusRequest（默认「无会话限定」）。 */
function focusRequest(overrides: Partial<FocusRequest> = {}): FocusRequest {
  return {
    progressID: null,
    sessionID: null,
    minuteOffset: null,
    at: new Date(1_700_000_000_000),
    ...overrides,
  };
}

/** 构造裁决上下文。 */
function context(overrides: Partial<FocusContext> = {}): FocusContext {
  return {
    sessionID: 's1',
    progressIDs: ['p1', 'p2'],
    ...overrides,
  };
}

/** 构造一个完整的 ReminderMessage，fill 真实文案。 */
function reminder(overrides: Partial<ReminderMessage> = {}): ReminderMessage {
  return {
    key: 'task:p1:due',
    title: '不跑偏 · 去厕所',
    body: '把这件事做完再回来。',
    level: 'normal',
    sound: 'default',
    fireAt: new Date(1_700_000_000_000),
    minuteOffset: null,
    progressID: 'p1',
    sessionID: 's1',
    speech: '到点了，现在做“去厕所”。',
    ...overrides,
  };
}

describe('views/reminder/helpers — resolveFocusAction', () => {
  it('request 为 null → ignore', () => {
    expect(resolveFocusAction(null, context())).toBe('ignore');
    expect(resolveFocusAction(null, context({ sessionID: null, progressIDs: [] }))).toBe('ignore');
  });

  it('会话 id 相同 → navigate', () => {
    expect(resolveFocusAction(focusRequest({ sessionID: 's1' }), context())).toBe('navigate');
  });

  it('会话 id 不同 → stale（那条会话已结束/被替换）', () => {
    expect(resolveFocusAction(focusRequest({ sessionID: 's1' }), context({ sessionID: 's2' }))).toBe(
      'stale',
    );
  });

  it('会话 id 非 null 但当前无会话 → stale', () => {
    expect(
      resolveFocusAction(focusRequest({ sessionID: 's1' }), context({ sessionID: null })),
    ).toBe('stale');
  });

  // ---- 本次修复核心：task 通知不带 sessionID，靠 progressID 成员判定 ----

  it('task 回跳 · progressID 仍属于当前会话 → navigate', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: 'p1' }),
        context({ sessionID: 's1', progressIDs: ['p1', 'p2'] }),
      ),
    ).toBe('navigate');
  });

  it('task 回跳 · progressID 不在当前会话 → stale（缺 sessionID 场景，核心反证）', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: 'p1' }),
        context({ sessionID: 's1', progressIDs: ['p9'] }),
      ),
    ).toBe('stale');
  });

  it('task 回跳 · 无进行中会话（progressIDs 空）→ stale', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: 'p1' }),
        context({ sessionID: null, progressIDs: [] }),
      ),
    ).toBe('stale');
  });

  it('task 回跳 · sessionID 与 progressID 都带且都匹配 → navigate', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: 'p1', sessionID: 's1' }),
        context({ sessionID: 's1', progressIDs: ['p1'] }),
      ),
    ).toBe('navigate');
  });

  // ---- 里程碑回跳：只有 sessionID、无 progressID，不被成员判定误伤 ----

  it('里程碑回跳 · 会话匹配 → navigate（不被 progressIDs 判定误伤）', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: null, sessionID: 's1', minuteOffset: -1 }),
        context({ sessionID: 's1', progressIDs: [] }),
      ),
    ).toBe('navigate');
  });

  it('里程碑回跳 · 会话不匹配 → stale', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: null, sessionID: 's1', minuteOffset: -1 }),
        context({ sessionID: 's2', progressIDs: [] }),
      ),
    ).toBe('stale');
  });
});

describe('views/reminder/helpers — reminderHeading（小字标签，逐字）', () => {
  it('里程碑 · 临近（minuteOffset<0, default）→「Deadline 临近」', () => {
    expect(reminderHeading(reminder({ minuteOffset: -1, sound: 'default' }))).toBe('Deadline 临近');
  });

  it('里程碑 · 到点（minuteOffset=0, overdue）→「Deadline 已延误」', () => {
    expect(reminderHeading(reminder({ minuteOffset: 0, sound: 'overdue' }))).toBe('Deadline 已延误');
  });

  it('里程碑 · 延误（minuteOffset>0, overdue）→「Deadline 已延误」', () => {
    expect(reminderHeading(reminder({ minuteOffset: 2, sound: 'overdue' }))).toBe('Deadline 已延误');
  });

  it('普通任务提醒（minuteOffset=null）→「该做下一件事了」', () => {
    expect(reminderHeading(reminder({ minuteOffset: null, sound: 'default' }))).toBe(
      '该做下一件事了',
    );
  });

  it('不改写 title/body，且不 mutate 输入对象（纯函数）', () => {
    const message = reminder({
      title: '🚨 Deadline 已延误 4 分钟',
      body: '当前任务“写周报”仍未完成，请先把它收尾。',
      minuteOffset: 4,
      sound: 'overdue',
    });
    const before = JSON.parse(JSON.stringify(message)) as ReminderMessage;

    const label = reminderHeading(message);

    // 标签与 title/body 完全无关，且不等于任何一方。
    expect(label).toBe('Deadline 已延误');
    expect(label).not.toBe(message.title);
    expect(label).not.toBe(message.body);
    expect(label.includes(message.title)).toBe(false);
    expect(label.includes(message.body)).toBe(false);
    // 输入对象未被 mutate。
    expect(JSON.parse(JSON.stringify(message))).toEqual(before);
  });
});
