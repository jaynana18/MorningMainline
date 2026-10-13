<template>
  <main class="mm-page" style="max-width: 420px">
    <section class="mm-section">
      <h2>{{ registering ? '创建个人账号' : '登录不跑偏' }}</h2>
      <p class="mm-hint">登录后同步自己的任务和执行进度。</p>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" class="mm-input" autocomplete="username" required minlength="2" maxlength="32" /></label>
        <label>密码<input v-model="password" class="mm-input" type="password" :autocomplete="registering ? 'new-password' : 'current-password'" required minlength="8" maxlength="128" /></label>
        <label class="mm-toggle" style="margin: 12px 0"><input v-model="importLocal" type="checkbox" />账号没有云端数据时，导入本机旧任务</label>
        <p v-if="error" role="alert" style="color: var(--mm-red)">{{ error }}</p>
        <button class="mm-btn mm-btn--primary" :disabled="busy">{{ busy ? '正在连接…' : registering ? '注册并登录' : '登录' }}</button>
        <button type="button" class="mm-btn mm-btn--secondary" :disabled="busy" @click="registering = !registering">{{ registering ? '已有账号，去登录' : '没有账号，去注册' }}</button>
      </form>
    </section>
  </main>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { accountRequest } from '../platform/account';
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
