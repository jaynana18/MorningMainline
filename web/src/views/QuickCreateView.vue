<template>
  <div>
    <header class="mm-toolbar">
      <button class="mm-btn mm-btn--secondary" @click="onCancel">取消</button>
      <span class="mm-title">一句话创建</span>
      <button class="mm-btn mm-btn--primary" :disabled="generated === null" @click="onSave">
        保存
      </button>
    </header>

    <main class="mm-page" style="max-width: 720px">
      <!-- ① 输入区 -->
      <section class="mm-section">
        <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">写下要做的事</div>
        <textarea
          v-model="input"
          class="mm-textarea"
          data-testid="create-input"
        ></textarea>
        <!-- 示例文案：与 iOS 版一致，只在编辑器下方出现一次（原版 TextEditor 无 placeholder）。 -->
        <p class="mm-hint" style="margin-top: 8px">
          例：18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟
        </p>
        <p style="color: var(--mm-orange); font-size: 12px; display: flex; align-items: center; gap: 4px">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" stroke-width="1.3" />
            <path d="M3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5M8 12.5V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <span>也可以点系统键盘的麦克风直接说</span>
        </p>
        <!-- footer 文案（逐字） -->
        <p class="mm-hint">截止时间可以直接写进去，比如「18点30结束」；生成后也能手动调整。</p>
      </section>

      <!-- ② 计划设置（仅「重复」选择） -->
      <section class="mm-section">
        <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">计划设置</div>
        <div class="mm-row">
          <span>重复</span>
          <span class="mm-seg">
            <button
              v-for="option in RECURRENCES"
              :key="option"
              class="mm-seg__item"
              :class="{ 'mm-seg__item--active': recurrence === option }"
              @click="recurrence = option"
            >
              {{ RECURRENCE_TITLES[option] }}
            </button>
          </span>
        </div>
      </section>

      <!-- ③ 生成按钮 -->
      <section class="mm-section">
        <button
          class="mm-btn mm-btn--primary"
          style="width: 100%"
          :disabled="input.trim() === '' || isParsing"
          data-testid="generate"
          @click="generate"
        >
          <span v-if="isParsing">正在识别…</span>
          <span v-else>生成任务线</span>
        </button>
      </section>

      <!-- ④ 生成后才出现的截止时间区（④ 与 ⑤ 均在 generated 非空时渲染） -->
      <template v-if="generated !== null">
        <section class="mm-section" data-testid="deadline-section">
          <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">截止时间</div>
          <label class="mm-toggle">
            <input v-model="hasDeadline" type="checkbox" data-testid="deadline-toggle" />
            <span>设置截止时间</span>
          </label>

          <div v-if="hasDeadline" style="margin-top: 10px">
            <input v-model="deadlineTime" type="time" class="mm-textarea" style="min-height: 0" />
            <p class="mm-hint">设置后，会按截止时间倒推出应该开始的时间。</p>
          </div>
          <p v-else class="mm-hint">不设置时，进入任务线后由你选择第一项开始正计时。</p>
        </section>

        <!-- ⑤ 预览区（不重复展示截止时间行） -->
        <section class="mm-section" data-testid="preview-section">
          <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">预览</div>
          <div class="mm-preview-item">
            <span class="mm-inline">
              <SessionIcon :name="iconNameForSymbol(generated.symbol)" :size="14" />
              {{ generated.name }}
            </span>
          </div>
          <div class="mm-preview-item">
            <span>重复</span>
            <span class="mm-hint">{{ recurrenceTitle }}</span>
          </div>
          <div class="mm-preview-item">
            <span>计时方式</span>
            <span class="mm-hint">{{ modeTitle }}</span>
          </div>
          <div v-for="step in generated.steps" :key="step.id" class="mm-preview-item">
            <span>{{ step.title }}</span>
            <span class="mm-hint">
              {{ step.role === 'deadline' ? '硬节点' : formatMinutes(step.duration) }}
            </span>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  RECURRENCES,
  RECURRENCE_TITLES,
  formatMinutes,
  useRoutineStore,
  type Recurrence,
  type RoutineStep,
  type RoutineTemplate,
} from '../stores/routine';
import { iconNameForSymbol } from './session/helpers';
import SessionIcon from './session/SessionIcon.vue';

const store = useRoutineStore();
const router = useRouter();

const input = ref('');
/** 解析出的任务步骤；改截止时间/重复方式时据此重算模板，避免重走解析。 */
const parsedSteps = ref<RoutineStep[]>([]);
const generated = ref<RoutineTemplate | null>(null);
const isParsing = ref(false);
/** 截止时间默认关闭（没识别到截止时间时保持关闭态）。 */
const hasDeadline = ref(false);
const selectedDeadline = ref<Date>(new Date());
const recurrence = ref<Recurrence>('once');

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `<input type="time">` ↔ Date 的双向绑定（只取时分）。 */
const deadlineTime = computed<string>({
  get: () => `${pad(selectedDeadline.value.getHours())}:${pad(selectedDeadline.value.getMinutes())}`,
  set: (value: string) => {
    const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
    const next = new Date(selectedDeadline.value);
    next.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
    selectedDeadline.value = next;
  },
});

const recurrenceTitle = computed(() =>
  generated.value ? RECURRENCE_TITLES[generated.value.recurrence ?? 'once'] : '',
);
const modeTitle = computed(() =>
  generated.value?.mode === 'backward' ? '按截止时间倒推' : '开始后正计时',
);

async function generate(): Promise<void> {
  isParsing.value = true;
  try {
    const result = await store.parse(input.value);
    if (!result.hasSteps) {
      parsedSteps.value = [];
      generated.value = null;
      return;
    }
    // 模型/规则没给出截止时间时，store.parse 已用 inferredDeadline 回落。
    const resolved = result.deadline;
    parsedSteps.value = result.steps;
    hasDeadline.value = resolved !== null;
    if (resolved) {
      selectedDeadline.value = resolved;
    }
    rebuild();
  } finally {
    isParsing.value = false;
  }
}

/** 只重算模板，不碰解析结果 —— 改截止时间/重复方式都走这里，绝不丢掉已解析步骤。 */
function rebuild(): void {
  if (parsedSteps.value.length === 0) {
    generated.value = null;
    return;
  }
  try {
    generated.value = store.createTemplate(input.value, {
      deadline: hasDeadline.value ? selectedDeadline.value : null,
      recurrence: recurrence.value,
    });
  } catch {
    generated.value = null;
  }
}

// 改截止时间 / 重复方式 → 即时重算且保留已解析步骤。
watch([hasDeadline, selectedDeadline, recurrence], () => {
  if (generated.value !== null) {
    rebuild();
  }
});

// 输入变化 → 上次生成结果作废（截止时间区随之收回）。
watch(input, () => {
  parsedSteps.value = [];
  generated.value = null;
});

async function onSave(): Promise<void> {
  if (!generated.value) {
    void router.push('/');
    return;
  }
  // 保存要落到 core 状态机（addTemplate → requireRoutine）；解析/生成都不需要它，
  // 所以只有这一步必须等 init 完成（web 特有：routine 实例是异步建的）。
  try {
    await store.ensureReady();
  } catch {
    store.notice = '数据还没准备好，请稍后再试。';
    return;
  }
  store.addTemplate(generated.value);
  // 保存后进预览页（选本次计划 / 原计划），对齐 Swift `selectedTemplate = template`。
  store.selectTemplate(generated.value);
  void router.push('/preview');
}

function onCancel(): void {
  void router.push('/');
}
</script>
