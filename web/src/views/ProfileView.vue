<template>
  <div class="profile-view">
    <header class="mm-toolbar"><span class="mm-title">个人中心</span></header>
    <main class="mm-page" style="max-width: 720px">
      <section class="mm-section profile-identity">
        <div class="profile-avatar">{{ account.user?.username.slice(0, 1).toUpperCase() }}</div>
        <h2>{{ account.user?.username }}</h2>
        <span class="profile-personal">个人空间</span>
        <p class="mm-hint">自己的计划，自己的节奏。</p>
        <div class="profile-overview">
          <div><b>{{ store.templates.length }}</b><span>任务线</span></div>
          <div><b>{{ store.session?.state === 'running' ? '进行中' : '待开始' }}</b><span>当前状态</span></div>
        </div>
      </section>
      <section class="mm-section">
        <div class="mm-section-heading"><h3>账号与数据</h3><SessionIcon name="cloud" :size="18" /></div>
        <div class="profile-data-row"><span>用户名</span><b>{{ account.user?.username }}</b></div>
        <div class="profile-data-row"><span>数据同步</span><b class="profile-sync" :class="{ 'profile-sync--warning': account.status.includes('离线') || account.conflict }">{{ account.status || '正在同步…' }}</b></div>
        <p class="mm-hint profile-data-note">使用同一账号，在手机、iPad 和电脑之间同步任务。</p>
      </section>
      <section class="mm-section">
        <button class="mm-btn mm-btn--danger profile-logout" :disabled="busy" @click="logout">{{ busy ? '正在退出…' : '退出账号' }}</button>
        <p v-if="error" role="alert" style="color: var(--mm-red)">{{ error }}</p>
      </section>
    </main>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { account, accountRequest } from '../platform/account';
import SessionIcon from './session/SessionIcon.vue';
import { useRoutineStore } from '../stores/routine';
const store = useRoutineStore();
const busy = ref(false), error = ref('');
async function logout(): Promise<void> {
  busy.value = true;
  try {
    await accountRequest('/logout', 'POST', {});
    localStorage.removeItem('mm-account-user');
    window.location.reload();
  } catch { error.value = '退出失败，请连接网络后重试'; }
  finally { busy.value = false; }
}
</script>
<style scoped>
.profile-identity { text-align: center; padding-top: 32px; }
.profile-avatar { width: 68px; height: 68px; margin: 0 auto 16px; display: grid; place-items: center; border-radius: 24px; background: linear-gradient(135deg, #e4efff, #edf2fa); color: var(--mm-primary); font-size: 27px; font-weight: 600; }
.profile-personal { display: inline-block; margin-top: 5px; padding: 3px 10px; border-radius: 7px; background: #f1f5fb; color: #91a0b4; font-size: 10px; }
.profile-overview { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--mm-border); margin-top: 24px; padding-top: 20px; }
.profile-overview div + div { border-left: 1px solid var(--mm-border); }
.profile-overview b, .profile-overview span { display: block; }
.profile-overview b { font-size: 21px; font-weight: 650; color: #567399; }
.profile-overview span { font-size: 11px; color: #a1adbe; margin-top: 4px; }
.profile-data-row { display: flex; justify-content: space-between; gap: 20px; padding: 16px 0; border-bottom: 1px solid var(--mm-border); font-size: 13px; }
.profile-data-row > span { color: #8390a4; }
.profile-data-row b { font-size: 12px; font-weight: 500; text-align: right; }
.profile-sync { color: #67a28c; }
.profile-sync--warning { color: #c39451; }
.profile-data-note { margin: 16px 0 0; }
.profile-logout { width: 100%; }
</style>
