<template>
  <div class="app-shell app-shell--navigation">
    <p v-if="!account.ready" class="mm-hint" style="padding: 24px">正在连接账号…</p>
    <AccountView v-else-if="!account.user" />
    <template v-else>
      <div v-if="account.conflict" class="mm-section">
        <p>另一台设备有新数据。本机改动已保留，请选择此次保留哪一份：</p>
        <button class="mm-btn mm-btn--secondary" @click="resolveConflict('cloud')">使用服务器数据</button>
        <button class="mm-btn mm-btn--secondary" @click="resolveConflict('local')">用本机数据替换服务器</button>
      </div>
      <router-view />
      <router-view name="drawer" v-slot="{ Component }">
        <Teleport to="body">
          <Transition name="create-drawer">
            <div v-if="Component" class="create-drawer-backdrop" @click.self="router.push('/')" @keydown.esc.stop="router.push('/')">
              <section class="create-drawer-panel" role="dialog" aria-modal="true" aria-label="一句话创建">
                <div class="create-drawer-handle" aria-hidden="true"></div>
                <component :is="Component" />
              </section>
            </div>
          </Transition>
        </Teleport>
      </router-view>
    </template>

    <Teleport to="body">
      <nav class="app-bottom-bar" aria-label="底部导航">
        <button class="app-bottom-tab" :class="{ active: route.name !== 'profile' }" :aria-current="route.name !== 'profile' ? 'page' : undefined" @click="router.push('/')">
          <SessionIcon name="clock" :size="25" /><span>任务</span>
        </button>
        <button class="app-create-button" aria-label="一句话创建" @click="router.push('/create')"><SessionIcon name="plus" :size="34" /></button>
        <button class="app-bottom-tab" :class="{ active: route.name === 'profile' }" :aria-current="route.name === 'profile' ? 'page' : undefined" @click="router.push('/profile')">
          <SessionIcon name="person" :size="25" /><span>个人中心</span>
        </button>
      </nav>
    </Teleport>

    <!--
      P3 应用内提醒弹窗（前台唯一提醒通道）。
      前台系统横幅已被抑制（原生 willPresent 返回 []、浏览器宿主 presentNotification
      前台直接 return），所以前台提醒完全依赖这个弹窗。必须放在根 .app-shell 内。
    -->
    <ReminderOverlay
      :message="reminders.active"
      :queue-depth="reminders.queue.length"
      @dismiss="reminders.dismiss()"
    />

    <!-- 全局降级/失败提示（如「已回退本机规则」）。 -->
    <transition name="toast">
      <div v-if="store.notice" class="toast" role="status" data-testid="notice">
        {{ store.notice }}
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useRoutineStore } from './stores/routine';
import { useRemindersStore } from './stores/reminders';
import ReminderOverlay from './views/reminder/ReminderOverlay.vue';
import { resolveFocusAction } from './views/reminder/helpers';
import AccountView from './views/AccountView.vue';
import { account, loadAccount } from './platform/account';
import SessionIcon from './views/session/SessionIcon.vue';

const store = useRoutineStore();
const reminders = useRemindersStore();
const router = useRouter();
const route = useRoute();

onMounted(async () => {
  await loadAccount();
  if (account.user) { await store.init(); void reminders.start(); }
});
function resolveConflict(choice: string): void { window.dispatchEvent(new CustomEvent('mm-resolve-sync', { detail: choice })); }
watch(() => !!account.user && route.name === 'create', open => {
  document.body.style.overflow = open ? 'hidden' : '';
}, { immediate: true });

onUnmounted(() => {
  document.body.style.overflow = '';
  reminders.stop();
});

/**
 * 通知点击回跳的导航：全局唯一入口（通知可能在任意路由到达，所以放在 App 层）。
 *
 * - `stale`：用户点的是已结束/已被替换的会话的通知，消费掉即可，不拉回前台。
 * - `navigate`：若当前不在会话页则跳过去；**不清** focusRequest，
 *   由 SessionView 挂载后消费（它要按 progressID 高亮并滚动到位）。
 */
watch(
  () => reminders.focusRequest,
  (request) => {
    const action = resolveFocusAction(request, {
      sessionID: store.session?.id ?? null,
      progressIDs: store.session?.progress.map((item) => item.id) ?? [],
    });
    if (action === 'stale') {
      // 那条会话已经结束/被替换，不能把它拉回前台；消费掉即可。
      reminders.clearFocusRequest();
      return;
    }
    if (action !== 'navigate') {
      return;
    }
    if (router.currentRoute.value.name !== 'session') {
      void router.push('/session');
    }
    // 不清 focusRequest：由 SessionView 挂载后消费。
  },
  { immediate: true },
);
</script>

<style>
.app-shell--navigation { padding-bottom: calc(98px + env(safe-area-inset-bottom)); }
.app-bottom-bar { position: fixed; z-index: 30; bottom: 0; left: 50%; transform: translateX(-50%); width: min(100%, 800px); display: grid; grid-template-columns: 1fr 100px 1fr; align-items: center; min-height: 72px; padding: 8px 16px calc(8px + env(safe-area-inset-bottom)); background: #fffffff5; border: 1px solid var(--mm-border); border-bottom: 0; border-radius: 22px 22px 0 0; box-shadow: 0 -4px 28px #24334b05; backdrop-filter: blur(16px); }
.app-bottom-tab { display: flex; align-items: center; flex-direction: column; gap: 5px; border: 0; background: none; color: #aaa; cursor: pointer; font-size: 11px; }
.app-bottom-tab.active { color: var(--mm-primary); }
.app-bottom-tab svg { padding: 5px; width: 34px; height: 34px; border-radius: 11px; }
.app-bottom-tab.active svg { background: var(--mm-primary-soft); }
.app-create-button { justify-self: center; display: grid; place-items: center; width: 62px; height: 62px; margin-top: -32px; border: 4px solid var(--mm-canvas); border-radius: 22px; background: var(--mm-primary); color: #fff; box-shadow: 0 8px 24px #4189eb26; cursor: pointer; }
.app-shell--navigation .mm-current-dock { bottom: calc(92px + env(safe-area-inset-bottom)); }
.app-shell--navigation .mm-taskline-screen { padding-bottom: 90px; }
.create-drawer-backdrop { position: fixed; inset: 0; z-index: 50; display: flex; align-items: flex-end; justify-content: center; background: #24334b4d; backdrop-filter: blur(5px); }
.create-drawer-panel { width: 100%; max-width: 800px; max-height: 92dvh; overflow-y: auto; overscroll-behavior: contain; border-radius: 26px 26px 0 0; background: var(--mm-canvas); padding-bottom: env(safe-area-inset-bottom); }
.create-drawer-handle { width: 44px; height: 5px; margin: 10px auto 5px; border-radius: 8px; background: #bfc4c9; }
.create-drawer-panel .mm-toolbar { border-bottom-width: 1px; }
.create-drawer-enter-active, .create-drawer-leave-active { transition: opacity .25s ease; }
.create-drawer-enter-active .create-drawer-panel, .create-drawer-leave-active .create-drawer-panel { transition: transform .25s ease; }
.create-drawer-enter-from, .create-drawer-leave-to { opacity: 0; }
.create-drawer-enter-from .create-drawer-panel, .create-drawer-leave-to .create-drawer-panel { transform: translateY(100%); }
@media (prefers-reduced-motion: reduce) { .create-drawer-enter-active, .create-drawer-leave-active, .create-drawer-enter-active .create-drawer-panel, .create-drawer-leave-active .create-drawer-panel { transition: none; } }
</style>
