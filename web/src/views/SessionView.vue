<template>
  <div>
    <header class="mm-toolbar">
      <button class="mm-btn mm-btn--secondary" @click="onExit">返回</button>
      <span class="mm-title">执行中</span>
      <button class="mm-btn mm-btn--danger" @click="onFinish">结束</button>
    </header>

    <main class="mm-page" style="max-width: 720px">
      <p v-if="!session" class="mm-hint">当前没有进行中的任务线。</p>

      <template v-else>
        <section class="mm-section">
          <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">
            {{ session.templateName }}
          </div>

          <!-- ActiveFocusCard（P1b 补全细节，此处先给出可用骨架） -->
          <div v-if="store.currentProgress" class="mm-card" style="background: var(--mm-cream)">
            <span class="mm-card__name">正在做：{{ store.currentProgress.step.title }}</span>
            <span class="mm-card__summary">
              预计 {{ formatHM(store.currentProgress.dueAt) }} 完成
            </span>
            <div style="display: flex; gap: 10px; margin-top: auto">
              <button class="mm-btn mm-btn--primary" @click="completeCurrent">完成</button>
              <button class="mm-btn mm-btn--secondary" @click="store.snoozeCurrent()">
                稍后提醒
              </button>
            </div>
          </div>
          <div v-else class="mm-card" style="background: var(--mm-soft-sky)">
            <span class="mm-card__name">选择一项开始</span>
            <span class="mm-card__summary">点下面的任务开始正计时</span>
          </div>
        </section>

        <!-- TimelineCard（P1b 补全） -->
        <section class="mm-section">
          <div class="mm-hint" style="font-weight: 700; margin-bottom: 8px">时间线</div>
          <div v-for="item in session.progress" :key="item.id" class="mm-preview-item">
            <span>
              <span v-if="item.state === 'active'">▶ </span>
              {{ item.step.title }}
            </span>
            <span class="mm-hint">
              {{ item.step.role === 'deadline' ? '硬节点' : formatHM(item.dueAt) }}
            </span>
            <button
              v-if="item.state === 'pending'"
              class="mm-btn mm-btn--secondary"
              style="padding: 6px 10px"
              @click="store.startProgress(item)"
            >
              开始
            </button>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useRoutineStore } from '../stores/routine';

const store = useRoutineStore();
const router = useRouter();

const session = computed(() => store.session);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatHM(date: Date): string {
  return `${date.getHours()}:${pad(date.getMinutes())}`;
}

function completeCurrent(): void {
  const current = store.currentProgress;
  if (current) {
    store.complete(current);
  }
}

function onFinish(): void {
  store.cancel();
  void router.push('/');
}

function onExit(): void {
  void router.push('/');
}
</script>
