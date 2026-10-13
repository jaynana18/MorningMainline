<template>
  <div class="home-view">
    <header class="mm-toolbar">
      <span class="mm-title mm-inline"><span class="home-brand"><SessionIcon name="target" :size="20" /></span>不跑偏</span>
      <button class="mm-btn mm-btn--primary" @click="goCreate">
        <span class="mm-inline"><SessionIcon name="sparkles" :size="15" />一句话创建</span>
      </button>
    </header>

    <main class="mm-page">
      <!-- TaskLinesHero -->
      <section class="mm-hero">
        <div class="mm-eyebrow">让时间看得见</div>
        <div class="mm-hero__title">今天，先守住<br />一条主线</div>
        <div class="mm-hero__subtitle">先定好终点，开始的时间交给我们。</div>
        <div class="home-hero-art" aria-hidden="true"><div></div><div></div><div></div></div>
      </section>

      <button v-if="store.session?.state === 'running'" class="home-resume" @click="router.push('/session')">
        <span class="home-resume__icon"><SessionIcon name="clock" :size="22" /></span>
        <span><small>正在进行</small><b>{{ store.session.templateName }}</b></span>
        <SessionIcon name="chevron-right" :size="16" />
      </button>

      <div class="mm-row" style="margin-top: 22px">
        <span style="font-weight: 700">我的任务线</span>
        <span class="mm-hint">{{ store.templates.length }} 条计划</span>
      </div>

      <p v-if="!store.ready" class="mm-hint" data-testid="home-loading">正在载入…</p>

      <!-- TaskLineCard 列表。
           init 完成前不渲染：store 创建时 templates 已带内置种子，
           提前渲染会先闪一帧种子模板（用户自建的可能不同），且点击会撞上未建好的 core 状态机。 -->
      <div v-else class="mm-grid">
        <div
          v-for="(template, index) in store.templates"
          :key="template.id"
          class="mm-card home-task-card"
          :style="{ '--task-accent': cardColor(index) }"
          @click="startTemplate(template)"
          role="button"
          tabindex="0"
          @keydown.enter.self="startTemplate(template)"
          @keydown.space.self.prevent="startTemplate(template)"
        >
          <button class="mm-btn mm-btn--secondary mm-card-delete" :aria-label="`删除${template.name}`" @click.stop="deletingTemplate = template">
            <SessionIcon name="trash" :size="15" />
          </button>
          <span class="mm-card__symbol">
            <SessionIcon :name="iconNameForSymbol(template.symbol)" :size="22" />
          </span>
          <span class="mm-card__name">{{ template.name }}</span>
          <span class="mm-card__summary">{{ summaryOf(template) }}</span>
          <CommuteMap v-if="template.commute" :route="template.commute" />
          <span class="mm-card__meta">
            <span v-if="template.mode === 'backward'">↩ 倒推计划</span>
            <span v-else>↪ 正计时</span>
            <span style="margin-left: auto">→</span>
          </span>
        </div>
      </div>
      <p v-if="store.ready && !store.templates.length" class="mm-hint">还没有任务线，试试一句话创建。</p>

      <!-- 一句话新建任务线 -->
      <button
        class="mm-card home-create-card"
        style="
          margin-top: 12px;
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
    <div v-if="deletingTemplate" class="mm-modal-backdrop" @click.self="deletingTemplate = null" @keydown.esc="deletingTemplate = null">
      <section class="mm-modal mm-modal--dialog" role="dialog" aria-modal="true" aria-label="删除任务线">
        <h4>删除「{{ deletingTemplate.name }}」？</h4>
        <p class="mm-hint">删除后会从任务列表和同步数据中移除。已经开始的执行进度会保留。</p>
        <div class="mm-actions mm-actions--end">
          <button class="mm-btn mm-btn--secondary" @click="deletingTemplate = null">取消</button>
          <button class="mm-btn mm-btn--danger" @click="confirmDelete">删除</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ref } from 'vue';
import {
  deadlineStep,
  formatMinutes,
  totalTaskDuration,
  useRoutineStore,
  type RoutineTemplate,
} from '../stores/routine';
import { iconNameForSymbol } from './session/helpers';
import SessionIcon from './session/SessionIcon.vue';
import CommuteMap from './CommuteMap.vue';

