<template>
  <section v-if="session" data-testid="timeline-card">
    <div class="mm-line-summary">
      <div class="mm-line-summary__top">
        <div>
          <span class="mm-badge">{{ session.templateName || '任务线' }}</span>
          <p class="mm-line-summary__label">最晚必须开始</p>
          <p class="mm-line-summary__start">{{ formatClock(session.plannedStartAt) }}</p>
        </div>
        <div class="mm-line-summary__side">
          <!--
            排序改为「主动进入」：平时列表只响应点击/滚动，避免整卡长按拖动误触排序。
            进入后由排序面板接管（按目的地组移动），点「完成」保存并退出。
          -->
          <button
            v-if="canSort || sortMode"
            class="mm-btn mm-btn--small mm-sort-toggle"
            :class="{ 'mm-btn--primary': sortMode }"
            :aria-pressed="sortMode"
            data-testid="sort-toggle"
            @click="onHeaderSortButton"
          >
            {{ sortMode ? '完成' : '调整顺序' }}
          </button>
          <div class="mm-line-summary__impact">
            <span>预计 {{ estimated ? formatClock(estimated) : '--:--' }}</span>
            <b>→</b>
            <span>目标 {{ session.targetDeadline ? formatClock(session.targetDeadline) : '--:--' }}</span>
            <em :class="deltaClass">{{ deltaText }}</em>
          </div>
        </div>
      </div>

      <div class="mm-line-stats">
        <span>完成 {{ completedCount }}/{{ taskItems.length }}</span>
        <span>计划 {{ formatMinutes(plannedSeconds) }}</span>
        <span :class="{ 'mm-text-danger': slackSeconds < 0 }">余量 {{ slackText }}</span>
      </div>

      <details class="mm-line-settings">
        <summary>提醒与进度设置</summary>
        <div class="mm-alert-modes">
          <button :class="{ active: alertMode === 'silent' }" @click="setAlertMode('silent')">
            <b>静默推进</b><small>到点进入下一项，上一项留待确认</small>
          </button>
          <button :class="{ active: alertMode === 'strict' }" @click="setAlertMode('strict')">
            <b>强提醒</b><small>不自动完成，超时持续提示</small>
          </button>
        </div>
      </details>
    </div>

    <div class="mm-line-status" :class="statusClass">
      <i></i><span>{{ statusText }}</span>
    </div>

    <!--
      排序面板：替换时间线（而不是叠在上面），因为拖动单位变成「目的地组」，
      组内要展示「🚗 通勤 → 📍 做事」的固定次序，列表形态才表达得清楚。
    -->
    <div v-if="sortMode" class="mm-sortboard" :class="{ 'mm-sortboard--busy': committing }" data-testid="sortboard">
      <p class="mm-sort-hint" data-testid="sort-hint">
        ≡ 都在每行最右侧：组头那一行的 ≡ 拖整个目的地组，活动行的 ≡ 调本组内先后。通勤段会按上一站自动重算。
      </p>

      <ul
        ref="sortBoardElement"
        class="mm-sort-groups"
        @pointermove="onSortPointerMove"
        @pointerup="onSortPointerUp"
        @pointercancel="clearDragState"
      >
        <li
          v-for="(group, index) in draftGroups"
          :key="group.key"
          class="mm-sort-group"
          :class="{
            'mm-sort-group--dragging': dragState?.kind === 'group' && dragState.key === group.key,
            'mm-sort-group--active': dragState?.kind === 'activity' && dragState.groupKey === group.key,
            'mm-sort-group--fixed': group.fixed,
          }"
          :data-group-key="group.key"
          :data-group-index="index"
        >
          <div class="mm-sort-group__head">
            <b class="mm-sort-group__title">{{ group.title }}</b>
            <span class="mm-sort-group__tools">
              <button
                v-if="hasParallel(group)"
                class="mm-btn mm-btn--small mm-sort-unmerge"
                :disabled="committing"
                aria-label="解除组内并行"
                @click="splitGroupOf(group)"
              >拆并行</button>
              <button
                class="mm-iconbtn"
                :disabled="group.fixed || index === 0 || committing"
                aria-label="上移一组"
                :data-testid="`sort-up-${group.key}`"
                @click="moveGroup(index, -1)"
              >
                <SessionIcon name="chevron-up" :size="12" />
              </button>
              <button
                class="mm-iconbtn"
                :disabled="group.fixed || index === draftGroups.length - 1 || committing"
                aria-label="下移一组"
                :data-testid="`sort-down-${group.key}`"
                @click="moveGroup(index, 1)"
              >
                <SessionIcon name="chevron-down" :size="12" />
              </button>
              <!--
                组手柄放组头行最右：与下方活动行的行手柄**右对齐成一列**。
                两者靠尺寸（28 / 22）与样式（虚线框 / 无框淡色）区分 —— 粗重即大单位。
              -->
              <span
                v-if="!group.fixed"
                class="mm-sort-grip"
                role="button"
                tabindex="0"
                aria-label="按住拖动，调整这一整组的位置"
                title="拖整组"
                :data-testid="`sort-grip-${group.key}`"
                @pointerdown.stop="onGroupGripDown($event, group)"
              >≡</span>
              <span v-else class="mm-sort-lock" title="组内已有开始或完成的任务，顺序锁定">🔒</span>
            </span>
          </div>

          <ul class="mm-sort-group__body">
            <li v-if="group.commute" class="mm-sort-row mm-sort-row--commute">
              <span class="mm-sort-row__icon">🚗</span>
              <span class="mm-sort-row__text">{{ group.commute.step.title }}</span>
              <span class="mm-sort-row__time">{{ commuteTimeText(group) }}</span>
            </li>
            <!--
              同一地点内的事情可以互换先后。行手柄与组手柄同在最右、右对齐成一列
              （沿用 iOS `List.onMove` 把位移手柄放行尾的惯例），靠尺寸与样式区分层级。
            -->
            <li
              v-for="item in group.activities"
              :key="item.id"
              class="mm-sort-row"
              :class="{ 'mm-sort-row--dragging': dragState?.kind === 'activity' && dragState.id === item.id }"
              :data-activity-id="item.id"
            >
              <span class="mm-sort-row__icon">📍</span>
              <span class="mm-sort-row__text">{{ item.step.title }}</span>
              <span class="mm-sort-row__time">{{ draftRange(item) }}</span>
              <span
                v-if="group.activities.length > 1 && movableIDs.has(item.id)"
                class="mm-sort-grip mm-sort-grip--row"
                role="button"
                tabindex="0"
                aria-label="按住拖动，调整这个地点内事情的先后"
                title="调组内先后"
                :data-testid="`sort-grip-row-${item.id}`"
                @pointerdown.stop="onActivityGripDown($event, group, item)"
              >≡</span>
            </li>
          </ul>

          <!-- 该组通勤的出发地发生了变化：明说是从哪改到哪，不静默替换 -->
          <p v-if="replanOf(group)" class="mm-sort-replan" :data-testid="`replan-${group.key}`">
            {{ replanText(replanOf(group)) }}
          </p>
        </li>
      </ul>

      <div v-if="draftImpact" class="mm-sort-impact" :class="`mm-sort-impact--${draftImpact.tone}`" data-testid="sort-impact">
        {{ draftImpact.text }}
      </div>
      <p v-if="replanBusy" class="mm-sort-note">正在按新出发地重算路段…</p>
      <p v-else-if="replanError" class="mm-sort-note mm-sort-note--warn">{{ replanError }}</p>
      <p v-else-if="replanNotice" class="mm-sort-note">{{ replanNotice }}</p>

      <div class="mm-actions mm-actions--end">
        <button class="mm-btn mm-btn--secondary" :disabled="committing" @click="cancelSort">放弃调整</button>
        <button class="mm-btn mm-btn--primary" :disabled="committing" data-testid="sort-commit" @click="commitDraft">
          {{ committing ? '正在保存…' : '完成' }}
        </button>
      </div>
    </div>

    <div
      v-else
      ref="tasklineElement"
      class="mm-taskline mm-capsule-timeline"
    >
      <div class="mm-capsule-now">现在 {{ formatClockWithSeconds(effectiveNow) }}</div>

      <template v-for="(group, groupIndex) in groups" :key="group.key">
        <div
          class="mm-task-band"
          :class="{ 'mm-task-band--parallel': group.items.length > 1 }"
        >
          <div v-for="item in group.items" :key="item.id" class="mm-task-lane">
            <article
              class="mm-task-block"
              :class="blockClasses(item)"
              :style="{ height: `${itemHeight(item)}px`, '--capsule-color': capsuleColor(item) }"
              :data-testid="`timeline-row-${item.id}`"
              @click="selectedID = selectedID === item.id ? null : item.id"
            >
              <div class="mm-time-capsule" role="progressbar" :aria-label="`${item.step.title}时间进度`" :aria-valuenow="Math.round(capsuleProgress(item))" aria-valuemin="0" aria-valuemax="100">
                <div class="mm-time-capsule__fill" :style="{ height: `${capsuleProgress(item)}%` }"></div>
                <SessionIcon :name="item.state === 'completed' ? 'check' : 'clock'" :size="24" />
              </div>
              <div class="mm-task-block__body">
                <div class="mm-capsule-time">{{ formatClock(item.startedAt ?? groupStart(groupIndex)) }} – {{ formatClock(itemEnd(item)) }} · {{ formatMinutes(item.step.duration) }}</div>
                <div class="mm-task-name-row">
                  <div class="mm-task-block__title">
                    {{ item.step.title }}
                    <small>{{ Math.round(item.step.duration / 60) }}′</small>
                  </div>
                  <div v-if="routeForItem(item)" @pointerdown.stop @click.stop>
                    <CommuteMap :route="routeForItem(item)!" compact />
                  </div>
                </div>
                <p v-if="selectedID === item.id">{{ item.step.prompt }}</p>
              </div>
              <span v-if="item.state === 'active'" class="mm-live-pill" :class="urgencyClass(item)">
                {{ overdueText(item) }}
              </span>
              <button
                v-else-if="isPendingConfirmation(item)"
                class="mm-confirm-chip"
                @click.stop="confirmCompletion(item.id)"
              >确认完成</button>
              <button
                v-else-if="canStart(item)"
                class="mm-task-start"
                @click.stop="startGroup(group.items)"
              >开始</button>
              <button class="mm-task-check" :aria-label="`${item.step.title}：${isPendingConfirmation(item) ? '确认完成' : item.state === 'completed' ? '取消完成' : '标记完成'}`" @click.stop="toggleDone(item)">
                {{ isPendingConfirmation(item) ? '?' : item.state === 'completed' ? '✓' : '' }}
              </button>
            </article>
            <div
              v-if="group.items.length > 1 && waitHeight(item, group.items) > 12"
              class="mm-task-wait"
              :style="{ height: `${waitHeight(item, group.items)}px` }"
            >
              等 {{ Math.round(waitHeight(item, group.items) / pixelsPerMinute) }}′
            </div>
          </div>
          <button
            v-if="group.items.length > 1 && group.items.every(canArrange)"
            class="mm-parallel-split"
            aria-label="拆开并行任务"
            @click="splitGroup(group.items)"
          >×</button>
        </div>
      </template>

      <div v-if="session.remainingBuffer > 0" class="mm-buffer-band" :style="bufferStyle">
        ▣ 固定安全垫 {{ Math.round(session.remainingBuffer / 60) }}′ · {{ bufferEndText }}
      </div>

      <template v-if="deadlineItem">
        <div class="mm-deadline-band" :class="{ missed: slackSeconds < 0 }">
          <span>⚑</span><b>{{ deadlineItem.step.title }}</b>
          <em>{{ formatClock(estimatedDue(deadlineItem)) }}</em>
        </div>
      </template>
    </div>

    <!-- 调整已保存：顺序与路线都已写入，给一次后悔的机会 -->
    <div v-if="undoSnapshot && !sortMode" class="mm-undo-bar" data-testid="undo-bar">
      <span>已保存调整</span>
      <button class="mm-link-btn" data-testid="undo-button" @click="undoLastReorder">撤销</button>
    </div>

    <div class="mm-current-dock">
      <div>
        <b>{{ dockTitle }}</b><small>{{ dockSubtitle }}</small>
      </div>
      <div class="mm-current-dock__actions">
        <button v-if="current" class="mm-btn mm-btn--primary" @click="completeItem(current)">完成</button>
        <button v-else-if="firstOpenGroup.length" class="mm-btn mm-btn--primary" @click="startGroup(firstOpenGroup)">
          提前开始
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  estimatedCompletion,
  estimatedDueDates,
  formatMinutes,
  isIncomplete,
  queryCommute,
  useRoutineStore,
  type CommuteRoute,
  type StepProgress,
} from '../../stores/routine';
import { formatClock, reorderableItems } from './helpers';
import {
  buildDestinationGroups,
  replanCommutes,
  resolveStartOrigin,
  applyDraftOrder,
  type CommuteReplan,
  type DestinationGroupPlan,
} from './destinationGroups';
import SessionIcon from './SessionIcon.vue';
import CommuteMap from '../CommuteMap.vue';

