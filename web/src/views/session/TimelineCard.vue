<template>
  <section v-if="session" data-testid="timeline-card">
    <div class="mm-line-summary">
      <div class="mm-line-summary__top">
        <div>
          <span class="mm-badge">{{ session.templateName || '任务线' }}</span>
          <p class="mm-line-summary__label">最晚必须开始</p>
          <p class="mm-line-summary__start">{{ formatClock(session.plannedStartAt) }}</p>
        </div>
        <div class="mm-line-summary__impact">
          <span>预计 {{ estimated ? formatClock(estimated) : '--:--' }}</span>
          <b>→</b>
          <span>目标 {{ session.targetDeadline ? formatClock(session.targetDeadline) : '--:--' }}</span>
          <em :class="deltaClass">{{ deltaText }}</em>
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

      <div class="mm-simulator">
        <span>模拟现在</span>
        <input type="time" step="1" :value="simulatedTimeText" @input="setSimulatedTime" />
        <button @click="simPlaying = !simPlaying">{{ simPlaying ? 'Ⅱ' : '▶' }}</button>
        <button
          v-for="value in [1, 10, 60]"
          :key="value"
          :class="{ active: simSpeed === value }"
          @click="simSpeed = value"
        >{{ value }}×</button>
      </div>
    </div>

    <div class="mm-line-status" :class="statusClass">
      <i></i><span>{{ statusText }}</span>
    </div>

    <div
      ref="tasklineElement"
      class="mm-taskline mm-capsule-timeline"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="clearDrag"
    >
      <div class="mm-capsule-now">现在 {{ formatClockWithSeconds(effectiveNow) }}</div>

      <template v-for="(group, groupIndex) in groups" :key="group.key">
        <div
          class="mm-task-band"
          :class="{
            'mm-task-band--parallel': group.items.length > 1,
            'mm-task-band--dragging': drag?.id && group.items.some((item) => item.id === drag?.id),
          }"
        >
          <div v-for="item in group.items" :key="item.id" class="mm-task-lane">
            <article
              class="mm-task-block"
              :class="blockClasses(item)"
              :style="{ height: `${itemHeight(item)}px`, '--capsule-color': capsuleColor(item) }"
              :data-testid="`timeline-row-${item.id}`"
              @pointerdown="onPointerDown($event, item)"
              @click="selectedID = item.id"
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

    <p class="mm-drag-hint">上下拖动换顺序 · 向右拖动与上一项并行</p>

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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  estimatedCompletion,
  estimatedDueDates,
  formatMinutes,
  isIncomplete,
  useRoutineStore,
  type StepProgress,
} from '../../stores/routine';
import { formatClock, reorderableItems } from './helpers';
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
const drag = ref<{ id: string; x: number; y: number; dx: number; dy: number } | null>(null);
const tasklineElement = ref<HTMLElement | null>(null);
const simulatedNow = ref(new Date(props.now));
const simPlaying = ref(false);
const simSpeed = ref(1);
const effectiveNow = computed(() => simulatedNow.value);
const simulatedTimeText = computed(() => formatClockWithSeconds(simulatedNow.value));

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
watch(() => props.focusedProgressId, (id) => {
  if (!id || typeof document === 'undefined') return;
  void nextTick(() => document.querySelector(`[data-testid="timeline-row-${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}, { immediate: true });
watch(() => props.now.getTime(), (next, previous) => {
  if (simPlaying.value && previous !== undefined) {
    simulatedNow.value = new Date(simulatedNow.value.getTime() + (next - previous) * simSpeed.value);
  }
});
watch(() => effectiveNow.value.getTime(), () => {
  if (alertMode.value !== 'silent' || !current.value || !session.value) return;
  if (effectiveNow.value.getTime() < current.value.dueAt.getTime()) return;
  const laterTaskExists = session.value.progress.some((item) => item.id !== current.value?.id && item.step.role === 'task' && isIncomplete(item.state));
  if (!laterTaskExists) return;
  pendingConfirmationIDs.value = new Set([...pendingConfirmationIDs.value, current.value.id]);
  completeItem(current.value);
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
function setSimulatedTime(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  const parts = value.split(':').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return;
  const next = new Date(simulatedNow.value);
  next.setHours(parts[0], parts[1], parts[2] ?? 0, 0);
  simulatedNow.value = next;
}
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
function shouldShowStart(index: number): boolean {
  if (index <= 0) return true;
  return Math.abs(groupStart(index).getTime() - groupEnd(groups.value[index - 1].items).getTime()) >= 30000;
}
function intermediateTimes(index: number): Array<{ label: string; percent: number }> {
  const start = groupStart(index).getTime();
  const end = groupEnd(groups.value[index].items).getTime();
  const minutes = (end - start) / 60000;
  if (minutes < 20) return [];
  const result: Array<{ label: string; percent: number }> = [];
  for (let offset = 10; offset < minutes; offset += 10) {
    result.push({ label: formatClock(new Date(start + offset * 60000)), percent: offset / minutes * 100 });
  }
  return result;
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
  return ['#efa09b', '#658da7', '#95b96d', '#a46b88'][Math.max(0, taskItems.value.findIndex(task => task.id === item.id)) % 4];
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

function onPointerDown(event: PointerEvent, item: StepProgress): void {
  if (!canArrange(item)) return;
  // 按钮属于点击操作，不能被任务块的拖动手势捕获。
  if ((event.target as HTMLElement).closest('button')) return;
  drag.value = { id: item.id, x: event.clientX, y: event.clientY, dx: 0, dy: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}
function onPointerMove(event: PointerEvent): void { if (drag.value) drag.value = { ...drag.value, dx: event.clientX - drag.value.x, dy: event.clientY - drag.value.y }; }
function onPointerUp(): void {
  const value = drag.value; clearDrag();
  if (!value || !session.value) return;
  const items = reorderableItems(session.value);
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return;
  if (value.dx > 52 && index > 0) {
    const next = new Set(parallelIDs.value); next.add(value.id); parallelIDs.value = next; saveLocalState(); return;
  }
  if (Math.abs(value.dy) > 36) {
    const target = Math.max(0, Math.min(items.length - 1, index + (value.dy > 0 ? 1 : -1)));
    const ids = items.map((item) => item.id); const [moved] = ids.splice(index, 1); ids.splice(target, 0, moved);
    const reorderableSet = new Set(ids);
    let cursor = 0;
    timelineOrderIDs.value = timelineOrderIDs.value.map((id) =>
      reorderableSet.has(id) ? ids[cursor++] : id,
    );
    const next = new Set(parallelIDs.value); next.delete(value.id); parallelIDs.value = next; saveLocalState(); store.reorderPendingTasks(ids);
  }
}
function clearDrag(): void { drag.value = null; }
</script>

<style scoped>
.mm-capsule-timeline { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 24px; background: #fff; }
.mm-capsule-timeline::before, .mm-capsule-timeline::after { display: none; }
.mm-capsule-now { align-self: flex-end; color: var(--mm-ink-soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.mm-task-band { gap: 12px; }
.mm-task-lane { position: relative; }
.mm-task-lane::after { content: ''; position: absolute; left: 25px; top: 100%; height: 12px; width: 3px; background: #eeeded; }
.mm-task-block { gap: 14px; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.mm-task-block.active, .mm-task-block.overdue, .mm-task-block.completed, .mm-task-block.unconfirmed { padding: 0; border: 0; background: transparent; box-shadow: none; opacity: 1; }
.mm-task-block::before { display: none; }
.mm-time-capsule { position: relative; align-self: stretch; flex: 0 0 52px; min-height: 44px; border-radius: 999px; overflow: hidden; background: #eeeded; color: var(--capsule-color); }
.mm-time-capsule__fill { position: absolute; inset: 0 0 auto; background: var(--capsule-color); transition: height .9s linear, background-color .5s ease; }
.mm-time-capsule svg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); filter: drop-shadow(0 1px 1px #ffffffb3); }
.active .mm-time-capsule svg, .completed .mm-time-capsule svg, .unconfirmed .mm-time-capsule svg { color: #fff; filter: drop-shadow(0 1px 2px #0003); }
.mm-capsule-time { margin-bottom: 5px; color: #949494; font-size: 11px; font-variant-numeric: tabular-nums; }
.mm-task-block__title { font-size: 16px; white-space: normal; line-height: 1.3; }
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
@media (prefers-reduced-motion: reduce) { .mm-time-capsule__fill { transition: none; } }
</style>
