import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setRoutineBridge, useRoutineStore } from '../src/stores/routine';
import { useRemindersStore } from '../src/stores/reminders';
import { createMockBridge, type MockBridge } from '../src/platform/mock';
import type { BridgeCapabilities } from '../src/platform/bridge';
import { allReminders } from '../src/core/reminders';
import {
  createProgress,
  createSession,
  createSnapshot,
  createStep,
  type RoutineSession,
} from '../src/core/types';

/** 固定会话 id：里程碑 key = `deadline:<sessionID>:<minuteOffset>`。 */
const SID = 'S1';
/** 目标截止时刻：2026-08-13 12:00（测试时区钉死为 Asia/Shanghai）。 */
const DEADLINE = new Date(2026, 7, 13, 12, 0, 0);

/** 构造一个 running 会话：一个远期 task + 一个 deadline 项（提供里程碑前置条件）。 */
function buildSession(): RoutineSession {
  const startedAt = new Date(2026, 7, 13, 11, 0, 0);
  const task = createProgress({
    step: createStep({ title: '写代码', duration: 10 * 60 }),
    // 12:30，落在本轮测试的所有 tick 时刻之外，避免干扰里程碑断言。
    dueAt: new Date(DEADLINE.getTime() + 30 * 60 * 1000),
    state: 'pending',
  });
  const deadlineItem = createProgress({
    step: createStep({
      title: '完成',
      duration: 0,
      importance: 'hardDeadline',
      role: 'deadline',
    }),
    dueAt: DEADLINE,
    state: 'pending',
  });
  return createSession({
    id: SID,
    templateID: 'T',
    templateName: '任务线',
    templateSymbol: 'sun.max.fill',
    startedAt,
    plannedStartAt: startedAt,
    targetDeadline: DEADLINE,
    state: 'running',
    primaryDevice: 'phone',
    progress: [task, deadlineItem],
    remainingBuffer: 0,
    updatedAt: startedAt,
    revision: 1,
  });
}

/** 造一个预置了 running 会话的 MockBridge（可注入能力）。 */
function makeBridge(capabilities: Partial<BridgeCapabilities> = {}): MockBridge {
  const session = buildSession();
  return createMockBridge({
    initialSnapshot: createSnapshot({
      templates: [],
      activeSession: session,
      updatedAt: session.updatedAt,
    }),
    capabilities,
  });
}

/** 注入桥 + 新 Pinia，返回 routine / reminders 两个 store。 */
function setup(bridge: MockBridge) {
  setRoutineBridge(bridge);
  setActivePinia(createPinia());
  const routine = useRoutineStore();
  const reminders = useRemindersStore();
  return { routine, reminders };
}

/** 某里程碑的触发时刻（DEADLINE + offset 分钟）。 */
function milestoneAt(minuteOffset: number): Date {
  return new Date(DEADLINE.getTime() + minuteOffset * 60 * 1000);
}

beforeEach(() => {
  setRoutineBridge(null);
  // 用假计时器控制 Date.now()，从而精确控制 start() 写入的 watchedSince。
  // 测试一律**手动**调 tick(固定时刻)，不推进计时器等待 interval。
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setRoutineBridge(null);
});

describe('stores/reminders — 前台弹窗通道', () => {
  it('到点弹窗 + 去重 + milestone 0 的文案/级别/声音', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // 引擎在 11:59:00 开始盯着：更早的 -10/-5/-3 里程碑记为 skipped，-1 正常弹窗。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();
    reminders.tick(new Date(2026, 7, 13, 11, 59, 0));

    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(reminders.active?.title).toBe('不跑偏 · 距离 Deadline 还剩 1 分钟');
    expect(bridge.presentNotificationCalls).toHaveLength(0);
    expect(reminders.stats.local).toBe(1);

    // 去重：同一提醒再次到点不重复弹，active 不变。
    reminders.tick(new Date(2026, 7, 13, 11, 59, 10));
    expect(reminders.stats.local).toBe(1);
    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);

    // 关闭后，Deadline 正点里程碑按时弹窗（timeSensitive / overdue）。
    reminders.dismiss();
    reminders.tick(new Date(2026, 7, 13, 12, 0, 0));
    expect(reminders.active?.title).toBe('⏰ Deadline 到了');
    expect(reminders.active?.level).toBe('timeSensitive');
    expect(reminders.active?.sound).toBe('overdue');
  });
});

