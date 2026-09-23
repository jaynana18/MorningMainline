<template>
  <div>
    <header class="mm-toolbar">
      <span class="mm-title">不跑偏</span>
      <button class="mm-btn mm-btn--primary" @click="goCreate">✦ 一句话创建</button>
    </header>

    <main class="mm-page">
      <!-- TaskLinesHero -->
      <section class="mm-hero">
        <div class="mm-hero__title">今天，先守住一条主线</div>
        <div class="mm-hero__subtitle">不用变成完美的 J 人，只要别让最重要的事跑偏。</div>
      </section>

      <div class="mm-row" style="margin-top: 22px">
        <span style="font-weight: 700">快速开始</span>
        <span class="mm-hint">选择一条主线</span>
      </div>

      <p v-if="!store.ready" class="mm-hint">正在载入…</p>

      <!-- TaskLineCard 列表 -->
      <div class="mm-grid">
        <button
          v-for="(template, index) in store.templates"
          :key="template.id"
          class="mm-card"
          :style="{ background: cardColor(index) }"
          @click="startTemplate(template)"
        >
          <span class="mm-card__name">{{ template.name }}</span>
          <span class="mm-card__summary">{{ summaryOf(template) }}</span>
          <span class="mm-card__meta">
            <span v-if="template.mode === 'backward'">↩ 倒推计划</span>
            <span v-else>↪ 正计时</span>
            <span style="margin-left: auto">→</span>
          </span>
        </button>
      </div>

      <!-- 一句话新建任务线 -->
      <button
        class="mm-card"
        style="
          margin-top: 12px;
          background: var(--mm-soft-sky);
          min-height: 0;
          flex-direction: row;
          align-items: center;
          width: 100%;
        "
        @click="goCreate"
      >
        <span style="flex: 1; text-align: left">
          <span class="mm-card__name">一句话新建任务线</span>
          <br />
          <span class="mm-card__summary">说清任务和时长，其他交给我</span>
        </span>
        <span>→</span>
      </button>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import {
  deadlineStep,
  formatMinutes,
  totalTaskDuration,
  useRoutineStore,
  type RoutineTemplate,
} from '../stores/routine';

const store = useRoutineStore();
const router = useRouter();

const CARD_COLORS = [
  'var(--mm-soft-sky)',
  'var(--mm-cream)',
  'var(--mm-soft-olive)',
  '#fbcbb0',
] as const;

function cardColor(index: number): string {
  return CARD_COLORS[index % CARD_COLORS.length];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 复刻 `TaskLineCard.summary` 的两种文案。 */
function summaryOf(template: RoutineTemplate): string {
  if (template.deadlineHour !== null && template.deadlineMinute !== null) {
    const departure = deadlineStep(template)?.title ?? '完成';
    return `${pad(template.deadlineHour)}:${pad(template.deadlineMinute)} 前${departure} · 倒推计划`;
  }
  return `${template.steps.length} 个步骤 · 预计 ${formatMinutes(totalTaskDuration(template))}`;
}

function goCreate(): void {
  void router.push('/create');
}

function startTemplate(template: RoutineTemplate): void {
  store.start(template);
  void router.push('/session');
}
</script>
