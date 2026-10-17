<template>
  <main class="mm-page account-page" style="max-width: 440px">
    <div class="account-brand"><SessionIcon name="target" :size="32" /></div>
    <p class="account-brand-name">不跑偏</p>
    <p class="account-brand-caption">先定终点，再从容开始。</p>
    <section class="mm-section">
      <h2>{{ registering ? '创建个人账号' : '登录不跑偏' }}</h2>
      <p class="mm-hint">登录后同步自己的任务和执行进度。</p>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" class="mm-input" placeholder="你的用户名" autocomplete="username" required minlength="2" maxlength="32" /></label>
        <label>密码<input v-model="password" class="mm-input" placeholder="至少 8 位" type="password" :autocomplete="registering ? 'new-password' : 'current-password'" required minlength="8" maxlength="128" /></label>
        <details class="account-import"><summary>迁移本机旧任务</summary><label class="mm-toggle" style="margin: 12px 0"><input v-model="importLocal" type="checkbox" />账号没有云端数据时，导入本机旧任务</label></details>
        <p v-if="error" role="alert" style="color: var(--mm-red)">{{ error }}</p>
        <button class="mm-btn mm-btn--primary account-submit" :disabled="busy">{{ busy ? '正在连接…' : registering ? '注册并登录' : '登录' }}</button>
        <button type="button" class="account-switch" :disabled="busy" @click="registering = !registering">{{ registering ? '已有账号，去登录' : '没有账号，创建一个' }}</button>
      </form>
    </section>
  </main>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { accountRequest } from '../platform/account';
import SessionIcon from './session/SessionIcon.vue';
const username = ref(''), password = ref(''), error = ref('');
const registering = ref(false), busy = ref(false), importLocal = ref(false);
async function submit(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const data = await accountRequest(registering.value ? '/register' : '/login', 'POST', { username: username.value, password: password.value });
    localStorage.setItem('mm-account-user', JSON.stringify(data.user));
    if (importLocal.value) sessionStorage.setItem('mm-import-local', 'yes');
    window.location.reload();
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '登录失败'; }
  finally { busy.value = false; }
}
</script>
<style scoped>
/*
  登录页没有页面级工具栏（`.mm-toolbar` 自带 `env(safe-area-inset-top)`），
  所以这里要自己避让状态栏/灵动岛 —— WKWebView 已铺满全屏，不避让就会顶到岛下面。
*/
.account-page { padding-top: calc(44px + env(safe-area-inset-top)); }
.account-brand { display: grid; place-items: center; width: 66px; height: 66px; margin: 0 auto; border-radius: 22px; color: white; background: var(--mm-primary); box-shadow: 0 8px 28px #4189eb26; }
.account-brand-name { margin: 14px 0 4px; text-align: center; font-size: 22px; font-weight: 750; }
.account-brand-caption { margin: 0 0 28px; text-align: center; color: #9aa8bb; font-size: 12px; }
.account-import { margin: 18px 0; }
.account-submit { width: 100%; margin-top: 4px; }
.account-switch { display: block; width: 100%; padding: 16px 0 0; background: none; border: 0; color: var(--mm-primary); font-size: 12px; cursor: pointer; }
</style>