describe('stores/reminders — 后台到点（系统通道）', () => {
  /** 前台先把 -10..0 消化掉（各自弹窗后关闭），避免干扰「+2 单条」断言。 */
  function consumeEarlierMilestones(reminders: ReturnType<typeof useRemindersStore>): void {
    for (const offset of [-10, -5, -3, -1, 0]) {
      reminders.tick(milestoneAt(offset));
      reminders.dismiss();
    }
  }

  it('capabilities.backgroundNotification=true → 只标记、不投递', async () => {
    const bridge = makeBridge({ backgroundNotification: true });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();
    consumeEarlierMilestones(reminders);

    reminders.visible = false;
    reminders.tick(milestoneAt(2));

    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(bridge.presentNotificationCalls).toHaveLength(0);
    expect(reminders.stats.system).toBe(1);
  });

  it('capabilities.backgroundNotification=false → 经 bridge.presentNotification，文案与 core 逐字一致', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();
    consumeEarlierMilestones(reminders);

    reminders.visible = false;
    reminders.tick(milestoneAt(2));

    const expected = allReminders(buildSession()).find((item) => item.key === `deadline:${SID}:2`);
    expect(expected).toBeDefined();
    expect(bridge.presentNotificationCalls).toHaveLength(1);
    expect(bridge.presentNotificationCalls[0]).toEqual({
      title: expected!.title,
      body: expected!.body,
      level: expected!.level,
    });
    expect(reminders.stats.system).toBe(1);
  });
});

describe('stores/reminders — 前台去重（不补弹过时提醒）', () => {
  it('hidden→visible 不补弹「引擎没盯着」期间到点的提醒，之后新到点仍正常弹', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // 无 document → 引擎按前台启动（visible=true），watchedSince=11:45。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    vi.stubGlobal('document', { visibilityState: 'hidden' });
    reminders.syncVisibility();
    expect(reminders.visible).toBe(false);

    // 模拟 iOS 后台：JS 计时器被挂起、期间不 tick；系统时间直接跳到 12:05。
    vi.setSystemTime(new Date(2026, 7, 13, 12, 5, 0));
    vi.stubGlobal('document', { visibilityState: 'visible' });
    reminders.syncVisibility(); // → watchedSince=12:05，再 tick

    // 11:50/55/57/59、12:00/02/04 共 7 条早于 watchedSince → 全部 skipped，无弹窗。
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(reminders.stats.local).toBe(0);
    expect(reminders.stats.skipped).toBe(7);

    // 之后新到点的提醒不受影响，仍弹窗。
    vi.setSystemTime(milestoneAt(6));
    reminders.tick();
    expect(reminders.active?.key).toBe(`deadline:${SID}:6`);
    expect(reminders.stats.local).toBe(1);
  });

  it('可见但 JS 被冻结后恢复：到点超过 VISIBLE_CATCH_UP_MS 不补弹（不依赖 watchedSince）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // watchedSince = 11:48，**早于全部里程碑 fireAt** → staleForEngine 恒为 false，
    // 因此本用例只能由新加的 catch-up 闸门（now - fireAt > 90s）拦下，与上一条区分开。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 48, 0));
    await reminders.start();
    expect(reminders.active).toBeNull();

    const now = new Date(2026, 7, 13, 12, 20, 0); // 远晚于任何里程碑
    reminders.tick(now);

    const dueCount = allReminders(buildSession()).filter(
      (item) => item.fireAt.getTime() <= now.getTime(),
    ).length;
    expect(dueCount).toBe(8); // 8 个里程碑全在 now 之前到点
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(reminders.stats.local).toBe(0);
    expect(reminders.stats.skipped).toBe(dueCount);
  });
});