const props = defineProps<{ now: Date; focusedProgressId?: string | null }>();
const store = useRoutineStore();
const session = computed(() => store.session);
const current = computed(() => store.currentProgress);
const selectedID = ref<string | null>(null);
const parallelIDs = ref<Set<string>>(new Set());
const pendingConfirmationIDs = ref<Set<string>>(new Set());
const timelineOrderIDs = ref<string[]>([]);
const frozenHeights = ref<Record<string, number>>({});
const alertMode = ref<'silent' | 'strict'>('strict');
const pixelsPerMinute = 4;
const tasklineElement = ref<HTMLElement | null>(null);
/**
 * 「现在」= 真实系统时间（2026-10-14 用户裁决：去掉模拟时间）。
 *
 * 原先这里是 `simulatedNow`（可拨盘 / 播放 / 1×10×60× 倍速的模拟时钟），
 * 所有排程计算都经 `effectiveNow` 读它 —— 一旦用户拨过时间没拨回来，
 * 界面上的一切（倒计时、超时、预计完成）都在一个**不存在的现在**上演算，
 * 而超时提醒引擎（`stores/reminders.ts` 的 `tick`）走的是真实时钟，
 * 两边会给出互相矛盾的结论。模拟时钟是原型阶段的调试工具，不该出现在真实产品里。
 *
 * 这里直接用 `props.now`（`SessionView` 的 `useNow()`，每秒一个真实时间戳）。
 */
