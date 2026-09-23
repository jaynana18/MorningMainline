import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createStep, createTemplate, type RoutineTemplate } from '../src/core/types';
import * as coreSession from '../src/core/session';
import { createMockBridge } from '../src/platform/mock';
import { deadlineOn, setRoutineBridge, taskSteps, useRoutineStore } from '../src/stores/routine';
import { formatHM, localDate } from './helpers';
import {
  defaultSelectedBufferMinutes,
  defaultSelectedDeadline,
  isDateInTomorrow,
  originalIsExpiredOf,
  originalSuggestedStartOf,
  planRows,
  planStart,
  previewStatus,
  startOfMinute,
} from '../src/views/preview/helpers';

/** 上班早晨：刷牙 3min + 洗脸 5min（任务 8min），出门 deadline，buffer 10min。 */
function morningTemplate(overrides: Partial<RoutineTemplate> = {}): RoutineTemplate {
  return {
    ...createTemplate({
      id: 'T',
      name: '上班早晨',
      symbol: 'sun.max.fill',
      mode: 'backward',
      deadlineHour: 8,
      deadlineMinute: 35,
      buffer: 10 * 60,
      recurrence: 'daily',
      steps: [
        createStep({ title: '刷牙', duration: 3 * 60 }),
        createStep({ title: '洗脸', duration: 5 * 60 }),
        createStep({ title: '出门', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
      ],
    }),
    ...overrides,
  };
}

beforeEach(() => {
  setRoutineBridge(null);
});

describe('stores/routine — 预览页门面（pendingTemplate / selectTemplate + 新增重导出）', () => {
  it('selectTemplate 记录 / 清空待预览模板', () => {
    setRoutineBridge(createMockBridge());
    setActivePinia(createPinia());
    const store = useRoutineStore();
    const template = morningTemplate();

    expect(store.pendingTemplate).toBeNull();
    store.selectTemplate(template);
    // Pinia 会把存进 ref 的对象包成响应式代理，故比较结构而非引用身份。
    expect(store.pendingTemplate).toStrictEqual(template);
    expect(store.pendingTemplate?.id).toBe('T');
    store.selectTemplate(null);
    expect(store.pendingTemplate).toBeNull();
  });

  it('taskSteps / deadlineOn 就是 core/session 的同名引用（门面未另起实现）', () => {
    expect(taskSteps).toBe(coreSession.taskSteps);
    expect(deadlineOn).toBe(coreSession.deadlineOn);
  });
});

describe('views/preview/helpers — 预览页默认值（ContentView 447–458）', () => {
  it('startOfMinute 归零秒/毫秒', () => {
    const d = startOfMinute(new Date(2026, 7, 13, 8, 5, 42, 500));
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([8, 5, 0, 0]);
  });

  it('恰好落在整分钟 → 不向上取整（now 08:00 + 8min + 10min = 08:18）', () => {
    const now = localDate(2026, 8, 13, 8, 0);
    expect(formatHM(defaultSelectedDeadline(morningTemplate(), now))).toBe('8:18');
  });

  it('落在分钟内（含秒）→ 向上取整到下一分钟（08:00:30 → 08:18:30 → 08:19）', () => {
    const now = new Date(2026, 7, 13, 8, 0, 30, 0);
    expect(formatHM(defaultSelectedDeadline(morningTemplate(), now))).toBe('8:19');
  });

  it('defaultSelectedBufferMinutes 复刻 Int(buffer/60) 向零截断 + max(0, …)', () => {
    expect(defaultSelectedBufferMinutes(morningTemplate({ buffer: 600 }))).toBe(10);
    expect(defaultSelectedBufferMinutes(morningTemplate({ buffer: 130 }))).toBe(2);
    expect(defaultSelectedBufferMinutes(morningTemplate({ buffer: 59 }))).toBe(0);
    expect(defaultSelectedBufferMinutes(morningTemplate({ buffer: 0 }))).toBe(0);
  });
});

describe('views/preview/helpers — planRows（BackwardPlanSummary 741–755）', () => {
  it('deadline 行时间 = deadline（不减 buffer）；第一个任务行 = deadline − buffer − Σduration', () => {
    const t = morningTemplate();
    const deadline = localDate(2026, 8, 13, 8, 35);
    const rows = planRows(t, deadline, 10 * 60);

    expect(rows.map((row) => [row.title, formatHM(row.time), row.isDeadline])).toEqual([
      ['刷牙', '8:17', false],
      ['洗脸', '8:20', false],
      ['出门', '8:35', true],
    ]);
    // 倒推开始 = deadline − 总时长(8min) − buffer(10min) = 8:17，与第一个任务行一致。
    expect(formatHM(planStart(t, deadline, 10 * 60))).toBe('8:17');
  });

  it('无 deadline 节点时只有任务行', () => {
    const t = morningTemplate({
      mode: 'forward',
      deadlineHour: null,
      deadlineMinute: null,
      steps: [
        createStep({ title: 'A', duration: 60 }),
        createStep({ title: 'B', duration: 120 }),
      ],
    });
    const rows = planRows(t, localDate(2026, 8, 13, 9, 0), 0);
    expect(rows.map((row) => [row.title, formatHM(row.time)])).toEqual([
      ['A', '8:57'],
      ['B', '8:58'],
    ]);
  });
});

describe('views/preview/helpers — 原计划派生（631–655）', () => {
  it('originalSuggestedStartOf = deadline − 总时长 − buffer', () => {
    const t = morningTemplate();
    expect(formatHM(originalSuggestedStartOf(t, localDate(2026, 8, 13, 8, 35)))).toBe('8:17');
  });

  it('originalIsExpiredOf 仅在 once + 已过期时为真', () => {
    const once = morningTemplate({ recurrence: 'once' });
    const daily = morningTemplate({ recurrence: 'daily' });
    const deadline = localDate(2026, 8, 13, 8, 35);

    expect(originalIsExpiredOf(once, deadline, localDate(2026, 8, 13, 9, 0))).toBe(true);
    expect(originalIsExpiredOf(once, deadline, localDate(2026, 8, 13, 8, 0))).toBe(false);
    // daily 即使已过时刻也不算过期（会被顺延）。
    expect(originalIsExpiredOf(daily, deadline, localDate(2026, 8, 13, 9, 0))).toBe(false);
  });

  it('isDateInTomorrow 按本地日比较', () => {
    const now = localDate(2026, 8, 13, 20, 0);
    expect(isDateInTomorrow(localDate(2026, 8, 14, 8, 35), now)).toBe(true);
    expect(isDateInTomorrow(localDate(2026, 8, 13, 8, 35), now)).toBe(false);
  });
});

describe('views/preview/helpers — previewStatus（661–702，分支顺序不可变）', () => {
  it('① 原计划过期 → 红 / calendar.badge.exclamationmark', () => {
    const t = morningTemplate({ recurrence: 'once' });
    const now = localDate(2026, 8, 13, 9, 0);
    const deadline = localDate(2026, 8, 13, 8, 35);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('原计划时间已经过去。单次计划不会自动顺延，请使用本次计划。');
    expect(status.symbol).toBe('calendar.badge.exclamationmark');
    expect(status.isRed).toBe(true);
  });

  it('② 顺延到明天 → 橙 / calendar.badge.clock', () => {
    const t = morningTemplate({ recurrence: 'daily' });
    const now = localDate(2026, 8, 13, 20, 0);
    const deadline = localDate(2026, 8, 14, 8, 35);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('今天的原计划时间已经过去，已自动顺延到明天。也可以按本次计划从现在开始。');
    expect(status.symbol).toBe('calendar.badge.clock');
    expect(status.isRed).toBe(false);
  });

  it('③ 按原计划来不及 → 红 / exclamationmark.triangle.fill（overrun=3 分钟）', () => {
    const t = morningTemplate();
    const now = localDate(2026, 8, 13, 8, 0);
    const deadline = localDate(2026, 8, 13, 8, 5);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('按原计划已经来不及，预计会晚 3 分钟。建议使用本次计划。');
    expect(status.symbol).toBe('exclamationmark.triangle.fill');
    expect(status.isRed).toBe(true);
  });

  it('④ 距建议开始 > 1h → 橙 / clock.arrow.circlepath', () => {
    const t = morningTemplate();
    const now = localDate(2026, 8, 13, 8, 0);
    const deadline = localDate(2026, 8, 13, 20, 0);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('现在距离原计划建议开始较远。你可以调整本次时间，或按原计划开始。');
    expect(status.symbol).toBe('clock.arrow.circlepath');
    expect(status.isRed).toBe(false);
  });

  it('⑤ 未到建议开始（< 1h）→ 橙 / clock.arrow.circlepath', () => {
    const t = morningTemplate();
    const now = localDate(2026, 8, 13, 8, 0);
    const deadline = localDate(2026, 8, 13, 8, 30);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('还没到原计划建议开始时间；现在开始会比原计划更从容。');
    expect(status.symbol).toBe('clock.arrow.circlepath');
    expect(status.isRed).toBe(false);
  });

  it('⑥ 兜底（已进入建议执行时间）→ 橙 / checkmark.circle.fill', () => {
    const t = morningTemplate();
    const now = localDate(2026, 8, 13, 8, 0);
    const deadline = localDate(2026, 8, 13, 8, 15);
    const status = previewStatus(t, now, deadline, originalSuggestedStartOf(t, deadline));
    expect(status.message).toBe('现在已经进入建议执行时间，选择计划进入后，再开始具体任务。');
    expect(status.symbol).toBe('checkmark.circle.fill');
    expect(status.isRed).toBe(false);
  });
});
