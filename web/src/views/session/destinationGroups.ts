/**
 * views/session/destinationGroups.ts — 目的地分组 + 通勤重算 + 草稿排程（纯函数）。
 *
 * 背景：任务线里「去某地做事」由两步组成 —— 一段「通勤到X」加该地的活动项
 * （创建时由 `QuickCreateView` 生成，活动项标题为 `X · 原活动`）。二者天然是一个整体：
 * **先到达，再做事**。用户实际要调整的是「先去哪里做什么」，不是逐段通勤。
 *
 * 因此排序按「目的地组」为单位，并遵守两条不变量：
 *   1. 组内顺序恒为 [通勤, 活动…]，用户无法把活动项拖到通勤之前；
 *   2. 每段通勤的出发地由**前一个已完成的地点**推导，而非绑死创建时的原值 ——
 *      地点顺序一变，出发地与时长都要跟着重算。
 *
 * 组**内部**的先后可以调整（同一地点先做哪件事）—— 那不改变任何通勤的推导结果，
 * 因此只需换一下提交给 `reorderPendingTasks` 的顺序，不触发路线重算。
 *
 * 约束：本模块经 `stores/routine` 取类型与纯函数，**不**直接 import `core/` 或 `platform/`
 * （沿用 `helpers.ts` 的分层约定）。全文件无副作用，便于单测。
 */

import {
  isIncomplete,
  type CommuteRoute,
  type RoutineSession,
  type StepProgress,
  type TravelMode,
} from '../../stores/routine';

/** 通勤项判定：显式带路线，或标题是「通勤到X」（旧数据可能只留标题）。 */
export function isCommuteStep(step: StepProgress['step']): boolean {
  return step.commute !== undefined || step.title.startsWith('通勤到');
}

/** 「通勤到公司」→「公司」；非该前缀原样返回。 */
export function placeNameFromCommuteTitle(title: string): string {
  return title.startsWith('通勤到') ? title.slice(3) : title;
}

export interface DestinationGroupPlan {
  /** 稳定 key：优先通勤项 id，否则首个活动项 id（用于草稿顺序定位）。 */
  key: string;
  /** 组内通勤项；纯任务组为 null。 */
  commute: StepProgress | null;
  /** 组内活动项，恒在通勤之后。 */
  activities: StepProgress[];
  /** 显示名：活动首项标题（形如 `公司 · 上班`），无活动时回落通勤项标题。 */
  title: string;
  /** 目的地名，用于「从X出发」文案。 */
  placeName: string;
  /** 目的地坐标；null 表示该组不产生位置变化，不影响下一段出发地。 */
  placeLocation: string | null;
  /** 组内可重排项 id，恒按「通勤在前、活动在后」；组内先后可调，故这里也是那份顺序。 */
  moveIDs: string[];
  /** 组内含已开始/已完成项 → 该组顺序锁定，不参与拖动。 */
  fixed: boolean;
}

/**
 * 把扁平任务列表折叠成目的地组。
 *
 * `items` 需按界面顺序传入；`movableIDs` 是可重排项集合（与 core 口径一致，
 * 见 `helpers.reorderableItems`）。遇到通勤项即开新组，其后不带路线的任务挂进该组；
 * 开头（或两组之间）的散任务各自独立成组，等价于原来的单步移动。
 */
export function buildDestinationGroups(
  items: readonly StepProgress[],
  movableIDs: ReadonlySet<string>,
): DestinationGroupPlan[] {
  interface PartialGroup {
    key: string;
    commute: StepProgress | null;
    activities: StepProgress[];
  }

  const groups: DestinationGroupPlan[] = [];
  let current: PartialGroup | null = null;

  const close = (): void => {
    if (!current) return;
    groups.push(finalizeGroup(current, movableIDs));
    current = null;
  };

  for (const item of items) {
    if (item.step.role !== 'task') continue;
    if (isCommuteStep(item.step)) {
      close();
      current = { key: item.id, commute: item, activities: [] };
      continue;
    }
    if (current) current.activities.push(item);
    else current = { key: item.id, commute: null, activities: [item] };
  }
  close();
  return groups;
}

function finalizeGroup(
  partial: { key: string; commute: StepProgress | null; activities: StepProgress[] },
  movableIDs: ReadonlySet<string>,
): DestinationGroupPlan {
  const info = partial.commute?.step.commute;
  let placeName = info?.address ?? '';
  if (!placeName && partial.commute) {
    placeName = placeNameFromCommuteTitle(partial.commute.step.title);
  }
  if (!placeName) placeName = partial.activities[0]?.step.title ?? '未命名';

  const members = [...(partial.commute ? [partial.commute] : []), ...partial.activities];
  return {
    key: partial.key,
    commute: partial.commute,
    activities: partial.activities,
    title: partial.activities[0]?.step.title ?? partial.commute?.step.title ?? '未命名',
    placeName,
    placeLocation: info?.location ?? null,
    moveIDs: members.filter((item) => movableIDs.has(item.id)).map((item) => item.id),
    fixed: members.some((item) => !movableIDs.has(item.id)),
  };
}

