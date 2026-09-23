import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { formatMinutes, setRoutineBridge, useRoutineStore } from '../src/stores/routine';
import { createMockBridge, type MockBridge } from '../src/platform/mock';
import type { PlatformBridge } from '../src/platform/bridge';
import {
  MORNING_TEMPLATE,
  createProgress,
  createSession,
  createSnapshot,
  createStep,
  makeParseResult,
  type RoutineSession,
} from '../src/core/types';

const CANONICAL = '18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟';

function setup(bridge: PlatformBridge = createMockBridge()): { store: ReturnType<typeof useRoutineStore>; bridge: MockBridge } {
  setRoutineBridge(bridge);
  setActivePinia(createPinia());
  const store = useRoutineStore();
  return { store, bridge: bridge as MockBridge };
}

function sampleSession(overrides: Partial<RoutineSession> = {}): RoutineSession {
  return createSession({
    templateID: 'T',
    templateName: '上班早晨',
    templateSymbol: 'sun.max.fill',
    startedAt: new Date(1_700_000_000_000),
    plannedStartAt: new Date(1_700_000_000_000),
    targetDeadline: null,
    state: 'running',
    primaryDevice: 'phone',
    progress: [createProgress({ step: createStep({ title: '刷牙', duration: 180 }), dueAt: new Date(1_700_000_180_000) })],
    remainingBuffer: 600,
    updatedAt: new Date(1_700_000_000_000),
    revision: 5,
    ...overrides,
  });
}

beforeEach(() => {
  setRoutineBridge(null);
});

describe('stores/routine — init', () => {
  it('init 读设备信息 + 请求通知授权 + 订阅快照变更；载入默认模板', async () => {
    const { store, bridge } = setup();
    await store.init();
    expect(store.ready).toBe(true);
    expect(bridge.deviceInfoCallCount).toBe(1);
    expect(bridge.requestAuthorizationCallCount).toBe(1);
    // 默认 initialSnapshot 含 3 条内置任务线。
    expect(store.templates).toHaveLength(3);
  });

  it('init 优先载入桥上的已存快照', async () => {
    const stored = createSnapshot({
      templates: [],
      activeSession: null,
      updatedAt: new Date(1_000),
    });
    const { store } = setup(createMockBridge({ initialSnapshot: stored }));
    await store.init();
    expect(store.templates).toHaveLength(0);
  });

  it('init 幂等：重复调用不重复请求设备信息', async () => {
    const { store, bridge } = setup();
    await store.init();
    await store.init();
    expect(bridge.deviceInfoCallCount).toBe(1);
  });
});

describe('stores/routine — createTemplate（deadline 有无两分支）', () => {
  it('有 deadline → backward + 追加「完成」硬节点，写入时分', async () => {
    const { store } = setup();
    await store.init();
    const deadline = new Date(2026, 7, 13, 18, 30);
    const template = store.createTemplate('去厕所5分钟 刷杯子2分钟', {
      deadline,
      recurrence: 'once',
    });
    expect(template.mode).toBe('backward');
    expect(template.deadlineHour).toBe(18);
    expect(template.deadlineMinute).toBe(30);
    const deadlineSteps = template.steps.filter((s) => s.role === 'deadline');
    expect(deadlineSteps).toHaveLength(1);
    expect(deadlineSteps[0].title).toBe('完成');
    expect(deadlineSteps[0].importance).toBe('hardDeadline');
  });

  it('deadline 传 null → forward，不追加 deadline 节点', async () => {
    const { store } = setup();
    await store.init();
    const template = store.createTemplate('去厕所5分钟 刷杯子2分钟', {
      deadline: null,
      recurrence: 'once',
    });
    expect(template.mode).toBe('forward');
    expect(template.deadlineHour).toBeNull();
    expect(template.deadlineMinute).toBeNull();
    expect(template.steps.some((s) => s.role === 'deadline')).toBe(false);
  });

  it('复用 lastParse 的已解析步骤（改变重复方式不清空步骤）', async () => {
    // 增强通道返回 2 步，规则只有 1 步 → 管线采纳增强；随后 createTemplate 必须复用这 2 步。
    const enhanced = makeParseResult({
      steps: [
        createStep({ title: '去厕所', duration: 5 * 60 }),
        createStep({ title: '倒垃圾', duration: 2 * 60 }),
      ],
      deadline: null,
      source: 'enhanced',
      leftover: '',
    });
    const { store } = setup(
      createMockBridge({ modelParseResult: enhanced, capabilities: { modelParsing: true } }),
    );
    await store.init();
    await store.parse('去厕所5分钟 别忘了倒垃圾');
    expect(store.lastParse?.steps.map((s) => s.title)).toEqual(['去厕所', '倒垃圾']);

    // 仅改重复方式 → 仍复用了已解析的 2 步（makeSteps 只能给出 1 步）。
    const template = store.createTemplate('去厕所5分钟 别忘了倒垃圾', {
      deadline: null,
      recurrence: 'daily',
    });
    expect(template.steps.map((s) => s.title)).toEqual(['去厕所', '倒垃圾']);
    expect(template.recurrence).toBe('daily');
  });
});

