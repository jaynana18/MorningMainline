<template>
  <!--
    PlanImpactCard（ContentView.swift 862–931）
    迟到/延误影响卡：预计结束 vs Deadline，可展开「计划详情」。
  -->
  <section
    v-if="session"
    class="mm-doodle"
    :style="{
      background: late ? 'rgba(246, 143, 110, 0.28)' : 'var(--mm-soft-sky)',
      padding: '20px',
      borderRadius: '22px',
    }"
    data-testid="plan-impact-card"
  >
    <h3 class="mm-headline">计划影响</h3>

    <div v-if="session.targetDeadline && estimated" class="mm-impact">
      <div>
        <p class="mm-hint">预计结束</p>
        <p class="mm-impact__time" :style="{ color: late ? 'var(--mm-red)' : 'inherit' }">
          {{ formatClock(estimated) }}
        </p>
      </div>
      <div style="text-align: right">
        <p class="mm-hint" style="font-size: 11px">Deadline</p>
        <p class="mm-mono">{{ formatClock(session.targetDeadline) }}</p>
        <p v-if="late" class="mm-badge" style="color: var(--mm-red)">
          晚 {{ formatMinutes(delaySeconds) }}
        </p>
        <p
          v-else-if="estimated.getTime() < session.targetDeadline.getTime()"
          class="mm-badge"
          style="color: var(--mm-olive)"
        >
          提前 {{ formatMinutes(advanceSeconds) }}
        </p>
      </div>
    </div>

    <button class="mm-disclosure" @click="showsPlanDetails = !showsPlanDetails">
      <SessionIcon :name="showsPlanDetails ? 'chevron-down' : 'chevron-right'" :size="12" />
      计划详情
    </button>

    <div v-if="showsPlanDetails" class="mm-impact__details">
      <p style="margin: 4px 0">已预留 {{ formatMinutes(session.remainingBuffer) }} 机动时间</p>
      <p class="mm-hint" style="margin: 0">
        这段时间不参与倒计时，也不会因延误而扣减。
      </p>
      <p v-if="overdue" class="mm-badge" style="color: var(--mm-red); margin-top: 5px">
        Deadline 已过，仍会持续提醒
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  estimatedCompletion,
  formatMinutes,
  isLate,
  useRoutineStore,
} from '../../stores/routine';
import { formatClock } from './helpers';
import SessionIcon from './SessionIcon.vue';

const props = defineProps<{ now: Date }>();

const store = useRoutineStore();
const showsPlanDetails = ref(false);

const session = computed(() => store.session);

/** session.estimatedCompletion(at:)。 */
const estimated = computed(() =>
  session.value ? estimatedCompletion(session.value, props.now) : null,
);

/** session.isLate(at:)。 */
const late = computed(() => (session.value ? isLate(session.value, props.now) : false));

/** isOverdue：targetDeadline 存在且 now > targetDeadline。 */
const overdue = computed(() => {
  const target = session.value?.targetDeadline;
  return target ? props.now.getTime() > target.getTime() : false;
});

/** 晚 X（estimated - target，秒）。 */
const delaySeconds = computed(() => {
  const target = session.value?.targetDeadline;
  if (!target || !estimated.value) {
    return 0;
  }
  return (estimated.value.getTime() - target.getTime()) / 1000;
});

/** 提前 X（target - estimated，秒）。 */
const advanceSeconds = computed(() => {
  const target = session.value?.targetDeadline;
  if (!target || !estimated.value) {
    return 0;
  }
  return (target.getTime() - estimated.value.getTime()) / 1000;
});
</script>