export interface CommuteReplan {
  /** 通勤项的 progress id。 */
  stepID: string;
  /** 通勤项标题（「通勤到公司」）。 */
  title: string;
  /** 原出发地坐标。 */
  fromOrigin: string;
  /** 重排后应采用的出发地坐标。 */
  toOrigin: string;
  /** 新出发地的显示名（上一组的站名，起点时为「起点」），用于文案。 */
  toOriginName: string;
  /** 该段原时长（秒），用于「30 → 34 分钟」的对照。 */
  fromSeconds: number;
  /** 出发地是否真的变了；false 表示这段无需重算。 */
  changed: boolean;
  /** 目的地最小必要字段 —— 传了它 `queryCommute` 就会跳过选点、直接按坐标算路。 */
  destination: { id: string; name: string; address: string; location: string; citycode: string };
  mode: TravelMode;
}

/**
 * 按草稿顺序推导每段通勤的出发地。
 *
 * `startOrigin` 是整条线的起点（原第一段通勤的出发地坐标，家/公司等），
 * **不随排序改变** —— 起点是事实，不是可选项。此后每一段通勤的出发地
 * 都是上一组的目的地坐标，于是「家 → 早餐店 → 公司」把公司提前后，
 * 自动变成「家 → 公司 → 早餐店」，而不是把原路段整段搬过去。
 */
export function replanCommutes(
  groups: readonly DestinationGroupPlan[],
  startOrigin: string,
): CommuteReplan[] {
  const plans: CommuteReplan[] = [];
  let cursor = startOrigin;
  // 出发地的显示名：起点没有名字，用「起点」占位，人类可读即可。
  let cursorName = '起点';

  for (const group of groups) {
    const info = group.commute?.step.commute;
    if (!group.commute || !info) continue;
    plans.push({
      stepID: group.commute.id,
      title: group.commute.step.title,
      fromOrigin: info.origin,
      toOrigin: cursor,
      toOriginName: cursorName,
      fromSeconds: info.seconds,
      // 起点坐标缺失（未定位）时无法推导，保持原路段不动，避免写出半截路线。
      changed: cursor !== '' && info.origin !== cursor,
      destination: {
        id: '',
        name: info.address,
        address: info.address,
        location: info.location,
        citycode: '',
      },
      mode: info.mode,
    });
    // 换乘链：本组到达的位置成为下一段的出发地。
    cursor = info.location;
    cursorName = group.placeName;
  }
  return plans;
}

/**
 * 按草稿顺序重排 `progress` 的可重排槽位，并叠加重算后的通勤路线。
 *
 * 与 core `RoutineStore.reorderPendingTasks` 用**同一套槽位口径**：
 * 正序扫描，第 k 个可重排槽位放入 `orderedIDs` 第 k 项；`active` 项位置不动。
 * 产出的是**新对象**（原 session 与其中的 progress 项都不被改写），
 * 供 `estimatedDueDates` / `estimatedCompletion` 做「调整后」预览，
 * 不落库、不进状态机 —— 提交由 `reorderPendingTasks` + `applyCommuteRoutes` 完成。
 */
export function applyDraftOrder(
  session: RoutineSession,
  orderedIDs: readonly string[],
  routeByID: Readonly<Record<string, CommuteRoute>>,
): RoutineSession {
  const activeID = session.activeProgressID;
  const byID = new Map(session.progress.map((item) => [item.id, item]));
  let cursor = 0;

  const progress = session.progress.map((item) => {
    if (isIncomplete(item.state) && item.step.role === 'task' && item.id !== activeID) {
      const picked = byID.get(orderedIDs[cursor] ?? '') ?? item;
      cursor += 1;
      return withDraftRoute(picked, routeByID[picked.id]);
    }
    return withDraftRoute(item, routeByID[item.id]);
  });

  return { ...session, progress };
}

/**
 * 复制一项并叠加草稿路线。
 *
 * 只有 `pending` / `suspended` 项改时长 —— `active`（已在路上）与 `completed` 不追溯，
 * 口径与 core `applyCommuteRoutes` 一致；两处必须同步，否则预览与提交结果对不上。
 */
function withDraftRoute(item: StepProgress, route: CommuteRoute | undefined): StepProgress {
  const step = { ...item.step, ...(route ? { commute: { ...route } } : {}) };
  if (route && route.seconds > 0 && (item.state === 'pending' || item.state === 'suspended')) {
    step.duration = route.seconds;
  }
  return { ...item, step };
}

/** 整条线的起点：原顺序里第一段通勤的出发地坐标（无则空串）。 */
export function resolveStartOrigin(session: RoutineSession | null): string {
  const first = session?.progress.find(
    (item) => item.step.role === 'task' && item.step.commute !== undefined,
  );
  return first?.step.commute?.origin ?? '';
}
