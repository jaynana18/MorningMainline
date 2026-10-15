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

/** 构造裁决上下文。默认 `ready: true` —— 绝大多数用例都在测「数据已加载」后的正常裁决。 */
function context(overrides: Partial<FocusContext> = {}): FocusContext {
  return {
    sessionID: 's1',
    progressIDs: ['p1', 'p2'],
    ready: true,
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

  // ---- 2026-10-15 修「点通知停在主页」：数据未就绪时必须保留请求，不能判 stale ----
  //
  // 冷启动链路：原生在 `viewDidLoad` 就 `emit('notification.opened')`，而 JS 的
  // `store.init()` 是异步的。事件先到 → 那一刻 `session` 为 null。旧实现直接用
  // 这个 null 去裁决 → 返回 `stale` → `clearFocusRequest()` → 请求被**静默丢弃**，
  // 用户点通知只看到主页。`ready` 字段就是为了把「还没读到」与「确实已失效」分开。

  it('🔴 ready=false · 会话为空 → wait（不是 stale，请求必须留着）', () => {
    expect(
      resolveFocusAction(
        focusRequest({ sessionID: 's1' }),
        context({ ready: false, sessionID: null, progressIDs: [] }),
      ),
    ).toBe('wait');
  });

  it('🔴 ready=false · 会话 id 对不上也不判 stale（此时尚不知真假）', () => {
    expect(
      resolveFocusAction(
        focusRequest({ sessionID: 's1' }),
        context({ ready: false, sessionID: 's-other', progressIDs: [] }),
      ),
    ).toBe('wait');
  });

  it('🔴 ready=false · task 回跳的 progressID 不在（空）列表里 → 仍为 wait', () => {
    expect(
      resolveFocusAction(
        focusRequest({ progressID: 'p1' }),
        context({ ready: false, progressIDs: [] }),
      ),
    ).toBe('wait');
  });

  it('ready=false 但 request 为 null → ignore（空请求无需等待）', () => {
    expect(resolveFocusAction(null, context({ ready: false, sessionID: null, progressIDs: [] }))).toBe(
      'ignore',
    );
  });

  it('🔴 同一条请求：ready=false 时 wait，ready 翻转后给出确定结论（证明可收敛）', () => {
    const request = focusRequest({ progressID: 'p1' });
    expect(resolveFocusAction(request, context({ ready: false, progressIDs: [] }))).toBe('wait');
    expect(
      resolveFocusAction(request, context({ ready: true, sessionID: 's1', progressIDs: ['p1'] })),
    ).toBe('navigate');
    // 数据加载完仍不匹配 → 这次才是真的 stale，可以丢弃。
    expect(resolveFocusAction(request, context({ ready: true, progressIDs: ['p9'] }))).toBe('stale');
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
