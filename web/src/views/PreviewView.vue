<template>
  <!--
    PreviewView —— `TaskLinePreviewView`（iOS/ContentView.swift 440–713）
    点任务卡 / 保存新建后进入：先选「按本次计划 / 按原计划」（可调截止时间与缓冲）才开始会话。
  -->
  <div v-if="activeTemplate">
    <header class="mm-toolbar">
      <span class="mm-toolbar__side">
        <button class="mm-btn mm-btn--secondary" @click="goBack">任务线</button>
      </span>
      <span class="mm-title">{{ activeTemplate.name }}</span>
      <span class="mm-toolbar__side mm-toolbar__side--end"></span>
    </header>

    <main class="mm-page" style="max-width: 1120px">
      <!-- backward：本次计划 / 原计划两栏 -->
      <template v-if="activeTemplate.mode === 'backward'">
        <div
          class="mm-status-card mm-doodle"
          data-testid="preview-status"
          :style="{
            background: status.isRed ? 'var(--mm-coral-soft)' : 'var(--mm-soft-sky)',
            color: status.isRed ? 'var(--mm-red)' : 'var(--mm-orange)',
          }"
        >
          <SessionIcon :name="iconNameForSymbol(status.symbol)" :size="16" />
          <span>{{ status.message }}</span>
        </div>

        <div class="mm-preview-plans">
          <!-- 本次计划（prominent） -->
          <section class="mm-plan-card mm-plan-card--prominent mm-doodle" data-testid="current-plan-card">
            <h3 class="mm-plan-card__title">本次计划</h3>
            <p class="mm-hint">默认预留 10 分钟缓冲，可自行调整</p>

            <p class="mm-hint" style="margin-top: 12px">{{ deadlineLabel }}</p>
            <input
              v-model="selectedDeadlineTime"
              type="time"
              class="mm-input"
              data-testid="preview-deadline"
            />

            <div class="mm-row" style="padding: 8px 0">
              <span style="font-weight: 600">缓冲时间</span>
              <span class="mm-inline">
                <input
                  v-model.number="selectedBufferMinutes"
                  type="number"
                  class="mm-input mm-input--num"
                  min="0"
                  max="60"
                  step="5"
                  data-testid="preview-buffer"
                />
                <span>分钟</span>
              </span>
            </div>
            <p class="mm-hint">会按该固定机动时间整体倒推，不会在执行中扣减。</p>

            <div class="mm-divider"></div>

            <BackwardPlanSummary
              :template="activeTemplate"
              :deadline="selectedDeadline"
              :buffer="selectedBuffer"
            />

            <button
              class="mm-btn mm-btn--primary"
              style="width: 100%; margin-top: 14px"
              :disabled="busy"
              data-testid="enter-current-plan"
              @click="enterCurrentPlan"
            >
              <span class="mm-inline"><SessionIcon name="list" :size="15" />按本次计划进入</span>
            </button>
          </section>

          <!-- 原计划（compact） -->
          <section class="mm-plan-card mm-plan-card--compact mm-doodle" data-testid="original-plan-card">
            <h3 class="mm-plan-card__title mm-plan-card__title--sm">原计划</h3>
            <p class="mm-hint">{{ originalPlanCaption }}</p>

            <p class="mm-hint" style="margin-top: 10px">{{ originalDayLabel }}</p>
            <p class="mm-big-time mm-mono" data-testid="original-deadline">
              {{ formatClock(originalDeadline) }}
            </p>

            <div class="mm-divider"></div>

            <p class="mm-hint">建议开始</p>
            <p class="mm-mono" style="font-weight: 700; margin: 2px 0">
              {{ formatClock(originalSuggestedStart) }}
            </p>
            <p class="mm-hint">预留缓冲 {{ formatMinutes(activeTemplate.buffer) }}</p>

            <button
              class="mm-btn mm-btn--secondary"
              style="width: 100%; margin-top: 12px"
              :disabled="busy"
              data-testid="enter-original-plan"
              @click="enterOriginalPlan"
            >
              <span class="mm-inline"><SessionIcon name="list" :size="15" />按原计划进入</span>
            </button>
          </section>
        </div>
      </template>

      <!-- forward：从现在开始 -->
      <template v-else>
        <h2 class="mm-preview-heading">从现在开始</h2>
        <p class="mm-hint">进入任务线后，再选择一项开始。</p>

        <div class="mm-plan-card mm-doodle" style="background: var(--mm-soft-sky); margin-top: 16px">
          <div v-for="step in forwardSteps" :key="step.id" class="mm-plan-row">
            <SessionIcon name="circle" :size="13" :style="{ color: 'var(--mm-ink-soft)' }" />
            <span class="mm-plan-row__title">{{ step.title }}</span>
            <span class="mm-plan-row__time mm-mono">{{ formatMinutes(step.duration) }}</span>
          </div>
        </div>

        <button
          class="mm-btn mm-btn--primary"
          style="width: 100%; margin-top: 16px"
          :disabled="busy"
          data-testid="enter-forward"
          @click="enterForward"
        >
          <span class="mm-inline"><SessionIcon name="list" :size="15" />进入任务线</span>
        </button>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  DEFAULT_TIME_ZONE,
  deadlineOn,
  deadlineStep,
  formatMinutes,
  taskSteps,
  useRoutineStore,
} from '../stores/routine';
import { formatClock, iconNameForSymbol } from './session/helpers';
import SessionIcon from './session/SessionIcon.vue';
import { useNow } from './session/useNow';
import BackwardPlanSummary from './preview/BackwardPlanSummary.vue';
import {
  defaultSelectedBufferMinutes,
  defaultSelectedDeadline,
  isDateInTomorrow,
  originalIsExpiredOf,
  originalSuggestedStartOf,
  previewStatus,
} from './preview/helpers';

