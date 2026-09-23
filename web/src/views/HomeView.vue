<template>
  <div>
    <header class="mm-toolbar">
      <span class="mm-title">不跑偏</span>
      <button class="mm-btn mm-btn--primary" @click="goCreate">
        <span class="mm-inline"><SessionIcon name="sparkles" :size="15" />一句话创建</span>
      </button>
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

      <p v-if="!store.ready" class="mm-hint" data-testid="home-loading">正在载入…</p>

      <!-- TaskLineCard 列表。
           init 完成前不渲染：store 创建时 templates 已带内置种子，
           提前渲染会先闪一帧种子模板（用户自建的可能不同），且点击会撞上未建好的 core 状态机。 -->
      <div v-else class="mm-grid">
        <button
          v-for="(template, index) in store.templates"
          :key="template.id"
          class="mm-card"
          :style="{ background: cardColor(index) }"
          @click="startTemplate(template)"
        >
          <span class="mm-card__symbol">
            <SessionIcon :name="iconNameForSymbol(template.symbol)" :size="22" />
          </span>
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
          gap: 12px;
          width: 100%;
        "
        @click="goCreate"
      >
        <span class="mm-card__symbol mm-card__symbol--round">
          <SessionIcon name="sparkles" :size="18" />
        </span>
        <span style="flex: 1; text-align: left">
          <span class="mm-card__name">一句话新建任务线</span>
          <br />
          <span class="mm-card__summary">说清任务和时长，其他交给我</span>
        </span>
        <SessionIcon name="chevron-right" :size="16" />
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
import { iconNameForSymbol } from './session/helpers';
import SessionIcon from './session/SessionIcon.vue';

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

async function startTemplate(template: RoutineTemplate): Promise<void> {
  // init() 是异步的（要先读 deviceInfo / 已存快照），core 状态机此刻可能还没建好。
  // Swift 版 store 同步构造、无此窗口；web 端必须在这里等一次。
  try {
    await store.ensureReady();
  } catch {
    store.notice = '数据还没准备好，请稍后再试。';
    return;
  }
  // 点任务卡先进预览页（选本次计划 / 原计划），不直接开会话（对齐 Swift navigationDestination）。
  store.selectTemplate(template);
  void router.push('/preview');
}
</script>
