<template>
  <!--
    PendingTaskReorderView（ContentView.swift 1101–1147）
    待办重排：Swift 用 List + `.onMove`（拖拽）；Web 用原生 HTML5 拖放 + 上/下按钮
    （键盘/无障碍可达），两者走同一个 `move()`。
  -->
  <div class="mm-modal-backdrop" @click.self="$emit('cancel')">
    <div class="mm-modal" data-testid="reorder-view">
      <h4>调整任务顺序</h4>
      <p class="mm-hint" style="margin: 4px 0 0">拖动调整待办顺序</p>

      <ul class="mm-reorder">
        <li
          v-for="(item, index) in rows"
          :key="item.id"
          class="mm-reorder__item"
          :class="{ 'mm-reorder__item--dragging': dragIndex === index }"
          draggable="true"
          @dragstart="dragIndex = index"
          @dragover.prevent="onDragOver(index)"
          @dragend="dragIndex = null"
        >
          <span class="mm-inline" style="flex: 1; gap: 8px">
            <SessionIcon :name="item.isTemporary ? 'sparkles' : 'circle'" :size="14" />
            {{ item.step.title }}
          </span>
          <span class="mm-hint">{{ formatMinutes(item.step.duration) }}</span>
          <span class="mm-inline" style="gap: 4px">
            <button
              class="mm-iconbtn"
              :disabled="index === 0"
              aria-label="上移"
              @click="move(index, index - 1)"
            >
              <SessionIcon name="chevron-up" :size="12" />
            </button>
            <button
              class="mm-iconbtn"
              :disabled="index === rows.length - 1"
              aria-label="下移"
              @click="move(index, index + 1)"
            >
              <SessionIcon name="chevron-down" :size="12" />
            </button>
          </span>
        </li>
      </ul>

      <div class="mm-actions mm-actions--end">
        <button class="mm-btn mm-btn--secondary" @click="$emit('cancel')">取消</button>
        <button class="mm-btn mm-btn--primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { formatMinutes, type StepProgress } from '../../stores/routine';
import SessionIcon from './SessionIcon.vue';

const props = defineProps<{ items: StepProgress[] }>();
const emit = defineEmits<{
  cancel: [];
  save: [ids: string[]];
}>();

/** 本地副本：Swift `@State private var items`（init 时拷贝传入项）。 */
const rows = ref<StepProgress[]>([...props.items]);
const dragIndex = ref<number | null>(null);

/** 把 from 位置的项移到 to 位置（对应 `items.move(fromOffsets:toOffset:)`）。 */
function move(from: number, to: number): void {
  if (to < 0 || to >= rows.value.length || from === to) {
    return;
  }
  const next = [...rows.value];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  rows.value = next;
}

function onDragOver(index: number): void {
  if (dragIndex.value === null || dragIndex.value === index) {
    return;
  }
  move(dragIndex.value, index);
  dragIndex.value = index;
}

function save(): void {
  emit('save', rows.value.map((item) => item.id));
}
</script>
