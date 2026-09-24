<template>
  <!--
    TimelineCard（ContentView.swift 932–1100）
    时间线：已完成 / 进行中 / 待办，含「开始」「完成」「删除」「调整顺序」。
  -->
  <section
    v-if="session"
    class="mm-doodle"
    style="background: rgba(255, 255, 255, 0.8); padding: 20px; border-radius: 22px"
    data-testid="timeline-card"
  >
    <div class="mm-row" style="padding: 0">
      <h3 class="mm-headline">任务列表</h3>
      <button v-if="reorderable.length > 1" class="mm-link-btn" @click="showsReorder = true">
        调整顺序
      </button>
    </div>

    <div
      v-for="item in session.progress"
      :key="item.id"
      class="mm-timeline-row"
      :class="{ 'mm-timeline-row--focused': item.id === focusedProgressId }"
      :style="{ background: rowColor(item), opacity: item.state === 'completed' ? 0.55 : 1 }"
      :data-testid="`timeline-row-${item.id}`"
    >
      <SessionIcon :name="iconFor(item)" :size="16" :style="{ color: iconColor(item) }" />

      <div style="flex: 1; min-width: 0">
        <div class="mm-inline" style="gap: 5px">
          <span class="mm-timeline__title">{{ item.step.title }}</span>
          <span v-if="item.state === 'active'" class="mm-badge" style="color: var(--mm-orange)">
            当前
          </span>
          <span
            v-else-if="item.state === 'suspended'"
            class="mm-badge"
            style="color: var(--mm-coral)"
          >
            已挂起
          </span>
          <span v-if="item.isTemporary" class="mm-badge" style="color: var(--mm-coral)">临时</span>
        </div>

        <p v-if="item.state === 'completed'" class="mm-hint" style="margin: 2px 0 0">
          {{ item.completedAt ? `完成于 ${formatClock(item.completedAt)}` : '已完成' }}
        </p>
        <div v-else class="mm-inline" style="gap: 10px; margin-top: 3px">
          <span class="mm-inline mm-hint mm-mono" style="gap: 4px; font-size: 11px">
            <SessionIcon name="calendar" :size="11" />
            计划 {{ formatClock(originalDue(item)) }}
          </span>
          <span
            class="mm-inline mm-mono"
            style="gap: 4px; font-size: 11px"
            :style="{ color: isDelayed(item) ? 'var(--mm-red)' : 'var(--mm-olive)' }"
          >
            <SessionIcon name="clock" :size="11" />
            预计 {{ formatClock(estimatedDue(item)) }}
          </span>
        </div>
      </div>

      <div class="mm-inline" style="gap: 8px">
        <button
          v-if="canStart(item)"
          class="mm-btn mm-btn--primary mm-btn--small"
          @click="start(item)"
        >
          开始
        </button>
        <button
          v-else-if="canCompleteDeadline(item)"
          class="mm-btn mm-btn--red mm-btn--small"
          @click="complete(item)"
        >
          完成
        </button>
        <button
          v-if="item.step.role === 'task'"
          class="mm-btn mm-btn--secondary mm-btn--icon-sm"
          :aria-label="`删除本次任务 ${item.step.title}`"
          @click="taskPendingDeletion = item"
        >
          <SessionIcon name="trash" :size="12" />
        </button>
      </div>
    </div>

    <!-- 调整顺序（对应 .sheet → PendingTaskReorderView） -->
    <PendingTaskReorderView
      v-if="showsReorder"
      :items="reorderable"
      @cancel="showsReorder = false"
      @save="onSaveOrder"
    />

    <!-- 删除确认（对应 .confirmationDialog） -->
    <div
      v-if="taskPendingDeletion"
      class="mm-modal-backdrop"
      @click.self="taskPendingDeletion = null"
    >
      <div class="mm-modal mm-modal--dialog">
        <h4>删除本次任务？</h4>
        <p class="mm-hint">只从本次计划中删除，原任务线不会改变。</p>
        <div class="mm-actions mm-actions--end">
          <button class="mm-btn mm-btn--secondary" @click="taskPendingDeletion = null">
            取消
          </button>
          <button class="mm-btn mm-btn--danger" @click="confirmDelete">
            删除“{{ taskPendingDeletion.step.title }}”
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  estimatedDueDates,
  formatMinutes,
  isIncomplete,
  originalDueAt,
  useRoutineStore,
  type StepProgress,
} from '../../stores/routine';
import { formatClock, reorderableItems } from './helpers';
import PendingTaskReorderView from './PendingTaskReorderView.vue';
import SessionIcon from './SessionIcon.vue';

