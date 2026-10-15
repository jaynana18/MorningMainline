import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setRoutineBridge, useRoutineStore } from '../src/stores/routine';
import { OVERDUE_AUTO_DISMISS_MS, useRemindersStore } from '../src/stores/reminders';
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
  it('start/stop 向宿主声明页内提醒通道 ready 状态', async () => {
    const bridge = makeBridge({ backgroundNotification: true });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();
    expect(bridge.foregroundReminderReadyStates).toEqual([true]);

    reminders.stop();
    expect(bridge.foregroundReminderReadyStates).toEqual([true, false]);
  });

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
  it('hidden→visible 不补弹「引擎没盯着」期间到点的提醒，之后新到点仍正常弹（桥驱动）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // 桥未给初始态（mock lastAppState=null）→ 引擎按前台启动（visible=true），watchedSince=11:45。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    // 走真实桥路径：原生发 {visible:false} → applyVisibility。
    bridge.emitAppStateChanged(false);
    expect(reminders.visible).toBe(false);

    // 模拟 iOS 后台：JS 计时器被挂起、期间不 tick；系统时间直接跳到 12:05。
    vi.setSystemTime(new Date(2026, 7, 13, 12, 5, 0));
    bridge.emitAppStateChanged(true); // → watchedSince=12:05，再 tick

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

  it('恢复时刻仅 30s 余量：命中「重建 watchedSince」不变式，不靠 VISIBLE_CATCH_UP_MS 兜底（桥驱动）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // 桥未给初始态（mock lastAppState=null）→ 引擎按前台启动（visible=true），watchedSince=11:45。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    // 走真实桥路径：原生发 {visible:false} → applyVisibility。
    bridge.emitAppStateChanged(false);
    expect(reminders.visible).toBe(false);

    // 模拟 iOS 后台：JS 计时器被挂起、期间不 tick；系统时间直接跳到 12:00:30 再回前台。
    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 30));
    bridge.emitAppStateChanged(true); // → watchedSince=12:00:30，再 tick

    // 8 个里程碑 fireAt：11:50 / 11:55 / 11:57 / 11:59 / 12:00 / 12:02 / 12:04 / 12:06。
    // 恢复时刻 12:00:30 之前到点的只有前 5 条（含 12:00 那条）→ 全部 skipped，无弹窗。
    //
    // 关键（30s 余量的意图）：那条 12:00 的里程碑距恢复时刻只有 30s。若有人删掉
    // applyVisibility 里的 `if (wasHidden && next) { watchedSince = new Date(); }`（不重建
    // watchedSince），它既不是 staleForEngine（watchedSince 停在 11:45，fireAt 12:00 >= 11:45），
    // 也不必被 staleForNow 挡（30s < 90s）→ 必然弹出 → 本用例变红。
    // 因此只要 VISIBLE_CATCH_UP_MS > 30_000，本用例就对「重建 watchedSince」这条不变式保持
    // 杀伤力；即便有人把闸门从 90s 调小到 31s/45s/60s 也不会失效。请勿把它降到 30s 及以下。
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(reminders.stats.local).toBe(0);
    expect(reminders.stats.skipped).toBe(5);

    // 证明重建 watchedSince 只挡「过去」、不吞「未来」：12:02 的里程碑随后仍正常弹窗。
    vi.setSystemTime(milestoneAt(2));
    reminders.tick();
    expect(reminders.active?.key).toBe(`deadline:${SID}:2`);
    expect(reminders.stats.local).toBe(1);
  });

  it('hidden 期间到点由系统通道消化，回前台不再补弹（两通道互斥、不重复，桥驱动）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    bridge.emitAppStateChanged(false);
    // 与上一条不同：这里 hidden 期间**仍 tick**（模拟浏览器宿主后台仍在跑），
    // -10..0 共 5 条经系统通道投递并标记。
    reminders.tick(milestoneAt(0));
    expect(reminders.stats.system).toBe(5);
    expect(bridge.presentNotificationCalls).toHaveLength(5);

    vi.setSystemTime(milestoneAt(0));
    bridge.emitAppStateChanged(true); // 回前台：watchedSince=12:00，tick
    // 已由系统通道标记的那 5 条不会再从弹窗通道补一遍；local 不增、system 不再增。
    expect(reminders.stats.local).toBe(0);
    expect(reminders.stats.system).toBe(5);
    expect(reminders.active).toBeNull();
    expect(bridge.presentNotificationCalls).toHaveLength(5);
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

describe('stores/reminders — 前后台来源为桥（app.state）', () => {
  it('start() 时桥立即给出 visible:false → store 的 visible 为 false，后续到点走系统通道', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    // 订阅建立前桥已有当前态（false）。
    bridge.emitAppStateChanged(false);
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    // 「订阅即得当前值」这条路真的通了。
    expect(reminders.visible).toBe(false);

    reminders.tick(milestoneAt(0));
    expect(reminders.active).toBeNull();
    expect(reminders.queue).toHaveLength(0);
    expect(reminders.stats.system).toBe(5);
    expect(bridge.presentNotificationCalls).toHaveLength(5);
  });

  it('stop() 后 emitAppStateChanged(true) 不再影响 store（退订生效）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();

    bridge.emitAppStateChanged(false);
    expect(reminders.visible).toBe(false);

    reminders.stop();
    bridge.emitAppStateChanged(true);

    // 已退订：状态不再被桥改写。
    expect(reminders.visible).toBe(false);
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

// ---------------------------------------------------------------------------
// 超时循环提醒（2026-10-14 新增）
// ---------------------------------------------------------------------------

describe('stores/reminders — 超时每 2 分钟循环提醒（可见 → 页内弹窗）', () => {
  /** 造一个「正在进行的任务」，起点 11:00、时长 10 分钟 → 11:10 起超时。 */
  function makeActiveBridge(capabilities: Partial<BridgeCapabilities> = {}): MockBridge {
    const startedAt = new Date(2026, 7, 13, 11, 0, 0);
    const task = createProgress({
      id: 'P-OVD',
      step: createStep({ title: '写代码', duration: 10 * 60 }),
      dueAt: new Date(2026, 7, 13, 11, 10, 0),
      state: 'active',
      startedAt,
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
    const session = createSession({
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
      activeProgressID: task.id,
    });
    return createMockBridge({
      initialSnapshot: createSnapshot({
        templates: [],
        activeSession: session,
        updatedAt: session.updatedAt,
      }),
      capabilities,
    });
  }

  it('超时不满 2 分钟 → 不弹超时提醒（到点那一刻已经由 taskReminder 响过）', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 10, 0));
    await reminders.start();

    // 11:11:30 → 超时 90 秒，不满 2 分钟。
    reminders.tick(new Date(2026, 7, 13, 11, 11, 30));
    expect(reminders.active?.key.startsWith('overdue:')).not.toBe(true);
  });

  it('超时满 2 分钟 → 弹超时提醒；文案为实际超时分钟数', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 5)); // 超时 125 秒 → floor = 2 分钟
    expect(reminders.active?.key).toBe('overdue:P-OVD:0');
    expect(reminders.active?.title).toBe('不跑偏 · 超时了');
    expect(reminders.active?.body).toBe('“写代码”已经超了 2 分钟，先把它收尾。');
    expect(reminders.active?.level).toBe('timeSensitive');
    expect(reminders.active?.sound).toBe('overdue');
  });

  it('同一轮内 tick 多次只入队一次（不刷屏）', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    const after = reminders.stats.local;
    reminders.tick(new Date(2026, 7, 13, 11, 12, 1));
    reminders.tick(new Date(2026, 7, 13, 11, 13, 0));
    expect(reminders.stats.local).toBe(after);
    expect(reminders.queue).toHaveLength(0);
  });

  it('🔴 每满 2 分钟进入新一轮 → 再次弹窗（循环）', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 0)); // 第 0 轮
    expect(reminders.active?.key).toBe('overdue:P-OVD:0');
    reminders.dismiss();

    reminders.tick(new Date(2026, 7, 13, 11, 14, 0)); // 超时 4 分钟 → 第 1 轮
    expect(reminders.active?.key).toBe('overdue:P-OVD:1');
    expect(reminders.active?.body).toBe('“写代码”已经超了 4 分钟，先把它收尾。');
    reminders.dismiss();

    reminders.tick(new Date(2026, 7, 13, 11, 16, 30)); // 超时 390 秒 = 6.5 分钟 → floor = 6 分钟
    expect(reminders.active?.key).toBe('overdue:P-OVD:2');
    expect(reminders.active?.body).toBe('“写代码”已经超了 6 分钟，先把它收尾。');
  });

  it('弹窗约几秒后自动关闭（不用用户手动点）', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    expect(reminders.active?.key).toBe('overdue:P-OVD:0');

    vi.advanceTimersByTime(OVERDUE_AUTO_DISMISS_MS + 10);
    expect(reminders.active).toBeNull();
  });

  it('自动关闭不会误关别人：用户已手动关掉并换上另一条时不动它', async () => {
    const bridge = makeActiveBridge();
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    const overdueKey = reminders.active!.key;
    expect(overdueKey).toBe('overdue:P-OVD:0');

    // 用户立刻点了「知道了」，紧接着 deadline 里程碑弹了出来。
    reminders.dismiss();
    reminders.tick(new Date(2026, 7, 13, 12, 2, 0)); // 🚨 Deadline 已延误 2 分钟
    const milestoneKey = reminders.active?.key;
    expect(milestoneKey).not.toBeUndefined();
    expect(milestoneKey).not.toBe(overdueKey);

    vi.advanceTimersByTime(OVERDUE_AUTO_DISMISS_MS + 10);
    // 过期的那个计时器不该把当前这条里程碑关掉。
    expect(reminders.active?.key).toBe(milestoneKey);
  });

  it('页面不可见 → 走系统通道（双通道互斥）', async () => {
    const bridge = makeActiveBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.visible = false;
    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));

    // 两条各自独立：任务到点（dueAt=11:10，首轮 tick 才被看到）+ 超时第 0 轮。
    expect(reminders.active).toBeNull();
    expect(bridge.presentNotificationCalls).toHaveLength(2);
    expect(bridge.presentNotificationCalls.at(-1)?.title).toBe('不跑偏 · 超时了');
    expect(reminders.stats.system).toBe(2);
  });

  it('后台同一轮重复 tick 不重复投递（否则 1Hz 刷屏）', async () => {
    const bridge = makeActiveBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();

    reminders.visible = false;
    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    // 首轮 tick 会有两条：任务到点（dueAt=11:10）+ 超时第 0 轮。
    const after = bridge.presentNotificationCalls.length;
    expect(after).toBe(2);

    // 之后同一轮的每次 tick 都不该再投。
    reminders.tick(new Date(2026, 7, 13, 11, 12, 30));
    reminders.tick(new Date(2026, 7, 13, 11, 13, 0));
    expect(bridge.presentNotificationCalls).toHaveLength(after);

    // 满 4 分钟 → 新一轮，再投一条。
    reminders.tick(new Date(2026, 7, 13, 11, 14, 0));
    expect(bridge.presentNotificationCalls).toHaveLength(after + 1);
    expect(bridge.presentNotificationCalls.at(-1)?.title).toBe('不跑偏 · 超时了');
  });

  it('任务完成 → 停止超时提醒（不再有候选）', async () => {
    const bridge = makeActiveBridge();
    const { reminders, routine } = setup(bridge);
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0));
    await reminders.start();
    await routine.ensureReady();

    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    expect(reminders.active?.key).toBe('overdue:P-OVD:0');
    reminders.dismiss();

    // 走真实 store 动作把当前任务收尾（比直接改对象更接近实际调用路径）。
    const task = routine.session!.progress.find((item) => item.id === 'P-OVD')!;
    routine.complete(task, new Date(2026, 7, 13, 11, 13, 0));

    reminders.tick(new Date(2026, 7, 13, 11, 14, 0));
    expect(reminders.active).toBeNull();
  });
});