const effectiveNow = computed(() => props.now);

// ---- 排序模式（主动进入） ----
const sortMode = ref(false);
const sortBoardElement = ref<HTMLElement | null>(null);
/** 草稿的「目的地组」顺序；只在本地，未点「完成」前不动 core。 */
const draftKeys = ref<string[]>([]);
/**
 * 组内活动的草稿顺序：组 key → 活动 progress id 列表。
 *
 * 组内顺序**不需要**重算通勤 —— 组的出发地与目的地都没变，`replanCommutes` 会判定
 * `changed = false`，所以调组内先后是纯本地、零请求的操作。
 */
const draftActivityOrder = ref<Record<string, string[]>>({});
/** 当前正在拖的东西：整组，还是组内某一项。 */
const dragState = ref<
  | { kind: 'group'; key: string }
  | { kind: 'activity'; groupKey: string; id: string }
  | null
>(null);
const committing = ref(false);
/** 重算后的通勤路线：stepID → { 该结果对应的出发地, 路线 }。 */
const recomputedRoutes = ref<Record<string, { origin: string; route: CommuteRoute }>>({});
const replanBusy = ref(false);
const replanError = ref('');
const replanNotice = ref('');
/** 已保存的调整，供「撤销」回滚顺序、路线与时长。 */
const undoSnapshot = ref<{
  order: string[];
  routes: Array<{ progressID: string; commute: CommuteRoute; duration: number }>;
} | null>(null);
/** 保存那一刻的可重排顺序签名：用来区分「刚保存」与「之后任务线又被改动」。 */
const undoSignature = ref('');
const amapKey = ref((import.meta.env.VITE_AMAP_WEB_SERVICE_KEY as string | undefined) ?? '');

const rawTaskItems = computed(() => session.value?.progress.filter((item) => item.step.role === 'task') ?? []);
function routeForItem(item: StepProgress) {
  if (item.step.commute) return item.step.commute;
  const template = store.templates.find(template => template.id === session.value?.templateID);
  const storedRoute = template?.steps.find(step => step.id === item.step.id)?.commute;
  if (storedRoute) return storedRoute;
  // 旧版本仅保留末段路线，只能绑定到对应通勤项，不能给其他路段冒用。
  if (template?.commute && item.step.title === `通勤到${template.commute.address}`) return template.commute;
  return undefined;
}
const taskItems = computed(() => {
  const byID = new Map(rawTaskItems.value.map((item) => [item.id, item]));
  const ordered = timelineOrderIDs.value
    .map((id) => byID.get(id))
    .filter((item): item is StepProgress => item !== undefined);
  const known = new Set(ordered.map((item) => item.id));
  return [...ordered, ...rawTaskItems.value.filter((item) => !known.has(item.id))];
});
/**
 * 可重排项（口径与 core `reorderPendingTasks` 完全一致）按**界面显示顺序**排列。
 *
 * 顺序双轨：core 用 `progress` 数组序，视图用 `timelineOrderIDs`；重排必须两边同步，
 * 而 `reorderPendingTasks` 要求传入集合与可重排集合**完全相等**，否则整体 no-op。
 * 故这里以 core 集合为准、按视图顺序排列，末尾兜底补齐（防本地展示态损坏时丢项）。
 */
const sortableIDs = computed<string[]>(() => {
  if (!session.value) return [];
  const allowed = new Set(reorderableItems(session.value).map((item) => item.id));
  const ordered = taskItems.value.map((item) => item.id).filter((id) => allowed.has(id));
  for (const id of allowed) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
});
const canSort = computed(() => sortableIDs.value.length > 1);

// ---- 目的地分组与草稿排程（排序面板的数据源） ----
const movableIDs = computed<Set<string>>(
  () => new Set(session.value ? reorderableItems(session.value).map((item) => item.id) : []),
);
const liveGroups = computed(() => buildDestinationGroups(taskItems.value, movableIDs.value));
const draftGroups = computed<DestinationGroupPlan[]>(() => {
  const byKey = new Map(liveGroups.value.map((group) => [group.key, group]));
  const ordered = draftKeys.value
    .map((key) => byKey.get(key))
    .filter((group): group is DestinationGroupPlan => group !== undefined);
  const known = new Set(ordered.map((group) => group.key));
  return [...ordered, ...liveGroups.value.filter((group) => !known.has(group.key))]
    .map(applyDraftActivityOrder);
});

/**
 * 叠加组内活动顺序，并**重算 moveIDs**。
 *
 * 这一步是组内重排能零成本落地的关键：`moveIDs` 恒为 `[通勤, 活动…]` 拼接，
 * 所以只要 activities 数组换了顺序，`draftMoveIDs` 就自动反映出来，
 * 提交时 `reorderPendingTasks` 收到的新顺序即正确；core 一行不用改。
 */
function applyDraftActivityOrder(group: DestinationGroupPlan): DestinationGroupPlan {
  const order = draftActivityOrder.value[group.key];
  if (!order || group.activities.length < 2) return group;
  const byID = new Map(group.activities.map((item) => [item.id, item]));
  const activities = order
    .map((id) => byID.get(id))
    .filter((item): item is StepProgress => item !== undefined);
  for (const item of group.activities) {
    if (!activities.includes(item)) activities.push(item);
  }
  const members = [...(group.commute ? [group.commute] : []), ...activities];
  return {
    ...group,
    activities,
    moveIDs: members.filter((item) => movableIDs.value.has(item.id)).map((item) => item.id),
  };
}
/** 提交给 core 的顺序：与 `reorderableItems` 集合严格相等，否则 core 会整体拒绝。 */
const draftMoveIDs = computed<string[]>(() => {
  const ids = draftGroups.value.flatMap((group) => group.moveIDs);
  for (const id of movableIDs.value) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
});
const startOrigin = computed(() => resolveStartOrigin(session.value));
const replans = computed(() => replanCommutes(draftGroups.value, startOrigin.value));
const changedReplans = computed(() => replans.value.filter((plan) => plan.changed));
const replanByStepID = computed(() => new Map(replans.value.map((plan) => [plan.stepID, plan])));
/** 只采纳「出发地与当前推导一致」的结果，防拖动后串用上一轮的重算。 */
const draftRouteByID = computed<Record<string, CommuteRoute>>(() => {
  const result: Record<string, CommuteRoute> = {};
  for (const plan of changedReplans.value) {
    const entry = recomputedRoutes.value[plan.stepID];
    if (entry && entry.origin === plan.toOrigin) result[plan.stepID] = entry.route;
  }
  return result;
});
/**
 * 草稿顺序 + 重算路线的预览会话：纯派生，不落库。
 *
 * 只在排序模式里构造副本 —— 平时直接返回原 session。`effectiveNow` 每秒变一次，
 * 无事发生也给整条 progress 做一次深一层拷贝是白烧的。
 */
