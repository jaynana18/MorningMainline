/**
 * stores/routine.ts — 唯一 Pinia store（ARCHITECTURE §4b.2 冻结契约）。
 *
 * 设计：
 * - 内部持有 `core/store.ts` 的 `RoutineStore` 实例；**core 层不做响应式改造**，由 Pinia 包一层。
 * - 每次变更后收口到私有 `commit()`：`snapshot` 重新赋值 → `writeSnapshot()` → `replaceNotifications(session)`。
 *   视图层**不得**各自调用后两者。
 * - `parse()` 走 `core/pipeline.ts`；浏览器宿主经 `bridge.parseWithModel`，无能力时静默回退纯规则并把提示写入 `notice`。
 * - `createTemplate()` 复用 `core/parser.ts` 的 `makeTemplate`，实现 iOS 创建页的截止时间交互语义。
 *
 * 视图层禁止直接 import `core/` 或 `platform/`；本模块是唯一门面，并在此重导出视图需要的小工具。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  ParseResult,
  Recurrence,
  RoutineParsingService,
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
import { inferredDeadline, makeSteps, makeTemplate } from '../core/parser';
import { RoutineParsingPipeline } from '../core/pipeline';
import { isIncomplete } from '../core/session';
import { RoutineStore } from '../core/store';
import { createBridge, type PlatformBridge } from '../platform/bridge';

// 重导出：视图层经 store 取用（避免直接 import core）。
export { RECURRENCE_TITLES, RECURRENCES, PARSE_SOURCE_TITLES };
export { deadlineStep, effectiveRecurrence, totalTaskDuration } from '../core/session';
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
}

export const useRoutineStore = defineStore('routine', () => {
  const bridge: PlatformBridge = bridgeOverride ?? createBridge();
  const tz = DEFAULT_TIME_ZONE;

  // ---- state ----
  const snapshot = ref<RoutineSnapshot>(initialSnapshot());
  const ready = ref(false);
  const parsing = ref(false);
  const lastParse = ref<ParseResult | null>(null);
  const notice = ref<string | null>(null);

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
    routine = new RoutineStore({
      deviceRole: info.role,
      deviceID: info.id,
      tz,
      initialSnapshot: stored ?? initialSnapshot(),
    });
    snapshot.value = cloneSnapshot(routine.snapshot);

    await bridge.requestNotificationAuthorization();
    unsubscribeSnapshotChanged = bridge.onSnapshotChanged((incoming) => {
      applyIncoming(incoming);
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

  async function parse(input: string): Promise<ParseResult> {
    parsing.value = true;
    notice.value = null;
    try {
      const pipeline = new RoutineParsingPipeline({ tz });
      const modelAvailable = bridge.capabilities.modelParsing;
      if (modelAvailable) {
        const enhanced: RoutineParsingService = {
          source: 'enhanced',
          parse: (text) => bridge.parseWithModel(text),
        };
        pipeline.setEnhanced(enhanced);
      }

      const raw = await pipeline.parse(input, new Date());
      if (!raw) {
        lastParse.value = null;
        return makeParseResult({ steps: [], deadline: null, source: 'rule', leftover: input.trim() });
      }

      // 模型/规则没给出截止时间时，回落到本机 inferredDeadline（对齐 iOS `generate()`）。
      const deadline = raw.deadline ?? inferredDeadline(input, new Date(), tz);
      const enriched = makeParseResult({
        steps: raw.steps,
        deadline,
        source: raw.source,
        leftover: raw.leftover,
      });
      lastParse.value = enriched.hasSteps ? enriched : null;

      if (!modelAvailable) {
        notice.value = '当前环境未接入智能解析，已使用本机规则识别。';
      } else if (raw.source === 'rule') {
        notice.value = '智能解析未返回更完整的结果，已回退本机规则识别。';
      }
      return enriched;
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
  function createTemplate(input: string, opts: CreateTemplateOptions): RoutineTemplate {
    const now = new Date();
    const cached = lastParse.value;
    const steps = cached && cached.hasSteps ? cached.steps : makeSteps(input);
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

  function start(template: RoutineTemplate, opts?: StartOptions): void {
    requireRoutine().start(
      template,
      opts?.deadlineOverride ?? null,
      opts?.bufferOverride ?? null,
    );
    commit();
  }

  function startProgress(progress: StepProgress): void {
    requireRoutine().startProgress(progress);
    commit();
  }

  function complete(progress: StepProgress): void {
    requireRoutine().complete(progress);
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
    // getters
    session,
    currentProgress,
    nextProgress,
    templates,
    // actions
    init,
    ensureReady,
    dispose,
    parse,
    createTemplate,
    addTemplate,
    start,
    startProgress,
    complete,
    snoozeCurrent,
    addTemporaryTask,
    reorderPendingTasks,
    deleteFromCurrentSession,
    cancel,
    finish,
    applyIncoming,
  };
});