const store = useRoutineStore();
const router = useRouter();
const deletingTemplate = ref<RoutineTemplate | null>(null);
function confirmDelete(): void {
  if (!deletingTemplate.value) return;
  store.deleteTemplate(deletingTemplate.value.id);
  deletingTemplate.value = null;
}

const CARD_COLORS = [
  '#548bd4', '#69a28e', '#9a8bbe', '#bb9583',
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

<style scoped>
.mm-card { position: relative; }
.home-brand { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: var(--mm-primary-soft); color: var(--mm-primary); margin-right: 4px; }
.mm-hero { position: relative; min-height: 210px; padding: 30px; overflow: hidden; background: linear-gradient(120deg, #edf4ff, #f1f6fc 65%, #e9f0fd); border: 1px solid #e5edfa; box-shadow: none; border-radius: 26px; }
.mm-hero__title { position: relative; z-index: 1; margin-top: 12px; font-size: 31px; line-height: 1.32; letter-spacing: -.04em; color: #324c73; }
.mm-hero__subtitle { position: relative; z-index: 1; font-size: 12px; color: #8196b5; max-width: none; margin-top: 12px; }
.home-hero-art { position: absolute; right: 35px; top: 34px; display: flex; align-items: center; gap: 12px; transform: rotate(-18deg); opacity: .7; }
.home-hero-art div { width: 44px; height: 138px; border-radius: 999px; background: #dce8fa; overflow: hidden; }
.home-hero-art div::before { content: ''; display: block; height: 62%; background: #86b1ee; border-radius: 999px 999px 0 0; }
.home-hero-art div:nth-child(2) { height: 176px; background: #e6ebf7; }
.home-hero-art div:nth-child(2)::before { height: 35%; background: #b0a9cf; }
.home-hero-art div:nth-child(3) { height: 110px; }
.home-hero-art div:nth-child(3)::before { height: 90%; background: #a4c7c2; }
.mm-grid { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.home-task-card { display: grid; grid-template-columns: 44px minmax(0, 1fr); align-content: start; gap: 5px 14px; padding: 22px; min-height: 158px; background: #fff; border: 1px solid var(--mm-border); box-shadow: var(--mm-shadow); transition: border-color .2s, transform .2s; }
.home-task-card:hover { border-color: #c9daf3; transform: translateY(-2px); }
.home-task-card .mm-card__symbol { grid-row: 1 / 3; background: #f4f7fc; color: var(--task-accent); }
.home-task-card .mm-card__name { padding-right: 24px; font-size: 15px; font-weight: 700; line-height: 1.5; }
.home-task-card .mm-card__summary { grid-column: 2; color: #91a0b4; font-size: 11px; }
.home-task-card :deep(.commute-map) { grid-column: 2; margin-top: 8px; }
.home-task-card .mm-card__meta { grid-column: 2; color: var(--task-accent); font-size: 10px; padding-top: 12px; }
.mm-card-delete { position: absolute; top: 16px; right: 12px; width: 28px; min-height: 28px; padding: 0; background: none; color: #adb8c7; }
.mm-card-delete:hover { background: #fff0f0; color: var(--mm-red); }
.home-create-card { background: none; border: 1px dashed #ccd8eb; box-shadow: none; padding: 20px; }
.home-create-card .mm-card__name { font-size: 13px; font-weight: 650; }
.home-create-card .mm-card__summary { color: #91a0b4; font-size: 11px; }
.home-create-card .mm-card__symbol { color: var(--mm-primary); background: var(--mm-primary-soft); }
.home-resume { display: flex; align-items: center; width: 100%; gap: 14px; margin-top: 16px; padding: 16px 18px; border: 1px solid #deebfc; border-radius: 18px; background: #fff; color: var(--mm-ink); text-align: left; cursor: pointer; }
.home-resume__icon { display: grid; place-items: center; width: 42px; height: 42px; background: var(--mm-primary-soft); color: var(--mm-primary); border-radius: 13px; }
.home-resume span:nth-child(2) { flex: 1; }
.home-resume small, .home-resume b { display: block; }
.home-resume small { font-size: 10px; color: var(--mm-primary); }
.home-resume b { font-size: 13px; font-weight: 650; margin-top: 3px; }
@media (max-width: 620px) { .home-hero-art { right: 14px; opacity: .4; gap: 8px; } .home-hero-art div { width: 30px; } .mm-hero { padding: 24px; } .mm-hero__title { font-size: 28px; } .mm-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