const draftSession = computed(() => {
  const active = session.value;
  if (!active || !sortMode.value) return active;
  return applyDraftOrder(active, draftMoveIDs.value, draftRouteByID.value);
});
const draftEstimates = computed<Map<string, Date>>(
  () =>
    sortMode.value && draftSession.value
      ? estimatedDueDates(draftSession.value, effectiveNow.value)
      : new Map<string, Date>(),
);
const draftCompletion = computed(() => {
  const draft = draftSession.value;
  if (!draft || !sortMode.value) return null;
  const base = estimatedCompletion(draft, effectiveNow.value);
  // 固定安全垫不随任务被吞掉，口径与卡头「预计」一致。
  return base ? new Date(base.getTime() + draft.remainingBuffer * 1000) : null;
});
const draftImpact = computed<{ tone: 'ok' | 'late' | 'early' | 'neutral'; text: string } | null>(() => {
  const active = session.value;
  const finish = draftCompletion.value;
  if (!active || !finish) return null;
  const target = active.targetDeadline;
  if (!target) return { tone: 'neutral', text: `调整后预计 ${formatClock(finish)} 完成` };
  const delta = (finish.getTime() - target.getTime()) / 1000;
  const label = deadlineItem.value?.step.title ?? '截止';
  const head = `调整后预计 ${formatClock(finish)} ${label}`;
  if (Math.abs(delta) < 30) return { tone: 'ok', text: `${head}，与设定的 ${formatClock(target)} 基本持平` };
  return delta > 0
    ? { tone: 'late', text: `${head}，晚于设定的 ${formatClock(target)}` }
    : { tone: 'early', text: `${head}，早于设定的 ${formatClock(target)}，提前 ${formatMinutes(-delta)}` };
});

const deadlineItem = computed(() => session.value?.progress.find((item) => item.step.role === 'deadline'));
const estimates = computed(() => session.value ? estimatedDueDates(session.value, effectiveNow.value) : new Map<string, Date>());
const estimated = computed(() => {
  if (!session.value) return null;
  const base = estimatedCompletion(session.value, effectiveNow.value);
  if (!base) return null;
  // 固定安全垫始终保留在任务之后，不因延误而被吞掉。
  return new Date(base.getTime() + session.value.remainingBuffer * 1000);
});
const completedCount = computed(() => taskItems.value.filter((item) => item.state === 'completed').length);
const plannedSeconds = computed(() => taskItems.value.reduce((sum, item) => sum + item.step.duration, 0));
const slackSeconds = computed(() => {
  if (!session.value?.targetDeadline || !estimated.value) return 0;
  return (session.value.targetDeadline.getTime() - estimated.value.getTime()) / 1000;
});
const slackText = computed(() => slackSeconds.value < 0
  ? `差 ${formatMinutes(-slackSeconds.value)}`
  : formatMinutes(slackSeconds.value));
const deltaText = computed(() => {
  if (!session.value?.targetDeadline || !estimated.value) return '进行中';
  const seconds = (estimated.value.getTime() - session.value.targetDeadline.getTime()) / 1000;
  if (Math.abs(seconds) < 30) return '准点';
  return seconds > 0 ? `晚 ${formatMinutes(seconds)}` : `早 ${formatMinutes(-seconds)}`;
});
const deltaClass = computed(() => slackSeconds.value < 0 ? 'late' : 'good');
const statusClass = computed(() => slackSeconds.value < 0 ? 'bad' : current.value ? 'live' : 'ok');
const statusText = computed(() => {
  if (slackSeconds.value < 0) return `当前计划还差 ${formatMinutes(-slackSeconds.value)}，可以砍步骤、压时间或改期`;
  if (current.value) return `正在进行 ${current.value.step.title}`;
  return `还可以自由安排 ${formatMinutes(Math.max(0, (session.value?.plannedStartAt.getTime() ?? 0) - effectiveNow.value.getTime()) / 1000)}`;
});

const groups = computed(() => {
  const result: Array<{ key: string; items: StepProgress[] }> = [];
  for (const item of taskItems.value) {
    const previous = result.at(-1);
    if (parallelIDs.value.has(item.id) && previous && previous.items.length === 1) previous.items.push(item);
    else result.push({ key: item.id, items: [item] });
  }
  return result;
});
const firstOpenGroup = computed(() => groups.value.find((group) => group.items.some((item) => isIncomplete(item.state)))?.items ?? []);
const dockTitle = computed(() => current.value?.step.title ?? (firstOpenGroup.value[0] ? `准备开始 · ${firstOpenGroup.value[0].step.title}` : '任务线已完成'));
const dockSubtitle = computed(() => current.value?.startedAt
  ? `已进行 ${formatMinutes((effectiveNow.value.getTime() - current.value.startedAt.getTime()) / 1000, true)}`
  : `最晚 ${session.value ? formatClock(session.value.plannedStartAt) : '--:--'}`);
const bufferEndText = computed(() => deadlineItem.value ? formatClock(estimatedDue(deadlineItem.value)) : '');
const bufferStyle = computed(() => ({ height: `${Math.max(34, Math.min(72, (session.value?.remainingBuffer ?? 0) / 60 * 2.4))}px` }));
const globalNowLineTop = computed(() => {
  // 原型语义：红线属于整条时间轴，即使尚未开始任务也停留在时间轴起点。
  const active = current.value;
  const container = tasklineElement.value;
  if (!active || !container || typeof document === 'undefined') return 0;
  const block = container.querySelector<HTMLElement>(`[data-testid="timeline-row-${active.id}"]`);
  if (!block) return 0;
  const containerRect = container.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  return Math.max(0, blockRect.top - containerRect.top + nowLineTop(active));
});

