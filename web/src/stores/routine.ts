/**
 * stores/routine.ts — 唯一 Pinia store（ARCHITECTURE §4b.2 冻结契约）。
 *
 * 设计：
 * - 内部持有 `core/store.ts` 的 `RoutineStore` 实例；**core 层不做响应式改造**，由 Pinia 包一层。
 * - 每次变更后收口到私有 `commit()`：`snapshot` 重新赋值 → `writeSnapshot()` → `replaceNotifications(session)`。
 *   视图层**不得**各自调用后两者。
 * - `parsePlan()` 请求已登录账号的 AI 解析与缓存，失败明确提示，不再静默采用本机规则。
 * - `createTemplate()` 复用 `core/parser.ts` 的 `makeTemplate`，实现 iOS 创建页的截止时间交互语义。
 *
 * 视图层禁止直接 import `core/` 或 `platform/`；本模块是唯一门面，并在此重导出视图需要的小工具。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  ParseResult,
  Recurrence,
  RoutineSession,
  RoutineSnapshot,
  RoutineTemplate,
  StepProgress,
  TemporaryTaskPlacement,
} from '../core/types';
import {
  RECURRENCE_TITLES,
  RECURRENCES,
  PARSE_SOURCE_TITLES,
  cloneSnapshot,
  initialSnapshot,
  makeParseResult,
} from '../core/types';
import { makeTemplate } from '../core/parser';
import { parseTaskPlan } from '../platform/taskParsing';
import { isIncomplete } from '../core/session';
import { RoutineStore } from '../core/store';
import type { PlatformBridge } from '../platform/bridge';
import { EMPTY_SHARED_SETTINGS, type SharedSettings } from '../platform/bridge';
import type { CommuteRoute } from '../platform/commute';
import { resolveBridge } from '../platform/hostBridge';

// 重导出：视图层经 store 取用（避免直接 import core）。
export { RECURRENCE_TITLES, RECURRENCES, PARSE_SOURCE_TITLES };
export { deadlineStep, effectiveRecurrence, totalTaskDuration } from '../core/session';
// 预览页（PreviewView）需要的派生纯函数：只保留 task 步骤 / 计算某天的截止时刻。
export { deadlineOn, taskSteps } from '../core/session';
export { editTasks } from '../core/taskEdits';
export { queryCommute } from '../platform/commute';
export type { TravelMode, CommuteRoute } from '../platform/commute';
// 跨设备设置类型经 store 中转（视图层不直接 import platform/）。
export type { SharedSettings } from '../platform/bridge';
export { createStep } from '../core/types';
// 会话页（SessionView）需要的派生纯函数：预计排程 / 是否迟到 / 未完成判定 / 原计划时间。
export {
  estimatedCompletion,
  estimatedDueDates,
  isIncomplete,
  isLate,
  originalDueAt,
} from '../core/session';
// 类型亦经 store 中转，保证「视图层不直接 import core/」。
export type {
  ParseResult,
  Recurrence,
  RoutineSession,
  RoutineSnapshot,
  RoutineStep,
  RoutineTemplate,
  StepProgress,
  TemporaryTaskPlacement,
} from '../core/types';

/** 所有时间调用显式使用此时区（沿用 P0 既有做法）。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 测试/集成注入桥的接缝（默认 `createBridge()`）。 */
let bridgeOverride: PlatformBridge | null = null;

/** 注入自定义桥（仅测试或无持久化场景使用）。传 `null` 恢复默认探测。 */
export function setRoutineBridge(bridge: PlatformBridge | null): void {
  bridgeOverride = bridge;
}

/**
 * 取本 store 使用的宿主桥，并供同进程的其他 store（如 `stores/reminders.ts`）复用**同一实例**。
 *
 * 为什么必须是同一个：`WebViewBridge.install()` 会把自己挂到 `window.__mainlineReply` /
 * `window.__mainlineEmit`（单一全局槽位），两个实例会互相覆盖，先建实例的 pending 调用
 * 将永远等不到回执、逐个静默超时。详见 `platform/hostBridge.ts`。
 *
 * 仍以 `bridgeOverride`（`setRoutineBridge` 注入）优先，语义不变。
 */
