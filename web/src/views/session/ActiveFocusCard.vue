<template>
  <!--
    ActiveFocusCard（ContentView.swift 783–861）
    当前进行中任务卡：任务线标签 + 「会晚到」角标 + 当前任务（倒计时 / 完成 / 延后 / 临时加事）。
  -->
  <section
    v-if="session"
    class="mm-doodle"
    style="background: var(--mm-sky); padding: 22px; border-radius: 26px"
    data-testid="active-focus-card"
  >
    <div class="mm-row" style="padding: 0">
      <span class="mm-inline mm-hint" style="font-weight: 600; gap: 6px">
        <SessionIcon :name="iconNameForSymbol(session?.templateSymbol)" :size="14" />
        {{ session.templateName || '任务线' }}
      </span>
      <span
        v-if="late"
        class="mm-inline"
        style="gap: 5px; color: var(--mm-red); font-weight: 700; font-size: 12px"
      >
        <SessionIcon name="warning" :size="13" />
        会晚到
      </span>
    </div>

    <!-- 有当前任务 -->
    <template v-if="current">
      <p
        class="mm-badge"
        style="margin-top: 16px"
        :style="{ color: current.step.importance === 'hardDeadline' ? 'var(--mm-red)' : 'var(--mm-orange)' }"
      >
        {{ current.step.importance === 'hardDeadline' ? '现在必须做' : '当前主线' }}
      </p>
      <h2 class="mm-focus-title">{{ current.step.title }}</h2>
      <p class="mm-hint">{{ current.step.prompt }}</p>
      <RemainingTimeText :due-at="current.dueAt" :now="now" />

      <div class="mm-actions">
        <button class="mm-btn mm-btn--primary" @click="completeCurrent">完成</button>
        <button class="mm-btn mm-btn--secondary" @click="snooze">延后 2 分钟</button>
        <button
          class="mm-btn mm-btn--secondary mm-btn--icon"
          aria-label="临时加事"
          @click="showsTemporaryTask = true"
        >
          <SessionIcon name="plus" :size="16" />
        </button>
      </div>
    </template>

    <!-- 还有未开始的普通任务 -->
    <template v-else-if="hasIncompleteTask">
      <h2 class="mm-focus-title" style="margin-top: 16px">还没有开始任务</h2>
      <p class="mm-hint">从下方任务列表选择一项，点击“开始”。</p>
    </template>

    <!-- 只剩末尾 deadline 未完成 -->
    <template v-else-if="hasIncompleteDeadline">
      <h2 class="mm-focus-title" style="margin-top: 16px">任务步骤已完成</h2>
      <p class="mm-hint">正在整理本次完成结果。</p>
    </template>

    <!-- 全部完成 -->
    <template v-else>
      <h3 style="margin: 16px 0 0">今天的主线完成啦</h3>
      <div class="mm-actions">
        <button class="mm-btn mm-btn--primary" @click="finish">结束今天流程</button>
      </div>
    </template>

    <TemporaryTaskView v-if="showsTemporaryTask" @close="showsTemporaryTask = false" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { isIncomplete, isLate, useRoutineStore } from '../../stores/routine';
import { iconNameForSymbol } from './helpers';
import RemainingTimeText from './RemainingTimeText.vue';
import SessionIcon from './SessionIcon.vue';
import TemporaryTaskView from './TemporaryTaskView.vue';

const props = defineProps<{ now: Date }>();

const store = useRoutineStore();
const showsTemporaryTask = ref(false);

const session = computed(() => store.session);
const current = computed(() => store.currentProgress);

/** 「会晚到」：session.isLate(at: context.date)。 */
const late = computed(() => (session.value ? isLate(session.value, props.now) : false));

const hasIncompleteTask = computed(
  () =>
    session.value?.progress.some(
      (item) => isIncomplete(item.state) && item.step.role === 'task',
    ) === true,
);

const hasIncompleteDeadline = computed(
  () =>
    session.value?.progress.some(
      (item) => isIncomplete(item.state) && item.step.role === 'deadline',
    ) === true,
);

function completeCurrent(): void {
  if (current.value) {
    store.complete(current.value);
  }
}

function snooze(): void {
  store.snoozeCurrent();
}

function finish(): void {
  store.finish();
}
</script>