const props = defineProps<{ now: Date; focusedProgressId?: string | null }>();

const store = useRoutineStore();
const showsReorder = ref(false);
const taskPendingDeletion = ref<StepProgress | null>(null);

const session = computed(() => store.session);

/** session.estimatedDueDates(at:)。 */
const estimates = computed(() =>
  session.value ? estimatedDueDates(session.value, props.now) : new Map<string, Date>(),
);

/** 可重排待办（> 1 才显示「调整顺序」）。 */
const reorderable = computed(() => (session.value ? reorderableItems(session.value) : []));

// P3 通知回跳：命中行滚动到可视区中部。
// 必须带 `document` 守卫：vitest 是 node 环境（无 DOM），且部分环境缺 scrollIntoView。
watch(
  () => props.focusedProgressId,
  (id) => {
    if (!id) return;
    if (typeof document === 'undefined') return;
    void nextTick(() => {
      const el = document.querySelector(`[data-testid="timeline-row-${id}"]`);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  },
  { immediate: true },
);

function originalDue(item: StepProgress): Date {
  return originalDueAt(item);
}

function estimatedDue(item: StepProgress): Date {
  return estimates.value.get(item.id) ?? item.dueAt;
}

function isDelayed(item: StepProgress): boolean {
  return estimatedDue(item).getTime() > originalDue(item).getTime();
}

/** `开始`：role==task 且 pending/suspended（对应 Swift `store.start(progress)`）。 */
function canStart(item: StepProgress): boolean {
  return item.step.role === 'task' && (item.state === 'pending' || item.state === 'suspended');
}

/** `完成`：末尾 deadline 未完成，且所有 task 都已完成。 */
function canCompleteDeadline(item: StepProgress): boolean {
  if (item.step.role !== 'deadline' || !isIncomplete(item.state) || !session.value) {
    return false;
  }
  return session.value.progress
    .filter((entry) => entry.step.role === 'task')
    .every((entry) => !isIncomplete(entry.state));
}

function start(item: StepProgress): void {
  store.startProgress(item);
}

function complete(item: StepProgress): void {
  store.complete(item);
}

function confirmDelete(): void {
  if (taskPendingDeletion.value) {
    store.deleteFromCurrentSession(taskPendingDeletion.value);
  }
  taskPendingDeletion.value = null;
}

function onSaveOrder(ids: string[]): void {
  store.reorderPendingTasks(ids);
  showsReorder.value = false;
}

function iconFor(item: StepProgress): string {
  if (item.state === 'completed') {
    return 'check';
  }
  if (item.state === 'active') {
    return 'target';
  }
  if (item.state === 'suspended') {
    return 'pause';
  }
  if (item.step.role === 'deadline') {
    return 'flag';
  }
  return 'circle';
}

function iconColor(item: StepProgress): string {
  if (item.state === 'completed') {
    return 'var(--mm-olive)';
  }
  if (item.isTemporary) {
    return 'var(--mm-coral)';
  }
  return 'rgba(29, 31, 29, 0.55)';
}

/** 逐字对应 Swift `rowColor(for:)`（1092–1098）。 */
function rowColor(item: StepProgress): string {
  if (item.state === 'active') {
    return 'rgb(255, 230, 173)';
  }
  if (item.state === 'suspended') {
    return 'rgba(246, 143, 110, 0.13)';
  }
  if (item.step.role === 'deadline') {
    return 'rgba(255, 230, 173, 0.78)';
  }
  if (item.isTemporary) {
    return 'rgba(246, 143, 110, 0.16)';
  }
  return 'rgba(255, 244, 212, 0.76)';
}
</script>