export function resolveStoreBridge(): PlatformBridge {
  return bridgeOverride ?? resolveBridge();
}

/** 时长格式化（逐字复刻 `iOS/ContentView.swift` 的 `formatMinutes`）。 */
export function formatMinutes(seconds: number, includeSeconds = false): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (includeSeconds) {
    if (hours > 0) {
      return `${hours} 小时 ${minutes} 分 ${remainingSeconds} 秒`;
    }
    if (minutes > 0) {
      return `${minutes} 分 ${remainingSeconds} 秒`;
    }
    return `${remainingSeconds} 秒`;
  }
  if (hours > 0 && minutes > 0) {
    return `${hours} 小时 ${minutes} 分钟`;
  }
  if (hours > 0) {
    return `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

export interface StartOptions {
  deadlineOverride?: Date | null;
  bufferOverride?: number | null;
}

export interface CreateTemplateOptions {
  deadline: Date | null;
  recurrence: Recurrence;
  steps?: import('../core/types').RoutineStep[];
}

export const useRoutineStore = defineStore('routine', () => {
  const bridge: PlatformBridge = resolveStoreBridge();
  const tz = DEFAULT_TIME_ZONE;

  // ---- state ----
  const snapshot = ref<RoutineSnapshot>(initialSnapshot());
  const ready = ref(false);
  const parsing = ref(false);
  const lastParse = ref<ParseResult | null>(null);
  const notice = ref<string | null>(null);
  // 「已选但未开始」的模板：点任务卡 / 保存新建后进入预览页，选完计划才真正 start。
  // 对齐 Swift `ContentView.selectedTemplate` 的 `navigationDestination(item:)`。
  const pendingTemplate = ref<RoutineTemplate | null>(null);
  /**
   * 跨设备共用设置（高德 Key / 出行方式）。
   *
   * 放在 store 而非组件里：创建页与设置页都要读它，且值经原生同步到手表，
   * 属于会话级的共享状态。浏览器宿主下只有本页有效（无手表、无 App Group）。
   */
  const settings = ref<SharedSettings>({ ...EMPTY_SHARED_SETTINGS });

  // core 状态机实例在 init() 中建（需先拿到持久的 deviceInfo）。
  let routine: RoutineStore | null = null;
  let unsubscribeSnapshotChanged: (() => void) | null = null;
  // init() 只跑一次；视图的动作路径经 ensureReady() 等同一个 Promise。
  let initPromise: Promise<void> | null = null;

  // ---- getters ----
  const session = computed<RoutineSession | null>(() => snapshot.value.activeSession);

  const currentProgress = computed<StepProgress | null>(() => {
    const active = snapshot.value.activeSession;
    if (!active || active.state !== 'running' || active.activeProgressID === null) {
      return null;
    }
    return (
      active.progress.find(
        (item) => item.id === active.activeProgressID && item.state === 'active',
      ) ?? null
    );
  });

  const nextProgress = computed<StepProgress[]>(() => {
    const active = snapshot.value.activeSession;
    if (!active) {
      return [];
    }
    return active.progress.filter((item) => isIncomplete(item.state));
  });

  const templates = computed<RoutineTemplate[]>(() => snapshot.value.templates);

  // ---- 内部：commit 收口 ----
  function requireRoutine(): RoutineStore {
    if (!routine) {
      throw new Error('RoutineStore 尚未初始化，请先调用 init()。');
    }
    return routine;
  }

  /** 每次状态变更后的唯一收口：刷新响应式快照 → 持久化 → 重排通知。 */
  function commit(): void {
    if (!routine) {
      return;
    }
    snapshot.value = cloneSnapshot(routine.snapshot);
    void bridge.writeSnapshot(snapshot.value);
    void bridge.replaceNotifications(snapshot.value.activeSession);
  }

  // ---- actions ----
  /**
   * 初始化（幂等，失败可重试）。
   *
   * ⚠️ web 特有问题：`RoutineStore` 是异步建的（要先拿持久的 `deviceInfo`），但
   * `templates` 在 store 创建那一刻就有值（`initialSnapshot()` 的内置模板）。
   * 这之间存在一个窗口 —— 卡片已可点，而 core 状态机还是 null。Swift 版 store 在
   * `MorningMainlineApp.init()` 里同步构造，没有这个窗口。视图层必须经
   * `ensureReady()` 再动作，不能只看 `templates` 非空。
   */
  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = performInit().catch((error: unknown) => {
        // 失败后清空，允许下一次调用重试；否则会永久缓存一个 rejected promise。
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  }

  async function performInit(): Promise<void> {
    const info = await bridge.deviceInfo();
    const stored = await bridge.readSnapshot();
    // 设置读失败不该拖垮 init —— 拿不到就用空值，交通方式回落开车。
    settings.value = await bridge.readSettings().catch(() => ({ ...EMPTY_SHARED_SETTINGS }));
    routine = new RoutineStore({
      deviceRole: info.role,
      deviceID: info.id,
      tz,
      initialSnapshot: stored ?? initialSnapshot(),
    });
    snapshot.value = cloneSnapshot(routine.snapshot);

    unsubscribeSnapshotChanged = bridge.onSnapshotChanged((incoming) => {
      applyIncoming(incoming);
    });

    // `ready` 的语义是「core 状态机已建好、视图可以开始动作」，而通知授权与渲染**无关**。
    // 因此这里**不 await**：浏览器宿主下 `Notification.requestPermission()` 可能长期不 settle
    // （用户忽略弹窗 / 浏览器因非用户手势而挂起），一旦 await，首页会永久停在「正在载入…」
    // 且**没有任何报错**——静默卡死，最难排查。详见 platform/browser.ts 的 PERMISSION_TIMEOUT_MS。
    // 另：不 await 也顺带避免了「授权失败 → 整个 init reject → ready 永假」这条耦合。
    void bridge.requestNotificationAuthorization().catch(() => {
      // 静默降级：通知授权失败不得影响主流程（§4b.1）。
    });

    ready.value = true;
  }

  /** 等初始化完成。视图执行任何依赖 core 状态机的动作前必须先 await 它。 */
  async function ensureReady(): Promise<void> {
    if (ready.value) {
      return;
    }
    await init();
  }

  /** 停止订阅（组件卸载 / 热更新时调用）。 */
  function dispose(): void {
    unsubscribeSnapshotChanged?.();
    unsubscribeSnapshotChanged = null;
  }

  /**
   * 保存跨设备设置。
   *
   * **必须走桥**：浏览器宿主下写 localStorage 只对本页有效，手表读不到。
   * WebView 宿主下原生会写进 App Group 并经 WCSession 广播给手表，
   * 手表上的一句话创建才能用同一个 Key 选点。
   */
  async function saveSettings(next: Partial<SharedSettings>): Promise<void> {
    const merged: SharedSettings = { ...settings.value, ...next };
    settings.value = merged;
    await bridge.writeSettings(merged);
  }

  async function parse(input: string): Promise<ParseResult> {
    const plan = await parsePlan(input);
    const result = makeParseResult({ steps: [...plan.preparation, ...plan.stops.flatMap(stop => stop.steps)], deadline: plan.deadline, source: 'enhanced', leftover: '' });
    lastParse.value = result.hasSteps ? result : null;
    return result;
  }

  async function parsePlan(input: string) {
    parsing.value = true;
    notice.value = null;
    try {
      return await parseTaskPlan(input);
    } catch (error) {
      lastParse.value = null;
      throw error;
    } finally {
      parsing.value = false;
    }
  }

  /**
   * 组装任务线。复用 `makeTemplate`。
   * - `opts.deadline === null` ⇒ forward 模式，不追加 deadline 节点；
   * - 有 deadline ⇒ backward，追加 `完成` 节点并写入时分。
   *
   * 已解析步骤优先取 `lastParse`（对齐 iOS `rebuild()` 的「改截止/重复不清空步骤」语义）。
   */
  function createTemplate(_input: string, opts: CreateTemplateOptions): RoutineTemplate {
    const now = new Date();
    const cached = lastParse.value;
    const steps = opts.steps ?? (cached && cached.hasSteps ? cached.steps : null);
    if (!steps) throw new Error('请先完成 AI 识别，再生成任务线。');
    const template = makeTemplate(steps, opts.deadline, opts.recurrence, now, tz);
    if (!template) {
      throw new Error('无法生成任务线：没有可识别的任务步骤。');
    }
    return template;
  }

  function addTemplate(template: RoutineTemplate): void {
    requireRoutine().addTemplate(template);
    commit();
  }

  function replaceTemplate(template: RoutineTemplate): void {
    requireRoutine().replaceTemplate(template);
    commit();
  }

  function deleteTemplate(id: string): void {
    requireRoutine().deleteTemplate(id);
    if (pendingTemplate.value?.id === id) pendingTemplate.value = null;
    commit();
  }

  /** 记录「待预览」的模板（进入 /preview）。传 null 表示清空。 */
  function selectTemplate(template: RoutineTemplate | null): void {
    pendingTemplate.value = template;
  }

  function start(template: RoutineTemplate, opts?: StartOptions): void {
    requireRoutine().start(
      template,
      opts?.deadlineOverride ?? null,
      opts?.bufferOverride ?? null,
    );
    commit();
  }

  function startProgress(progress: StepProgress, now?: Date): void {
    requireRoutine().startProgress(progress, now);
    commit();
  }

  function startParallelProgress(progressIDs: string[], now?: Date): void {
    requireRoutine().startParallelProgress(progressIDs, now);
    commit();
  }

  function complete(progress: StepProgress, now?: Date): void {
    requireRoutine().complete(progress, now);
    commit();
  }

  function snoozeCurrent(seconds?: number): void {
    requireRoutine().snoozeCurrent(seconds ?? 120);
    commit();
  }

  function addTemporaryTask(
    title: string,
    minutes: number,
    placement: TemporaryTaskPlacement,
  ): void {
    requireRoutine().addTemporaryTask(title, minutes, placement);
    commit();
  }

  function reorderPendingTasks(ids: string[]): void {
    requireRoutine().reorderPendingTasks(ids);
    commit();
  }

  /**
   * 写回重算后的通勤路线（排序后每段通勤的出发地随新前驱变化）。
   * 与 `reorderPendingTasks` 配套：先改顺序，再改该顺序对应的路线。
   */
  function applyCommuteRoutes(
    updates: ReadonlyArray<{ progressID: string; commute: CommuteRoute; duration?: number }>,
  ): void {
    requireRoutine().applyCommuteRoutes(updates);
    commit();
  }

  function deleteFromCurrentSession(progress: StepProgress): void {
    requireRoutine().deleteFromCurrentSession(progress);
    commit();
  }

  function cancel(): void {
    requireRoutine().cancel();
    commit();
  }

  function finish(): void {
    requireRoutine().finish();
    commit();
  }

  function applyIncoming(incoming: RoutineSnapshot): boolean {
    const adopted = requireRoutine().applyIncomingSnapshot(incoming);
    if (adopted) {
      commit();
    }
    return adopted;
  }

  return {
    // state
    snapshot,
    ready,
    parsing,
    lastParse,
    notice,
    pendingTemplate,
    settings,
    // getters
    session,
    currentProgress,
    nextProgress,
    templates,
    // actions
    init,
    ensureReady,
    dispose,
    saveSettings,
    parse,
    parsePlan,
    createTemplate,
    addTemplate,
    replaceTemplate,
    deleteTemplate,
    selectTemplate,
    start,
    startProgress,
    startParallelProgress,
    complete,
    snoozeCurrent,
    addTemporaryTask,
    reorderPendingTasks,
    applyCommuteRoutes,
    deleteFromCurrentSession,
    cancel,
    finish,
    applyIncoming,
  };
});
