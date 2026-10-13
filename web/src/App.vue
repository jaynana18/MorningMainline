<template>
  <div class="app-shell">
    <p v-if="!account.ready" class="mm-hint" style="padding: 24px">正在连接账号…</p>
    <AccountView v-else-if="!account.user" />
    <template v-else>
      <div class="mm-row" style="padding: 8px 16px; font-size: 12px">
        <span>{{ account.user.username }} · {{ account.status || '正在同步…' }}</span>
        <button class="mm-btn mm-btn--secondary" @click="logout">退出账号</button>
      </div>
      <div v-if="account.conflict" class="mm-section">
        <p>另一台设备有新数据。本机改动已保留，请选择此次保留哪一份：</p>
        <button class="mm-btn mm-btn--secondary" @click="resolveConflict('cloud')">使用服务器数据</button>
        <button class="mm-btn mm-btn--secondary" @click="resolveConflict('local')">用本机数据替换服务器</button>
      </div>
      <router-view />
    </template>

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
import { useRouter } from 'vue-router';
import { useRoutineStore } from './stores/routine';
import { useRemindersStore } from './stores/reminders';
import ReminderOverlay from './views/reminder/ReminderOverlay.vue';
import { resolveFocusAction } from './views/reminder/helpers';
import AccountView from './views/AccountView.vue';
import { account, accountRequest, loadAccount } from './platform/account';

const store = useRoutineStore();
const reminders = useRemindersStore();
const router = useRouter();

onMounted(async () => {
  await loadAccount();
  if (account.user) { await store.init(); void reminders.start(); }
});
function resolveConflict(choice: string): void { window.dispatchEvent(new CustomEvent('mm-resolve-sync', { detail: choice })); }
async function logout(): Promise<void> {
  try {
    await accountRequest('/logout', 'POST', {});
    localStorage.removeItem('mm-account-user');
    window.location.reload();
  } catch { account.status = '退出失败，请连接网络后重试'; }
}

onUnmounted(() => {
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
