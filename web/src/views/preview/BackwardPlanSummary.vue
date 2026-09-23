<template>
  <!--
    BackwardPlanSummary（iOS/ContentView.swift 714–782）
    倒推摘要：倒推开始 / 本次预留缓冲 + 逐行（deadline 行 flag 红，其余 circle 次级）。
  -->
  <div class="mm-summary" data-testid="backward-summary">
    <div class="mm-summary__row">
      <span class="mm-hint">倒推开始</span>
      <span class="mm-mono">{{ formatClock(planStart(template, deadline, buffer)) }}</span>
    </div>
    <div class="mm-summary__row">
      <span class="mm-hint">本次预留缓冲</span>
      <span class="mm-mono">{{ formatMinutes(buffer) }}</span>
    </div>

    <div v-for="row in rows" :key="row.id" class="mm-plan-row">
      <SessionIcon
        :name="row.isDeadline ? 'flag' : 'circle'"
        :size="13"
        :style="{ color: row.isDeadline ? 'var(--mm-red)' : 'var(--mm-ink-soft)' }"
      />
      <span class="mm-plan-row__title">{{ row.title }}</span>
      <span class="mm-plan-row__time mm-mono">{{ formatClock(row.time) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatMinutes, type RoutineTemplate } from '../../stores/routine';
import { formatClock } from '../session/helpers';
import SessionIcon from '../session/SessionIcon.vue';
import { planRows, planStart, type PlanRow } from './helpers';

const props = defineProps<{
  template: RoutineTemplate;
  deadline: Date;
  buffer: number;
}>();

const rows = computed<PlanRow[]>(() => planRows(props.template, props.deadline, props.buffer));
</script>