onMounted(loadLocalState);
watch(() => session.value?.id, loadLocalState);
watch(
  () => rawTaskItems.value.map((item) => item.id).join(','),
  () => {
    const known = new Set(timelineOrderIDs.value);
    const added = rawTaskItems.value.map((item) => item.id).filter((id) => !known.has(id));
    if (added.length === 0) return;
    timelineOrderIDs.value = [...timelineOrderIDs.value, ...added];
    saveLocalState();
  },
);
// 任务线本身被改动（新增/删除/完成）后，旧的撤销快照已失去意义。
// 用签名而非「有没有变化」判断：提交动作自己也会改顺序，不能把自己判成失效。
watch(() => sortableIDs.value.join(','), (next) => {
  if (undoSnapshot.value && next !== undoSignature.value) undoSnapshot.value = null;
});
watch(() => props.focusedProgressId, (id) => {
  if (!id || typeof document === 'undefined') return;
  // 🔴 **展开该任务的详情**（2026-10-15 用户要求「点通知应自动进入该任务详情界面」）。
  // `selectedID` 就是详情面板的唯一开关 —— 模板里 `v-if="selectedID === item.id"`
  // 控制着 `step.prompt`（任务说明）。原来只做高亮 + 滚动，用户点到通知后看到的是
  // 一条被圈出来的标题，仍然得自己再点一下才能看到「这件事要做什么」。
  //
  // 刻意**不**跟随 4 秒高亮一起收回：用户是带着「看这件事」的意图点进来的，
  // 读到一半自动折叠只会让人再点一次。要收起就点这张卡（再点一次即折叠）或点别的卡。
  selectedID.value = id;
  void nextTick(() => document.querySelector(`[data-testid="timeline-row-${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}, { immediate: true });
// 静默推进：到点自动完成上一项、切到下一项（只在可见的静默模式下生效）。
// 时钟是真实的 `props.now`，因此这个判断每秒一次、与用户看到的一致。
watch(() => effectiveNow.value.getTime(), () => {
  if (alertMode.value !== 'silent' || !current.value || !session.value) return;
  if (effectiveNow.value.getTime() < current.value.dueAt.getTime()) return;
  const laterTaskExists = session.value.progress.some((item) => item.id !== current.value?.id && item.step.role === 'task' && isIncomplete(item.state));
  if (!laterTaskExists) return;
  pendingConfirmationIDs.value = new Set([...pendingConfirmationIDs.value, current.value.id]);
  completeItem(current.value);
});
// 草稿顺序一变，上一轮的重算结果就作废（出发地已不同），清空后重查。
watch(() => draftKeys.value.join(','), () => {
  recomputedRoutes.value = {};
  replanError.value = '';
  replanNotice.value = '';
  // 上一轮可能在飞（或不匹配的 token 让它提前返回）：忙碌态必须一起复位，否则永久卡住。
  replanBusy.value = false;
  if (sortMode.value) void scheduleReplans();
});

onUnmounted(() => {
  replanToken += 1;
  if (replanTimer !== null) {
    clearTimeout(replanTimer);
    replanTimer = null;
  }
});

function loadLocalState(): void {
  const id = session.value?.id;
  if (!id || typeof localStorage === 'undefined') return;
  try {
    parallelIDs.value = new Set(JSON.parse(localStorage.getItem(`mm-parallel-${id}`) ?? '[]') as string[]);
    pendingConfirmationIDs.value = new Set(JSON.parse(localStorage.getItem(`mm-confirm-${id}`) ?? '[]') as string[]);
    timelineOrderIDs.value = JSON.parse(localStorage.getItem(`mm-order-${id}`) ?? '[]') as string[];
    frozenHeights.value = JSON.parse(localStorage.getItem(`mm-heights-${id}`) ?? '{}') as Record<string, number>;
    alertMode.value = localStorage.getItem(`mm-alert-${id}`) === 'silent' ? 'silent' : 'strict';
    if (timelineOrderIDs.value.length === 0) {
      timelineOrderIDs.value = rawTaskItems.value.map((item) => item.id);
      saveLocalState();
    }
  } catch { /* 旧的本地展示状态损坏时直接回落。 */ }
}
function saveLocalState(): void {
  const id = session.value?.id;
  if (!id || typeof localStorage === 'undefined') return;
  localStorage.setItem(`mm-parallel-${id}`, JSON.stringify([...parallelIDs.value]));
  localStorage.setItem(`mm-confirm-${id}`, JSON.stringify([...pendingConfirmationIDs.value]));
  localStorage.setItem(`mm-order-${id}`, JSON.stringify(timelineOrderIDs.value));
  localStorage.setItem(`mm-heights-${id}`, JSON.stringify(frozenHeights.value));
  localStorage.setItem(`mm-alert-${id}`, alertMode.value);
}
function setAlertMode(mode: 'silent' | 'strict'): void { alertMode.value = mode; saveLocalState(); }
function formatClockWithSeconds(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
function estimatedDue(item: StepProgress): Date {
  if (item.step.role === 'deadline' && estimated.value) return estimated.value;
  return estimates.value.get(item.id) ?? item.dueAt;
}
function itemEnd(item: StepProgress): Date {
  if (item.state === 'completed' && item.completedAt) return item.completedAt;
  return estimatedDue(item);
}
function groupEnd(items: StepProgress[]): Date { return new Date(Math.max(...items.map((item) => itemEnd(item).getTime()))); }
function groupStart(index: number): Date {
  const group = groups.value[index];
  const started = group?.items.map((item) => item.startedAt).filter((date): date is Date => date !== null);
  if (started?.length) return new Date(Math.min(...started.map((date) => date.getTime())));
  if (index > 0) return groupEnd(groups.value[index - 1].items);
  const end = group ? groupEnd(group.items) : session.value?.plannedStartAt ?? effectiveNow.value;
  const duration = group ? Math.max(...group.items.map((item) => item.step.duration)) : 0;
  return session.value?.plannedStartAt ?? new Date(end.getTime() - duration * 1000);
}
function elapsedSeconds(item: StepProgress): number { return item.startedAt ? Math.max(0, (effectiveNow.value.getTime() - item.startedAt.getTime()) / 1000) : 0; }
function capsuleProgress(item: StepProgress): number {
  if (item.state === 'completed' || isPendingConfirmation(item)) return 100;
  if (item.state === 'skipped' || !item.startedAt) return 0;
  return Math.max(0, Math.min(100, elapsedSeconds(item) / Math.max(1, item.step.duration) * 100));
}
function capsuleColor(item: StepProgress): string {
  if (item.state === 'active' && overdueSeconds(item) > 0) {
    return { low: '#dfa25c', mid: '#e47872', high: '#b43843' }[urgencyClass(item)] ?? '#b43843';
  }
  return ['#548bd4', '#69a28e', '#9a8bbe', '#bb9583'][Math.max(0, taskItems.value.findIndex(task => task.id === item.id)) % 4];
}
function overdueSeconds(item: StepProgress): number { return Math.max(0, elapsedSeconds(item) - item.step.duration); }
function itemHeight(item: StepProgress): number {
  const frozen = frozenHeights.value[item.id];
  if (frozen !== undefined) return frozen;
  const plannedMinutes = item.step.duration / 60;
  const visualMinutes = item.state === 'active' ? Math.max(plannedMinutes, Math.min(plannedMinutes + 5, elapsedSeconds(item) / 60)) : plannedMinutes;
  return Math.max(44, Math.min(150, visualMinutes * pixelsPerMinute));
}
function nowLineTop(item: StepProgress): number {
  const height = itemHeight(item);
  const plannedSeconds = Math.max(1, item.step.duration);
  const elapsed = elapsedSeconds(item);
  if (elapsed <= plannedSeconds) {
    return Math.max(1, Math.min(height - 1, height * elapsed / plannedSeconds));
  }
  // 超时阶段底边跟随红线一起增长；达到视觉高度上限后红线停在底边。
  return height - 1;
}
function waitHeight(item: StepProgress, items: StepProgress[]): number { return Math.max(...items.map(itemHeight)) - itemHeight(item); }
function urgencyClass(item: StepProgress): string {
  const minutes = overdueSeconds(item) / 60;
  if (minutes <= 0) return '';
  if (minutes < 2) return 'low';
  if (minutes < 5) return 'mid';
  return 'high';
}
function overdueText(item: StepProgress): string {
  const seconds = overdueSeconds(item);
  if (seconds <= 0) return '进行中';
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return minutes >= 5 ? `严重超时 ${minutes}′` : minutes >= 2 ? `已超 ${minutes}′` : `刚超时 ${minutes}′`;
}
function isPendingConfirmation(item: StepProgress): boolean { return pendingConfirmationIDs.value.has(item.id); }
function blockClasses(item: StepProgress): Record<string, boolean> {
  return {
    active: item.state === 'active', completed: item.state === 'completed' && !isPendingConfirmation(item),
    unconfirmed: isPendingConfirmation(item), focused: item.id === props.focusedProgressId,
    overdue: overdueSeconds(item) > 0, [`urgency-${urgencyClass(item)}`]: overdueSeconds(item) > 0,
  };
}
function canStart(item: StepProgress): boolean { return item.state === 'pending' || item.state === 'suspended'; }
function canArrange(item: StepProgress): boolean { return item.state === 'pending' || item.state === 'suspended'; }
function startGroup(items: StepProgress[]): void {
  const open = items.filter(canStart);
  if (open.length === 0) return;
  const moving = new Set(open.map((item) => item.id));
  const currentOrder = taskItems.value.map((item) => item.id);
  const remaining = currentOrder.filter((id) => !moving.has(id));
  const firstUnstarted = remaining.findIndex((id) => {
    const item = rawTaskItems.value.find((entry) => entry.id === id);
    return item ? canStart(item) : false;
  });
  const insertion = firstUnstarted < 0 ? remaining.length : firstUnstarted;
  remaining.splice(insertion, 0, ...open.map((item) => item.id));
  timelineOrderIDs.value = remaining;
  saveLocalState();
  if (open.length > 1) store.startParallelProgress(open.map((item) => item.id), effectiveNow.value);
  else if (open[0]) store.startProgress(open[0], effectiveNow.value);
}
function toggleDone(item: StepProgress): void {
  if (isPendingConfirmation(item)) confirmCompletion(item.id);
  else if (isIncomplete(item.state)) completeItem(item);
}
function completeItem(item: StepProgress): void {
  if (frozenHeights.value[item.id] === undefined) {
    frozenHeights.value = { ...frozenHeights.value, [item.id]: itemHeight(item) };
  }
  saveLocalState();
  store.complete(item, effectiveNow.value);
}
function confirmCompletion(id: string): void { const next = new Set(pendingConfirmationIDs.value); next.delete(id); pendingConfirmationIDs.value = next; saveLocalState(); }
function splitGroup(items: StepProgress[]): void { const next = new Set(parallelIDs.value); items.slice(1).forEach((item) => next.delete(item.id)); parallelIDs.value = next; saveLocalState(); }

// ---------------------------------------------------------------------------
// 排序模式
// ---------------------------------------------------------------------------

/** 卡头按钮：未进入 → 进入；已进入 → 保存并退出（与面板底部「完成」同一个动作）。 */
function onHeaderSortButton(): void {
  if (sortMode.value) void commitDraft();
  else enterSortMode();
}

function enterSortMode(): void {
  selectedID.value = null;
  draftKeys.value = liveGroups.value.map((group) => group.key);
  draftActivityOrder.value = Object.fromEntries(
    liveGroups.value.map((group) => [group.key, group.activities.map((item) => item.id)]),
  );
  recomputedRoutes.value = {};
  replanError.value = '';
  replanNotice.value = '';
  replanToken += 1;
  undoSnapshot.value = null;
  sortMode.value = true;
  void scheduleReplans();
}

/** 放弃草稿：本地顺序丢弃，core 未被动过，无需回滚。 */
function cancelSort(): void {
  if (committing.value) return;
  clearDragState();
  sortMode.value = false;
  draftKeys.value = [];
  draftActivityOrder.value = {};
  recomputedRoutes.value = {};
  replanError.value = '';
  replanNotice.value = '';
}

function moveGroup(index: number, delta: number): void {
  const keys = [...draftKeys.value];
  const target = index + delta;
  if (target < 0 || target >= keys.length) return;
  const [moved] = keys.splice(index, 1);
  keys.splice(target, 0, moved);
  draftKeys.value = keys;
}

function onGroupGripDown(event: PointerEvent, group: DestinationGroupPlan): void {
  if (group.fixed || committing.value) return;
  dragState.value = { kind: 'group', key: group.key };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

/** 组内活动的手柄：拖动范围只在本组内，不能跨组（跨组 = 换地点，那是改原句的事）。 */
function onActivityGripDown(
  event: PointerEvent,
  group: DestinationGroupPlan,
  item: StepProgress,
): void {
  if (committing.value || !movableIDs.value.has(item.id)) return;
  dragState.value = { kind: 'activity', groupKey: group.key, id: item.id };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

/**
 * 拖动分两路：整组在组列表间移动，或某一项在本组内移动。
 *
 * 两路都用「元素中点」作命中分界，而不是等距索引换算 —— 组卡片与活动行的
 * 高度都不等（标题可能换行、通勤行的时长文案长度不同），等距换算会明显不跟手。
 */
function onSortPointerMove(event: PointerEvent): void {
  const state = dragState.value;
  const board = sortBoardElement.value;
  if (!state || !board) return;
  if (state.kind === 'group') moveDraggedGroup(event, board, state.key);
  else moveDraggedActivity(event, board, state.groupKey, state.id);
}

function moveDraggedGroup(event: PointerEvent, board: HTMLElement, key: string): void {
  const rows = [...board.querySelectorAll<HTMLElement>('[data-group-key]')];
  if (rows.length === 0) return;

  // 与活动行同口径：以 DOM 当前顺序为基准，避免面板打开期间任务线被改动导致索引错位。
  const order = rows.map((row) => row.dataset.groupKey ?? '').filter((value) => value !== '');
  const from = order.indexOf(key);
  if (from < 0) return;

  const target = hitIndex(event.clientY, rows);
  if (target < 0 || target >= order.length || target === from) return;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  // 目标组被锁定（含已开始项）时不越过去，避免把进行中的步骤顶到别处。
  if (liveGroups.value.find((group) => group.key === next[target])?.fixed) return;
  next.splice(target, 0, moved);
  draftKeys.value = next;
}

function moveDraggedActivity(
  event: PointerEvent,
  board: HTMLElement,
  groupKey: string,
  id: string,
): void {
  // 只认本组的活动行：`data-group-key` 用 closest 读，避免把它拼进选择器带来转义问题。
  const rows = [...board.querySelectorAll<HTMLElement>('[data-activity-id]')].filter(
    (row) => row.closest<HTMLElement>('[data-group-key]')?.dataset.groupKey === groupKey,
  );
  if (rows.length < 2) return;

  // 顺序基准取 DOM 当前顺序（所见即所得），而不是草稿里那份 —— 组内若动态多了新活动，
  // 草稿那份会缺项，导致目标索引与显示顺序错位、拖不到最后一位。
  const order = rows.map((row) => row.dataset.activityId ?? '').filter((value) => value !== '');
  const from = order.indexOf(id);
  if (from < 0) return;

  const target = hitIndex(event.clientY, rows);
  if (target < 0 || target >= order.length || target === from) return;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  draftActivityOrder.value = { ...draftActivityOrder.value, [groupKey]: next };
}

/** 指针落在第几个元素上：按各元素垂直中点判定。 */
function hitIndex(clientY: number, rows: readonly HTMLElement[]): number {
  for (let index = 0; index < rows.length; index += 1) {
    const rect = rows[index].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return rows.length - 1;
}

function onSortPointerUp(): void {
  const state = dragState.value;
  clearDragState();
  if (state?.kind !== 'activity') return;
  // 先后变了，原来「与上一项并行」的关系已失去意义，一并解除（与整组拖动的口径一致）。
  if (parallelIDs.value.has(state.id)) {
    const next = new Set(parallelIDs.value);
    next.delete(state.id);
    parallelIDs.value = next;
    saveLocalState();
  }
}
function clearDragState(): void { dragState.value = null; }

// ---- 通勤重算 ----

let replanTimer: ReturnType<typeof setTimeout> | null = null;
let replanToken = 0;

/** 拖动会连续改顺序，等停稳再查，避免把选路接口打满。 */
function scheduleReplans(): Promise<void> {
  if (replanTimer !== null) clearTimeout(replanTimer);
  const token = ++replanToken;
  return new Promise((resolve) => {
    replanTimer = setTimeout(() => {
      replanTimer = null;
      if (token !== replanToken) { resolve(); return; }
      void runReplans().then(resolve);
    }, 320);
  });
}

/**
 * 对出发地已变化的通勤段按新出发地重算路线。
 *
 * 传 `destination.location` 给 `queryCommute` 会跳过 POI 选点、直接按坐标算路，
 * 所以这里不需要用户重新确认目的地 —— 变的只是「从哪里出发」。
 * 无 Key 时不假装算出结果：明确提示，保存时跳过路线写入（顺序照常保存）。
 */
async function runReplans(): Promise<void> {
  const pending = changedReplans.value.filter((plan) => !recomputedRoutes.value[plan.stepID]);
  if (pending.length === 0) {
    // 情况包括「顺序变了但没哪段通勤的出发地跟着变」，此时不能留着忙碌态。
    replanBusy.value = false;
    return;
  }
  if (!amapKey.value.trim()) {
    replanBusy.value = false;
    replanNotice.value = '未配置高德 Web 服务 Key，路段时长无法重算；保存后顺序生效，路线保持原样。';
    return;
  }

  const token = replanToken;
  replanBusy.value = true;
  replanError.value = '';
  replanNotice.value = '';
  try {
    const next = { ...recomputedRoutes.value };
    for (const plan of pending) {
      const route = await queryCommute(
        amapKey.value,
        plan.destination.name,
        plan.mode,
        plan.destination,
        plan.toOrigin,
      );
      if (token !== replanToken) return;
      next[plan.stepID] = { origin: plan.toOrigin, route };
    }
    recomputedRoutes.value = next;
  } catch (error) {
    if (token !== replanToken) return;
    replanError.value = error instanceof Error
      ? `路段重算失败：${error.message}`
      : '路段重算失败，保存后顺序仍会生效。';
  } finally {
    if (token === replanToken) replanBusy.value = false;
  }
}

/** 该组对应的重算计划（只在出发地真的变了时才返回）。 */
function replanOf(group: DestinationGroupPlan): CommuteReplan | null {
  if (!group.commute) return null;
  const plan = replanByStepID.value.get(group.commute.id);
  return plan?.changed ? plan : null;
}
function replanText(plan: CommuteReplan | null): string {
  if (!plan) return '';
  const entry = draftRouteByID.value[plan.stepID];
  const minutes = entry
    ? `预计 ${Math.round(entry.seconds / 60)} 分钟（原 ${Math.round(plan.fromSeconds / 60)} 分钟）`
    : '正在按新出发地重算…';
  return `出发地变了：改从${plan.toOriginName}出发，${minutes}`;
}
function commuteTimeText(group: DestinationGroupPlan): string {
  if (!group.commute) return '';
  const entry = draftRouteByID.value[group.commute.id];
  const seconds = entry?.seconds ?? group.commute.step.duration;
  return `预计 ${Math.round(seconds / 60)} 分钟`;
}
/** 组内是否带着并行关系（组首项之外的成员与上一项并行）。 */
function hasParallel(group: DestinationGroupPlan): boolean {
  return groupMembers(group).slice(1).some((item) => parallelIDs.value.has(item.id));
}
function splitGroupOf(group: DestinationGroupPlan): void {
  const next = new Set(parallelIDs.value);
  groupMembers(group).slice(1).forEach((item) => next.delete(item.id));
  parallelIDs.value = next;
  saveLocalState();
}
function groupMembers(group: DestinationGroupPlan): StepProgress[] {
  return [...(group.commute ? [group.commute] : []), ...group.activities];
}
/** 活动项的预计时间范围：结束取草稿排程的完成时刻，开始回推时长。 */
function draftRange(item: StepProgress): string {
  const due = draftEstimates.value.get(item.id);
  if (!due) return '';
  const seconds = item.state === 'active' ? 0 : item.step.duration;
  return `${formatClock(new Date(due.getTime() - seconds * 1000))} – ${formatClock(due)}`;
}

// ---------------------------------------------------------------------------
// 提交 / 撤销
// ---------------------------------------------------------------------------

/**
 * 保存草稿：先改顺序，再按新顺序写回重算的通勤路线。
 *
 * 顺序与路线必须一起提交 —— `reorderPendingTasks` 会立刻重算 `dueAt`，
 * 若路线晚一步写入，用户会先看到一段基于旧出发地的错误排程。
 */
async function commitDraft(): Promise<void> {
  const active = session.value;
  if (!active || committing.value) return;

  const previousOrder = [...sortableIDs.value];
  const undoRoutes = active.progress
    .filter((item) => item.step.role === 'task' && item.step.commute !== undefined)
    .map((item) => ({
      progressID: item.id,
      commute: { ...(item.step.commute as CommuteRoute) },
      duration: item.step.duration,
    }));

  committing.value = true;
  try {
    // 点击那一刻的草稿即提交依据：await 期间若草稿被动过（面板已禁用交互，理论不会），
    // 也不至于把「新顺序」配到「另一份判据」上。
    const ids = draftMoveIDs.value;
    const plans = changedReplans.value;

    // 还没算完的路段等一次，避免保存出「新顺序 + 旧路线」的半截状态。
    if (plans.some((plan) => !draftRouteByID.value[plan.stepID]) && amapKey.value.trim()) {
      await runReplans();
    }

    const routes = draftRouteByID.value;
    const updates = plans
      .map((plan) => {
        const route = routes[plan.stepID];
        return route ? { progressID: plan.stepID, commute: route } : null;
      })
      .filter((update): update is { progressID: string; commute: CommuteRoute } => update !== null);

    store.reorderPendingTasks(ids);
    if (updates.length > 0) store.applyCommuteRoutes(updates);

    // 视图展示顺序与 core 同步：core 变了，而 timelineOrderIDs 是本地的。
    const movable = new Set(ids);
    let cursor = 0;
    timelineOrderIDs.value = timelineOrderIDs.value.map((id) => (movable.has(id) ? ids[cursor++] : id));
    saveLocalState();

    undoSnapshot.value = { order: previousOrder, routes: undoRoutes };
    undoSignature.value = ids.join(',');
    sortMode.value = false;
    draftKeys.value = [];
    draftActivityOrder.value = {};
    recomputedRoutes.value = {};
    replanError.value = '';
    replanNotice.value = '';
  } finally {
    committing.value = false;
  }
}

/** 撤销上一次保存：顺序、路线、时长一起回到调整前。 */
function undoLastReorder(): void {
  const snapshot = undoSnapshot.value;
  if (!snapshot) return;
  undoSnapshot.value = null;

  store.reorderPendingTasks(snapshot.order);
  if (snapshot.routes.length > 0) {
    store.applyCommuteRoutes(
      snapshot.routes.map((entry) => ({
        progressID: entry.progressID,
        commute: entry.commute,
        duration: entry.duration,
      })),
    );
  }

  const movable = new Set(snapshot.order);
  let cursor = 0;
  timelineOrderIDs.value = timelineOrderIDs.value.map((id) => (movable.has(id) ? snapshot.order[cursor++] : id));
  saveLocalState();
}
</script>

<style scoped>
.mm-capsule-timeline { display: flex; flex-direction: column; gap: 14px; padding: 20px; border: 1px solid var(--mm-border); border-radius: 24px; background: #fff; box-shadow: var(--mm-shadow); }
.mm-capsule-timeline::before, .mm-capsule-timeline::after { display: none; }
.mm-capsule-now { align-self: flex-end; color: #91a0b4; font-size: 11px; font-variant-numeric: tabular-nums; padding: 3px 8px; border-radius: 7px; background: #f5f7fb; }
.mm-task-band { gap: 12px; }
.mm-task-lane { position: relative; }
.mm-task-lane::after { content: ''; position: absolute; left: 25px; top: 100%; height: 12px; width: 3px; background: #eeeded; }
/* 时间线已无拖动手势：覆盖全局的 touch-action:none，让整卡在触屏上可滚动。 */
.mm-task-block { gap: 14px; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; touch-action: pan-y; }
.mm-task-block.active, .mm-task-block.overdue, .mm-task-block.completed, .mm-task-block.unconfirmed { padding: 0; border: 0; background: transparent; box-shadow: none; opacity: 1; }
.mm-task-block::before { display: none; }
.mm-time-capsule { position: relative; align-self: stretch; flex: 0 0 52px; min-height: 44px; border-radius: 999px; overflow: hidden; background: #f0f3f7; color: var(--capsule-color); }
.mm-time-capsule__fill { position: absolute; inset: 0 0 auto; background: var(--capsule-color); transition: height .9s linear, background-color .5s ease; }
.mm-time-capsule svg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); filter: drop-shadow(0 1px 1px #ffffffb3); }
.active .mm-time-capsule svg, .completed .mm-time-capsule svg, .unconfirmed .mm-time-capsule svg { color: #fff; filter: drop-shadow(0 1px 2px #0003); }
.mm-capsule-time { margin-bottom: 5px; color: #97a4b6; font-size: 10px; font-variant-numeric: tabular-nums; }
.mm-task-block__title { font-size: 14px; font-weight: 650; white-space: normal; line-height: 1.5; }
.mm-task-block__title small { display: none; }
.completed .mm-task-block__title { color: #999; }
.mm-task-check { width: 24px; height: 24px; margin-right: 2px; border: 2px solid var(--capsule-color); color: var(--capsule-color); font-size: 14px; }
.completed .mm-task-check { background: var(--capsule-color); color: white; }
.mm-live-pill, .mm-task-start, .mm-confirm-chip { position: absolute; bottom: 2px; right: 34px; }
.mm-task-wait { margin-left: 66px; }
.mm-task-name-row { display: flex; align-items: center; gap: 8px; }
.mm-task-name-row .mm-task-block__title { flex: 1; min-width: 0; }
.mm-task-band--parallel .mm-task-block { gap: 8px; }
.mm-task-band--parallel .mm-time-capsule { flex-basis: 36px; }
.mm-task-band--parallel .mm-task-lane::after { left: 17px; }
.mm-task-band--parallel .mm-task-block__title { font-size: 13px; }
.mm-task-band--parallel .mm-capsule-time { font-size: 9px; }
.mm-task-band--parallel .mm-task-wait { margin-left: 44px; }
.mm-task-band--parallel .mm-task-check { width: 19px; height: 19px; }

/* ---- 卡头：调整顺序入口 ---- */
.mm-line-summary__side { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.mm-sort-toggle { white-space: nowrap; }

/* ---- 排序面板 ---- */
.mm-sortboard { display: flex; flex-direction: column; gap: 12px; }
.mm-sortboard--busy { pointer-events: none; opacity: .8; }
.mm-sort-hint { margin: 0; padding: 9px 12px; border: 1px solid #e6d9b6; border-radius: 12px; background: #fdf8ec; color: #7d5a13; font-size: 11px; line-height: 1.6; }
.mm-sort-groups { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.mm-sort-group { padding: 10px 12px; border: 1px solid var(--mm-border); border-radius: 14px; background: #fff; box-shadow: var(--mm-shadow); touch-action: pan-y; }
.mm-sort-group--dragging { border-color: #185fa5; background: #f4f9ff; opacity: .9; }
/* 正在调组内先后：整组高亮一圈，让「在哪个地点里调」一眼可见 */
.mm-sort-group--active { border-color: #9dc0e8; background: #fbfdff; }
.mm-sort-group--fixed { background: #faf9f6; }
.mm-sort-group__head { display: flex; align-items: center; gap: 8px; }
.mm-sort-group__title { flex: 1; min-width: 0; font-size: 14px; font-weight: 650; }
.mm-sort-group__tools { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.mm-sort-unmerge { white-space: nowrap; }
/* 组手柄与行手柄都靠行最右，右对齐成一列；靠尺寸 + 样式区分层级（粗重 = 大单位）。 */
.mm-sort-grip { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: 2px; border: 1px dashed #c9c4b8; border-radius: 8px; background: #fff; color: #8d8676; font-size: 15px; line-height: 1; cursor: grab; touch-action: none; user-select: none; }
.mm-sort-grip:active { background: #f1eee6; cursor: grabbing; }
/* 行手柄：无边框、更小、淡色 —— 与组手柄在同一列但明显更轻 */
.mm-sort-grip--row { width: 22px; height: 22px; margin-left: 0; border: 0; border-radius: 6px; background: transparent; color: #bcb5a6; font-size: 14px; }
.mm-sort-grip--row:hover { background: #f1eee6; color: #8d8676; }
.mm-sort-row--dragging { background: #eef4ff; border-radius: 7px; }
.mm-sort-row--dragging .mm-sort-row__text { font-weight: 650; }
/* 占位与组手柄同尺寸，锁定态下不破坏那一列的对齐。 */
.mm-sort-lock { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: 2px; font-size: 12px; }
.mm-sort-group__body { display: flex; flex-direction: column; gap: 5px; margin: 8px 0 0; padding: 0; list-style: none; }
/* align-items 用 center：行内多了固定尺寸的拖动手柄，baseline 会让手柄跳位。 */
.mm-sort-row { display: flex; align-items: center; gap: 8px; min-height: 24px; padding-left: 20px; font-size: 12px; color: var(--mm-ink-soft); }
.mm-sort-row--commute { color: #2563eb; font-weight: 600; }
.mm-sort-row__icon { flex: 0 0 auto; }
.mm-sort-row__text { flex: 1; min-width: 0; }
.mm-sort-row__time { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.mm-sort-replan { margin: 8px 0 0; padding: 7px 10px; border-radius: 9px; background: #eef4ff; color: #1e4f9c; font-size: 11px; line-height: 1.6; }
.mm-sort-impact { padding: 10px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; line-height: 1.6; }
.mm-sort-impact--late { background: #fce8e8; color: #a32d2d; }
.mm-sort-impact--early { background: #e1f5ec; color: #167d5a; }
.mm-sort-impact--ok { background: #e1f5ec; color: #167d5a; }
.mm-sort-impact--neutral { background: #f4f2ed; color: var(--mm-ink-soft); }
.mm-sort-note { margin: 0; color: var(--mm-ink-soft); font-size: 11px; line-height: 1.6; }
.mm-sort-note--warn { color: #a32d2d; }

/* ---- 撤销条 ---- */
.mm-undo-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 14px; border: 1px solid #d9e3f0; border-radius: 12px; background: #f5f9ff; color: #1e4f9c; font-size: 12px; }

@media (prefers-reduced-motion: reduce) { .mm-time-capsule__fill { transition: none; } }
</style>