describe('stores/reminders — 弹窗队列 / dismiss（ReminderOverlay 依赖的实体行为）', () => {
  it('同一 tick 多条 due：active 为首条、queue 按候选顺序装其余，dismiss 逐条提升至清空', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    // 12:00 越过 -1(11:59，delta 60s ≤90s) 与 0(12:00，delta 0) 两条 fireAt；
    // 更早的 -10/-5/-3 被 catch-up 闸门记为 skipped。
    reminders.tick(milestoneAt(0));

    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(reminders.queue.map((item) => item.key)).toEqual([`deadline:${SID}:0`]);
    expect(reminders.stats.local).toBe(2);

    reminders.dismiss();
    expect(reminders.active?.key).toBe(`deadline:${SID}:0`);
    expect(reminders.queue).toHaveLength(0);

    reminders.dismiss();
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
  });

  it('同 key 重复投递不二次入队（active 不变、queue 实体不增）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    reminders.tick(milestoneAt(0));
    const activeKey = reminders.active?.key;
    const queueLength = reminders.queue.length;

    reminders.tick(milestoneAt(0)); // 同一时刻再投一次

    expect(reminders.active?.key).toBe(activeKey);
    expect(reminders.queue.length).toBe(queueLength);
  });

  it('dismissAll() 连同队列一起清空', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    reminders.tick(milestoneAt(0));
    expect(reminders.active).not.toBeNull();
    expect(reminders.queue.length).toBeGreaterThan(0);

    reminders.dismissAll();
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
  });
});

describe('stores/reminders — 会话非 running 时无候选', () => {
  it('cancel() 后 tick 不产生任何通道动作', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { routine, reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start(); // 此刻无到点

    routine.cancel();
    reminders.dismissAll();
    reminders.tick(milestoneAt(0));

    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(reminders.stats).toEqual({ local: 0, system: 0, skipped: 0 });
    expect(bridge.presentNotificationCalls).toHaveLength(0);
  });
});

describe('stores/reminders — 通知回跳（notification.opened）', () => {
  it('任务形态回跳写入 focusRequest 四字段，clearFocusRequest 清空', async () => {
    const bridge = makeBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    bridge.emitNotificationOpened({ progressID: 'p1', sessionID: SID });

    expect(reminders.focusRequest).not.toBeNull();
    expect(reminders.focusRequest?.progressID).toBe('p1');
    expect(reminders.focusRequest?.sessionID).toBe(SID);
    expect(reminders.focusRequest?.minuteOffset).toBeNull();
    expect(reminders.focusRequest?.at).toBeInstanceOf(Date);

    reminders.clearFocusRequest();
    expect(reminders.focusRequest).toBeNull();
  });

  it('里程碑形态回跳：minuteOffset 保留、progressID 为 null', async () => {
    const bridge = makeBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    bridge.emitNotificationOpened({ sessionID: SID, minuteOffset: -1 });

    expect(reminders.focusRequest?.minuteOffset).toBe(-1);
    expect(reminders.focusRequest?.progressID).toBeNull();
    expect(reminders.focusRequest?.sessionID).toBe(SID);
  });
});

describe('stores/reminders — start/stop 幂等', () => {
  it('未 start() 时 stop() 不抛错，且可重复调用', () => {
    const bridge = makeBridge();
    const { reminders } = setup(bridge);
    expect(() => reminders.stop()).not.toThrow();
    expect(() => reminders.stop()).not.toThrow();
  });

  it('start() 后重复 stop() 不抛错', async () => {
    const bridge = makeBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();
    expect(() => {
      reminders.stop();
      reminders.stop();
    }).not.toThrow();
  });
});
