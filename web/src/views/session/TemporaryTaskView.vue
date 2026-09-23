<template>
  <!--
    TemporaryTaskView（ContentView.swift 1161–1221）
    临时加事：标题 + 预计分钟 + 影响预估，「加入并开始」→ store.addTemporaryTask(placement: .now)。
  -->
  <div class="mm-modal-backdrop" @click.self="$emit('close')">
    <div class="mm-modal" data-testid="temporary-task-view">
      <h4>临时加事</h4>

      <p class="mm-hint" style="margin: 10px 0 6px">临时加一件事</p>
      <input
        v-model="title"
        class="mm-input"
        type="text"
        placeholder="例如：找袜子 / 回一条消息"
      />
      <label class="mm-inline" style="margin-top: 10px; gap: 8px">
        <span style="font-size: 14px; font-weight: 600">预计</span>
        <input v-model.number="minutes" class="mm-input" type="number" min="1" max="60" />
        <span style="font-size: 14px">分钟</span>
      </label>

      <p class="mm-hint" style="margin: 14px 0 6px">执行方式</p>
      <p class="mm-inline" style="gap: 6px; margin: 0">
        <SessionIcon name="arrow-up" :size="14" />
        新任务会立即置顶并开始
      </p>
      <p class="mm-hint" style="margin: 6px 0 0">
        现在做到一半的任务会自动挂起；临时任务完成后，会自动回到原任务。
      </p>

      <p class="mm-hint" style="margin: 14px 0 4px">加入前先看影响</p>
      <p :style="{ color: impactIsLate ? 'var(--mm-red)' : 'var(--mm-ink-soft)' }" style="margin: 0">
        {{ impactText }}
      </p>

      <div class="mm-actions mm-actions--end">
        <button class="mm-btn mm-btn--secondary" @click="$emit('close')">取消</button>
        <button class="mm-btn mm-btn--primary" :disabled="title.trim() === ''" @click="add">
          加入并开始
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatMinutes, useRoutineStore } from '../../stores/routine';
import SessionIcon from './SessionIcon.vue';

const emit = defineEmits<{ close: [] }>();

const store = useRoutineStore();
const title = ref('');
const minutes = ref(5);

/** 逐字对应 Swift `impactIsLate`：原版 guard 后恒返回 false，这里保持同样效果。 */
const impactIsLate = computed(() => false);

/** 逐字对应 Swift `impactText`：`会让后续计划整体后移 X。` */
const impactText = computed(
  () => `会让后续计划整体后移 ${formatMinutes(minutes.value * 60)}。`,
);

function add(): void {
  store.addTemporaryTask(title.value, minutes.value, 'now');
  // 与 Swift `dismiss()` 对应：交给父组件关闭弹层。
  emit('close');
}
</script>