const store = useRoutineStore();
const router = useRouter();
const now = useNow(1000);

const activeTemplate = computed(() => store.pendingTemplate);

// Swift 的 `selectedDeadline` / `selectedBufferMinutes` 是 @State，构造时算一次；
// web 端同样只在 setup 期算一次（之后随用户输入变）。直接进 /preview（无待预览模板）时
// 先回落一个值，`onMounted` 会把它重定向回首页。
const initialNow = new Date();
const selectedDeadline = ref<Date>(
  store.pendingTemplate ? defaultSelectedDeadline(store.pendingTemplate, initialNow) : initialNow,
);
const selectedBufferMinutes = ref<number>(
  store.pendingTemplate ? defaultSelectedBufferMinutes(store.pendingTemplate) : 0,
);
const busy = ref(false);

onMounted(() => {
  if (!store.pendingTemplate) {
    void router.replace('/');
  }
});

/** `selectedBuffer = selectedBufferMinutes * 60`（Swift 657–659）。 */
const selectedBuffer = computed(() => selectedBufferMinutes.value * 60);

/** 原计划截止（Swift 631–633）：`deadline(on:) ?? selectedDeadline`。 */
const originalDeadline = computed<Date>(() => {
  const t = activeTemplate.value;
  if (!t) {
    return selectedDeadline.value;
  }
  return deadlineOn(t, now.value, DEFAULT_TIME_ZONE) ?? selectedDeadline.value;
});

/** 原计划建议开始（Swift 635–637）。 */
const originalSuggestedStart = computed<Date>(() => {
  const t = activeTemplate.value;
  if (!t) {
    return originalDeadline.value;
  }
  return originalSuggestedStartOf(t, originalDeadline.value);
});

/** 状态行（Swift 661–702）。 */
const status = computed(() => {
  const t = activeTemplate.value;
  if (!t) {
    return { message: '', symbol: 'target', isRed: false };
  }
  return previewStatus(t, now.value, originalDeadline.value, originalSuggestedStart.value);
});

const originalIsExpired = computed(() => {
  const t = activeTemplate.value;
  return t ? originalIsExpiredOf(t, originalDeadline.value, now.value) : false;
});

/** `明天原定…` / `今天原定…`（Swift 643–648）。 */
const originalDayLabel = computed(() => {
  const node = activeTemplate.value ? deadlineStep(activeTemplate.value)?.title ?? '截止' : '截止';
  return isDateInTomorrow(originalDeadline.value, now.value)
    ? `明天原定${node}`
    : `今天原定${node}`;
});

/** `单次计划已过期` / `按固定机动时间倒推`（Swift 650–655）。 */
const originalPlanCaption = computed(() =>
  originalIsExpired.value ? '单次计划已过期' : '按固定机动时间倒推',
);

/** `本次{deadlineStep?.title ?? "截止"}时间`（Swift 546）。 */
const deadlineLabel = computed(() => {
  const node = activeTemplate.value ? deadlineStep(activeTemplate.value)?.title ?? '截止' : '截止';
  return `本次${node}时间`;
});

const forwardSteps = computed(() =>
  activeTemplate.value ? taskSteps(activeTemplate.value) : [],
);

/** `<input type="time">` ↔ Date 双向绑定（只取时分），对应 Swift `.compact` DatePicker。 */
const selectedDeadlineTime = computed<string>({
  get: () => formatClock(selectedDeadline.value),
  set: (value: string) => {
    const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
    const next = new Date(selectedDeadline.value);
    next.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
    selectedDeadline.value = next;
  },
});

/** 三个进入按钮共用的落地：等 core 就绪 → `store.start`（带 override）→ 进会话页。 */
async function enter(deadlineOverride: Date | null, bufferOverride: number | null): Promise<void> {
  const t = activeTemplate.value;
  if (!t || busy.value) {
    return;
  }
  busy.value = true;
  try {
    await store.ensureReady();
  } catch {
    store.notice = '数据还没准备好，请稍后再试。';
    busy.value = false;
    return;
  }
  store.start(t, { deadlineOverride, bufferOverride });
  void router.push('/session');
}

function enterCurrentPlan(): void {
  void enter(selectedDeadline.value, selectedBuffer.value);
}

function enterOriginalPlan(): void {
  const t = activeTemplate.value;
  if (!t) {
    return;
  }
  void enter(originalDeadline.value, t.buffer);
}

function enterForward(): void {
  void enter(null, null);
}

function goBack(): void {
  void router.push('/');
}
</script>
