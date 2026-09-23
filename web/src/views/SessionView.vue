<template>
  <!--
    SessionView —— 会话页，逐字对齐 iOS/ContentView.swift 的「执行中」分支（46–235）。

    结构：工具栏（返回/结束）→ 两栏（ActiveFocusCard ｜ PlanImpactCard + TimelineCard）
    → 结束确认弹层 → 完成结算浮层。

    与 Swift 的差异：Swift 把任务线列表与执行中放在同一个 NavigationStack 里按
    `session.state` 切换；Web 拆成 `/`（HomeView）与 `/session`（本页）两条路由，
    故状态切到 completed/cancelled 后由本页负责导航回首页。
  -->
  <div>
    <header class="mm-toolbar">
      <span class="mm-toolbar__side">
        <button v-if="showBack" class="mm-btn mm-btn--secondary" @click="onCancel">返回</button>
      </span>
      <span class="mm-title">{{ isRunning ? '执行中' : '不跑偏' }}</span>
      <span class="mm-toolbar__side mm-toolbar__side--end">
        <button v-if="showEnd" class="mm-btn mm-btn--danger" @click="showsEndConfirmation = true">
          结束
        </button>
      </span>
    </header>

    <main class="mm-page" style="max-width: 1180px">
      <p v-if="!session" class="mm-hint" data-testid="no-session">当前没有进行中的任务线。</p>

      <div v-else class="mm-session-grid">
        <ActiveFocusCard :now="now" />
        <div class="mm-session-col">
          <PlanImpactCard :now="now" />
          <TimelineCard :now="now" />
        </div>
      </div>
    </main>

    <!-- 结束确认（对应 .confirmationDialog，111–122） -->
    <div
      v-if="showsEndConfirmation"
      class="mm-modal-backdrop"
      @click.self="showsEndConfirmation = false"
    >
      <div class="mm-modal mm-modal--dialog">
        <h4>确定结束当前任务线吗？</h4>
        <p class="mm-hint">当前进度会停止，之后可以重新选择任务线。</p>
        <div class="mm-actions mm-actions--end">
          <button class="mm-btn mm-btn--secondary" @click="showsEndConfirmation = false">
            继续执行
          </button>
          <button class="mm-btn mm-btn--danger" @click="confirmEnd">结束并退出</button>
        </div>
      </div>
    </div>

    <!-- 完成结算浮层（对应 ContentView 66–71 / 123–131） -->
    <CompletionResultOverlay
      v-if="completionResult"
      :result="completionResult"
      @dismiss="dismissCompletion"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useRoutineStore } from '../stores/routine';
import ActiveFocusCard from './session/ActiveFocusCard.vue';
import CompletionResultOverlay from './session/CompletionResultOverlay.vue';
import PlanImpactCard from './session/PlanImpactCard.vue';
import TimelineCard from './session/TimelineCard.vue';
import { makeCompletionResult, type CompletionResult } from './session/helpers';
import { useNow } from './session/useNow';

const store = useRoutineStore();
const router = useRouter();

/** 每秒刷新（对应各卡片的 TimelineView(.periodic by: 1)）；整个会话页共用一个源。 */
const now = useNow();

const session = computed(() => store.session);
const isRunning = computed(() => session.value?.state === 'running');

/**
 * 工具栏左侧「返回」：Swift 在「running 且无当前任务」时显示；Web 额外在非运行态
 * （结算浮层已关或会话已结束）也保留一个回首页的入口。
 */
const showBack = computed(() => !isRunning.value || store.currentProgress === null);
/** 工具栏右侧「结束」：Swift 仅在「running 且有当前任务」时显示。 */
const showEnd = computed(() => isRunning.value && store.currentProgress !== null);

const showsEndConfirmation = ref(false);
const completionResult = ref<CompletionResult | null>(null);
/** 同一次会话只弹一次（对应 Swift `lastPresentedCompletionID`）。 */
const lastPresentedCompletionID = ref<string | null>(null);

onMounted(() => {
  // 会话页动作 core 状态机前先确保初始化完成（web 特有的异步 init 窗口）。
  void store.ensureReady();
});

// 对应 Swift `.onChange(of: store.session?.state.rawValue)`（123–131）。
watch(
  () => session.value?.state,
  (state) => {
    const active = session.value;
    if (state === 'completed' && active && active.id !== lastPresentedCompletionID.value) {
      lastPresentedCompletionID.value = active.id;
      completionResult.value = makeCompletionResult(active, new Date());
    }
  },
  { immediate: true },
);

function onCancel(): void {
  void cancelAndExit();
}

function confirmEnd(): void {
  showsEndConfirmation.value = false;
  void cancelAndExit();
}

/** 取消/结束都要动作 core 状态机；先确保 init 完成（web 特有的异步窗口）。 */
async function cancelAndExit(): Promise<void> {
  try {
    await store.ensureReady();
    store.cancel();
  } catch {
    store.notice = '数据还没准备好，请稍后再试。';
  }
  void router.push('/');
}

function dismissCompletion(): void {
  completionResult.value = null;
  // 会话已非运行态（Swift 此时会切回任务线列表）→ 回首页。
  if (!isRunning.value) {
    void router.push('/');
  }
}
</script>