// ---------------------------------------------------------------------------
// 语音播报（2026-10-16 新增）
//
// 用户诉求：「期望及时在使用手机的时候也总是能播报；屏幕亮时也要能播报到耳机；
// 通知内容要播报当前是几点了、任务延误了几分钟了」。
//
// 注意：播报里的「现在几点」取自**系统时钟**（`new Date()`），因此每个触发播报的
// 动作之前都必须先 `vi.setSystemTime(...)`，否则念的是测试机器的真实时间。
// ---------------------------------------------------------------------------

describe('stores/reminders — 语音播报', () => {
  it('🔴 弹窗出现即播报，内容以「现在是 X 点 Y 分。」开头', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();

    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(bridge.speakCalls).toEqual([
      '现在是11 点 59 分。距离计划结束还有 1 分钟。请确认最重要的任务正在推进。',
    ]);
  });

  it('🔴 时刻取自「播报那一刻」，不是提醒原本的 fireAt', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();
    reminders.dismissAll();
    bridge.speakCalls.length = 0;

    // 12:00 那条里程碑直到 12:00:30 才被 tick 到 → 念的是 12 点 0 分。
    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 30));
    reminders.tick(new Date(2026, 7, 13, 12, 0, 30));

    expect(reminders.active?.key).toBe(`deadline:${SID}:0`);
    expect(bridge.speakCalls).toEqual([
      '现在是12 点 0 分。计划时间到了。计划还没有完成，请先回到主线。',
    ]);
  });

  it('⚠️ 队列里排队的提醒不播 —— 避免听到屏幕上没有的那条', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { reminders } = setup(bridge);

    // 11:50 启动 → -10 里程碑到点并显示（同时播报一次）。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 50, 0));
    await reminders.start();
    expect(reminders.active?.key).toBe(`deadline:${SID}:-10`);
    expect(bridge.speakCalls).toHaveLength(1);

    bridge.speakCalls.length = 0;

    // 12:00 再 tick：-1 与 0 两条同时到点。当前仍显示着 -10，故这两条进队列。
    // （-5 / -3 早已超过 90s 补弹闸门 → 直接 skipped，见上一组用例。）
    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 0));
    reminders.tick(new Date(2026, 7, 13, 12, 0, 0));

    expect(reminders.active?.key).toBe(`deadline:${SID}:-10`);
    expect(reminders.queue.map((item) => item.key)).toEqual([
      `deadline:${SID}:-1`,
      `deadline:${SID}:0`,
    ]);
    // 关键：排队期间一次都不播 —— 播了就等于「听到的」和「看到的」对不上。
    expect(bridge.speakCalls).toHaveLength(0);

    // 关掉当前这条 → 队列前进 → 这时才播下一条。
    reminders.dismiss();
    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(bridge.speakCalls).toEqual([
      '现在是12 点 0 分。距离计划结束还有 1 分钟。请确认最重要的任务正在推进。',
    ]);
  });

  it('宿主无播报能力（speech=false）→ 完全不调用，弹窗照常', async () => {
    const bridge = makeBridge({ backgroundNotification: false, speech: false });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();

    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(bridge.speakCalls).toHaveLength(0);
  });

  it('后台通道不播报（人没看屏幕时不该抢占音频，交给系统通知）', async () => {
    const bridge = makeBridge({ backgroundNotification: false, speech: true });
    const { reminders } = setup(bridge);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 45, 0));
    await reminders.start();
    bridge.speakCalls.length = 0;

    reminders.visible = false;
    reminders.tick(new Date(2026, 7, 13, 12, 0, 0));

    expect(bridge.presentNotificationCalls.length).toBeGreaterThan(0);
    expect(bridge.speakCalls).toHaveLength(0);
  });

  it('🔴 超时循环：每一轮重新弹窗时都重新播报，延误分钟随轮次递增', async () => {
    const startedAt = new Date(2026, 7, 13, 11, 0, 0);
    const task = createProgress({
      id: 'P-SPK',
      step: createStep({ title: '写代码', duration: 10 * 60 }),
      dueAt: new Date(2026, 7, 13, 11, 10, 0),
      state: 'active',
      startedAt,
    });
    const session = createSession({
      id: SID,
      templateID: 'T',
      templateName: '任务线',
      templateSymbol: 'sun.max.fill',
      startedAt,
      plannedStartAt: startedAt,
      // targetDeadline 设 null：不产里程碑，隔离出超时这一条。
      targetDeadline: null,
      state: 'running',
      primaryDevice: 'phone',
      progress: [task],
      remainingBuffer: 0,
      updatedAt: startedAt,
      revision: 1,
      activeProgressID: task.id,
    });
    const bridge = createMockBridge({
      initialSnapshot: createSnapshot({
        templates: [],
        activeSession: session,
        updatedAt: session.updatedAt,
      }),
      capabilities: { backgroundNotification: false },
    });
    const { reminders } = setup(bridge);

    vi.setSystemTime(startedAt);
    await reminders.start();
    bridge.speakCalls.length = 0;

    // 11:12 → 超时 2 分钟 → 第 0 轮。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 12, 0));
    reminders.tick(new Date(2026, 7, 13, 11, 12, 0));
    expect(reminders.active?.key).toBe('overdue:P-SPK:0');
    expect(bridge.speakCalls).toEqual([
      '现在是11 点 12 分。“写代码”已经延误 2 分钟了，先把它收尾。',
    ]);
    reminders.dismiss();

    // 11:14 → 第 1 轮，延误 4 分钟。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 14, 0));
    reminders.tick(new Date(2026, 7, 13, 11, 14, 0));
    expect(reminders.active?.key).toBe('overdue:P-SPK:1');
    expect(bridge.speakCalls).toHaveLength(2);
    expect(bridge.speakCalls[1]).toBe(
      '现在是11 点 14 分。“写代码”已经延误 4 分钟了，先把它收尾。',
    );
  });

  it('开关默认开：未做任何设置时就该播报（装完即用，不用先去设置里找）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { routine, reminders } = setup(bridge);

    expect(routine.settings.speechEnabled).toBe(true);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();

    expect(bridge.speakCalls).toHaveLength(1);
  });

  it('🔴 关掉开关后只弹窗不播报 —— 关的是声音，不是提醒本身', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { routine, reminders } = setup(bridge);

    await routine.saveSettings({ speechEnabled: false });
    expect(routine.settings.speechEnabled).toBe(false);

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();

    // 弹窗照常出现（`active.value = reminder` 在开关判断之前）——
    // 若把 `return` 写在赋值之前，用户关掉声音就连提醒都收不到了。
    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(bridge.speakCalls).toHaveLength(0);
  });

  it('关掉开关后，队列前进仍不播报（开关是全程生效，不是只拦第一条）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { routine, reminders } = setup(bridge);

    await routine.saveSettings({ speechEnabled: false });

    // 11:50 启动 → -10 显示（不播），12:00 → -1 与 0 进队列。
    vi.setSystemTime(new Date(2026, 7, 13, 11, 50, 0));
    await reminders.start();
    expect(reminders.active?.key).toBe(`deadline:${SID}:-10`);

    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 0));
    reminders.tick(new Date(2026, 7, 13, 12, 0, 0));
    reminders.dismiss();

    // 队列前进走的是 `present()`，同样要过开关。
    expect(reminders.active?.key).toBe(`deadline:${SID}:-1`);
    expect(bridge.speakCalls).toHaveLength(0);
  });

  it('开关重新打开后恢复播报（不是一次性失效）', async () => {
    const bridge = makeBridge({ backgroundNotification: false });
    const { routine, reminders } = setup(bridge);

    await routine.saveSettings({ speechEnabled: false });
    await routine.saveSettings({ speechEnabled: true });

    vi.setSystemTime(new Date(2026, 7, 13, 11, 59, 0));
    await reminders.start();

    expect(bridge.speakCalls).toHaveLength(1);
  });
});