describe('stores/routine — parse（走管线 + 降级提示）', () => {
  it('规范输入 → 3 个任务 + 截止 18:30；无智能能力时提示降级且不调用模型', async () => {
    const { store, bridge } = setup();
    await store.init();
    const result = await store.parse(CANONICAL);
    expect(result.steps.map((s) => s.title)).toEqual(['去厕所', '刷杯子', '买水果']);
    expect(result.deadline?.getHours()).toBe(18);
    expect(result.deadline?.getMinutes()).toBe(30);
    expect(result.source).toBe('rule');
    // 浏览器宿主无模型能力 → 管线不接入增强，不调用 parseWithModel。
    expect(bridge.parseWithModelCalls).toHaveLength(0);
    expect(store.notice).not.toBeNull();
    expect(store.lastParse).not.toBeNull();
  });

  it('有模型能力但返回 null → 静默回退规则 + 降级提示（不抛错）', async () => {
    const bridge = createMockBridge({
      modelParseResult: null,
      capabilities: { modelParsing: true },
    });
    const { store } = setup(bridge);
    await store.init();
    const result = await store.parse('去厕所5分钟 别忘了倒垃圾');
    expect(bridge.parseWithModelCalls).toHaveLength(1);
    expect(result.source).toBe('rule');
    expect(result.steps.map((s) => s.title)).toEqual(['去厕所']);
    expect(store.notice).not.toBeNull();
  });

  it('解析无步骤 → lastParse 为 null，返回空结果（不抛错、不空白页）', async () => {
    const { store } = setup();
    await store.init();
    const result = await store.parse('今天天气不错');
    expect(result.hasSteps).toBe(false);
    expect(store.lastParse).toBeNull();
  });

  it('端到端（对齐创建页 generate→rebuild）：规范输入 → 3 任务 + 截止 18:30 的 backward 模板', async () => {
    const { store } = setup();
    await store.init();
    const result = await store.parse(CANONICAL);
    // 视图在生成后把截止时间与重复方式回传给 createTemplate（模拟 hasDeadline=true）。
    const template = store.createTemplate(CANONICAL, {
      deadline: result.deadline,
      recurrence: 'once',
    });
    expect(template.mode).toBe('backward');
    expect(template.deadlineHour).toBe(18);
    expect(template.deadlineMinute).toBe(30);
    expect(template.steps.filter((s) => s.role === 'task').map((s) => s.title)).toEqual([
      '去厕所',
      '刷杯子',
      '买水果',
    ]);
    // 追加的 deadline 节点不复用任务名。
    expect(template.steps.filter((s) => s.role === 'deadline')).toHaveLength(1);
  });
});

describe('stores/routine — commit 收口（writeSnapshot → replaceNotifications）', () => {
  it('start 后触发一次 writeSnapshot 与 replaceNotifications（会话非空）', async () => {
    const { store, bridge } = setup();
    await store.init();
    const writesBefore = bridge.writeSnapshotCalls.length;

    store.start(MORNING_TEMPLATE);

    expect(bridge.writeSnapshotCalls.length).toBe(writesBefore + 1);
    expect(bridge.replaceNotificationsCalls.length).toBeGreaterThan(0);
    expect(bridge.replaceNotificationsCalls.at(-1)?.id).toBe(store.session?.id);
    expect(store.session).not.toBeNull();
  });

  it('addTemplate / startProgress 也各自 commit', async () => {
    const { store, bridge } = setup();
    await store.init();
    store.addTemplate(MORNING_TEMPLATE);
    const afterAdd = bridge.writeSnapshotCalls.length;
    expect(afterAdd).toBeGreaterThan(0);

    store.start(MORNING_TEMPLATE);
    const first = store.session!.progress[0];
    store.startProgress(first);
    expect(bridge.writeSnapshotCalls.length).toBeGreaterThan(afterAdd);
    expect(store.currentProgress?.id).toBe(first.id);
    expect(bridge.replaceNotificationsCalls.at(-1)?.id).toBe(store.session?.id);
  });
});

describe('stores/routine — applyIncoming（跨端冲突裁决转调）', () => {
  it('桥推送更新的外部快照 → 采纳并刷新响应式 snapshot', async () => {
    const { store, bridge } = setup();
    await store.init();

    const incoming = createSnapshot({
      templates: [],
      activeSession: sampleSession({ revision: 5 }),
      updatedAt: new Date(1_800_000_000_000),
      originID: 'other-device',
    });
    bridge.emitSnapshotChanged(incoming);
    expect(store.snapshot.activeSession?.revision).toBe(5);
  });

  it('originID 等于本机 deviceID → 拒绝（防同步自激）', async () => {
    const { store } = setup(createMockBridge({ deviceId: 'mock-device' }));
    await store.init();
    const self = createSnapshot({
      templates: [],
      activeSession: sampleSession({ revision: 9 }),
      updatedAt: new Date(1_900_000_000_000),
      originID: 'mock-device',
    });
    const adopted = store.applyIncoming(self);
    expect(adopted).toBe(false);
    expect(store.snapshot.activeSession).toBeNull();
  });

  it('未采纳时不再 commit（写调用数不变）', async () => {
    const { store, bridge } = setup();
    await store.init();
    const before = bridge.writeSnapshotCalls.length;
    const stale = createSnapshot({
      templates: [],
      activeSession: sampleSession({ revision: 0 }),
      // updatedAt 早于当前（DISTANT_PAST）且 revision 未增 → 拒绝。
      updatedAt: new Date(-63_000_000_000_000),
      originID: 'other-device',
    });
    expect(store.applyIncoming(stale)).toBe(false);
    expect(bridge.writeSnapshotCalls.length).toBe(before);
  });
});

describe('stores/routine — 视图辅助', () => {
  it('formatMinutes 逐字复刻 Swift 文案', () => {
    expect(formatMinutes(90)).toBe('1 分钟');
    expect(formatMinutes(1800)).toBe('30 分钟');
    expect(formatMinutes(3600)).toBe('1 小时');
    expect(formatMinutes(3900)).toBe('1 小时 5 分钟');
    expect(formatMinutes(0)).toBe('0 分钟');
  });
});
