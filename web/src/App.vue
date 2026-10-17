<template>
  <div class="app-shell app-shell--navigation">
    <!-- 此时页面里没有任何带 `.mm-toolbar` 的视图，所以这条提示要自己避让状态栏。 -->
    <p v-if="!account.ready" class="mm-hint" style="padding: calc(24px + env(safe-area-inset-top)) 24px 24px">正在连接账号…</p>
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
  resumeRunningSession();
});

/**
 * 冷启动回落到「进行中」会话页（2026-10-14）。
 *
 * 场景：用户在执行任务途中退出 App / 关掉页面 / 手机锁屏后重开。此时首页虽然有一条
 * 「正在进行」的横幅入口，但用户还得自己再点一下 —— 而「正在执行的任务」本来就是
 * 这个 App 唯一的主角，回到 App 应当直接落在它上面。
 *
 * 只在**冷启动**（本组件 onMounted，即 App 加载 / 页面刷新）时判断一次，
 * 不 watch 会话状态：运行中→结束是用户主动点的「结束」，那时把人硬拽回会话页是骚扰。
 *
 * 且只在**落在首页**时才跳：App 内 WebView 每次启动都加载到首页，这正是要接住的场景；
 * 而浏览器宿主里用户可能在 `/profile` 上刷新，把人从设置页拽走是没有理由的。
 * 通知点击的回跳由上面那条 watch 负责，与此互不干扰。
 */
function resumeRunningSession(): void {
  // ⚠️ 有待消费的通知回跳请求时**不抢**导航：那条 watch 会把用户送到会话页，
  // 而它还要靠 SessionView 按 progressID 高亮具体那一行。这里再 push 一次虽然
  // 目标相同（都是 /session），但会与回跳 watch 竞争同一次导航，且语义上「通知回跳」
  // 优先级高于「冷启动兜底」——用户是带着明确意图点进来的。
  if (reminders.focusRequest !== null) return;
  if (store.session?.state !== 'running') return;
  if (router.currentRoute.value.name !== 'home') return;
  void router.push('/session');
}
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
 * - `wait`：**数据还没读出来**（冷启动时原生事件常早于 `store.init()` 到达）。
 *   此时不能判 stale 把请求丢掉 —— 那正是「点通知停在首页」的根因。
 *   保留请求，等 `store.ready` 变成 true 时本 watch 会自动重跑并完成导航。
 * - `navigate`：若当前不在会话页则跳过去；**不清** focusRequest，
 *   由 SessionView 挂载后消费（它要按 progressID 高亮并滚动到位）。
 *
 * ⚠️ watch 同时监听 `focusRequest` 与 `store.ready`：后者是 `wait` → 正常裁决的触发条件。
 */
watch(
  [() => reminders.focusRequest, () => store.ready] as const,
  ([request]) => {
    const action = resolveFocusAction(request, {
      sessionID: store.session?.id ?? null,
      progressIDs: store.session?.progress.map((item) => item.id) ?? [],
      ready: store.ready,
    });
    if (action === 'stale') {
      // 那条会话已经结束/被替换，不能把它拉回前台；消费掉即可。
      reminders.clearFocusRequest();
      return;
    }
    if (action === 'wait') {
      // 数据未就绪：**保留**请求，等 store.ready 翻转后本 watch 会重跑。
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
