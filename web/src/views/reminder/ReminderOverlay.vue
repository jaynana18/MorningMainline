<template>
  <!--
    ReminderOverlay —— P3 应用内提醒弹窗（前台唯一提醒通道）。
    ARCHITECTURE §6：前台横幅已被原生/浏览器宿主抑制，前台提醒完全依赖本弹窗。
    受控组件：不直接取 Pinia store，只吃 props / emit 事件，便于将来独立测试。
  -->
  <div v-if="message" class="mm-overlay" @click.self="emit('dismiss')">
    <div
      class="mm-reminder-card"
      :class="{ 'mm-reminder-card--overdue': message.sound === 'overdue' }"
      role="alertdialog"
      aria-live="assertive"
      data-testid="reminder-card"
    >
      <p class="mm-reminder__label" data-testid="reminder-label">{{ reminderHeading(message) }}</p>
      <h3 class="mm-reminder__title" data-testid="reminder-title">{{ message.title }}</h3>
      <p class="mm-reminder__body" data-testid="reminder-body">{{ message.body }}</p>
      <p v-if="message.minuteOffset !== null" class="mm-reminder__time">
        落在 {{ clock(message.fireAt) }}
      </p>
      <p v-if="(queueDepth ?? 0) > 0" class="mm-reminder__queue" data-testid="reminder-queue">
        还有 {{ queueDepth }} 条提醒
      </p>
      <button
        class="mm-btn mm-btn--primary"
        data-testid="reminder-dismiss"
        @click="emit('dismiss')"
      >
        知道了
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ReminderMessage } from '../../stores/reminders';
import { reminderHeading } from './helpers';

// 不绑定返回值：props 只在模板中使用，避免 noUnusedLocals 报未使用变量。
defineProps<{
  message: ReminderMessage | null;
  /** 队列里还有几条待显示。 */
  queueDepth?: number;
}>();

const emit = defineEmits<{ dismiss: [] }>();

/**
 * 把 fireAt 格式化为 `H:mm`。
 *
 * 刻意用 `getHours()` / `getMinutes()` 而非 `toLocaleTimeString()`：后者的输出
 * 随运行环境（locale / 时区 / ICU 数据）漂移，会把「跨端一致性测试」变成假绿。
 */
function clock(at: Date): string {
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
</script>
