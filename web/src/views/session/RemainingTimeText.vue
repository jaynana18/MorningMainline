<template>
  <!--
    RemainingTimeText（ContentView.swift 1148–1160）
    文案：`还有 X` / `已超时 X`（含秒）。
    颜色：< 0 秒 → 红；< 5 分钟 → 橙；否则墨色。
  -->
  <p class="mm-countdown" :style="{ color }" data-testid="remaining-time">{{ text }}</p>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatMinutes } from '../../stores/routine';

const props = defineProps<{
  dueAt: Date;
  now: Date;
}>();

/** 剩余秒数（可负）。对应 Swift `dueAt.timeIntervalSince(now)`。 */
const seconds = computed(() => (props.dueAt.getTime() - props.now.getTime()) / 1000);

const text = computed(() =>
  seconds.value >= 0
    ? `还有 ${formatMinutes(seconds.value, true)}`
    : `已超时 ${formatMinutes(-seconds.value, true)}`,
);

const color = computed(() => {
  if (seconds.value < 0) {
    return 'var(--mm-red)';
  }
  if (seconds.value < 5 * 60) {
    return 'var(--mm-orange)';
  }
  return 'var(--mm-ink)';
});
</script>
