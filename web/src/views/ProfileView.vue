<template>
  <div>
    <header class="mm-toolbar"><span class="mm-title">个人中心</span></header>
    <main class="mm-page" style="max-width: 720px">
      <section class="mm-section">
        <div class="profile-account"><SessionIcon name="person" :size="32" /><h2>{{ account.user?.username }}</h2></div>
        <p class="mm-hint">个人账号 · 任务由自己管理</p>
        <div class="mm-row"><span>数据同步</span><span class="mm-hint">{{ account.status || '正在同步…' }}</span></div>
      </section>
      <section class="mm-section">
        <button class="mm-btn mm-btn--secondary" :disabled="busy" @click="logout">{{ busy ? '正在退出…' : '退出账号' }}</button>
        <p v-if="error" role="alert" style="color: var(--mm-red)">{{ error }}</p>
      </section>
    </main>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { account, accountRequest } from '../platform/account';
import SessionIcon from './session/SessionIcon.vue';
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
.profile-account { display: flex; align-items: center; gap: 16px; }
</style>
