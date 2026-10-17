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
        <div class="mm-section-heading"><h3>提醒设置</h3><SessionIcon name="bell" :size="18" /></div>        <label class="mm-toggle profile-toggle">
          <input v-model="speechEnabled" type="checkbox" data-testid="speech-toggle" />
          应用内语音播报
        </label>
        <p class="mm-hint profile-data-note">提醒弹出时用语音念出内容，亮屏使用中同样出声。关闭后只保留弹窗，不再出声。</p>
        <!-- 超时提醒频率：两阶段。第二行的「切换点」刻意做成只读文本，
             保证两行指的是**同一个**数字 —— 若两边各放一个 select，用户改了一行
             会看到另一行没变，以为设置没生效。 -->
        <div class="profile-overdue">
          <p class="profile-overdue-heading">超时提醒频率</p>
          <p class="mm-hint profile-overdue-intro">任务超时后每隔多久再提醒一次。可以分两段：拖得越久、催得越紧。</p>
          <div class="profile-overdue-row">
            <span class="profile-overdue-label">超时不到</span>
            <select v-model.number="overdueSwitch" class="mm-input profile-overdue-select" data-testid="overdue-switch">
              <option v-for="minute in SWITCH_OPTIONS" :key="minute" :value="minute">{{ minute }} 分钟</option>
            </select>
            <span class="profile-overdue-tail">每</span>
            <select v-model.number="overdueEarly" class="mm-input profile-overdue-select" data-testid="overdue-early">
              <option v-for="minute in INTERVAL_OPTIONS" :key="minute" :value="minute">{{ minute }} 分钟</option>
            </select>
            <span class="profile-overdue-tail">提醒一次</span>
          </div>
          <div class="profile-overdue-row">
            <span class="profile-overdue-label">超时满</span>
            <span class="profile-overdue-value">{{ overdueSwitch }} 分钟</span>
            <span class="profile-overdue-tail">每</span>
            <select v-model.number="overdueLate" class="mm-input profile-overdue-select" data-testid="overdue-late">
              <option v-for="minute in INTERVAL_OPTIONS" :key="minute" :value="minute">{{ minute }} 分钟</option>
            </select>
            <span class="profile-overdue-tail">提醒一次</span>
          </div>
          <p class="mm-hint profile-overdue-summary" data-testid="overdue-summary">{{ overdueSummary }}</p>
        </div>
        <p class="mm-hint profile-data-note">以上两项跟随你的账号：换设备登录同一账号会自动带过去。</p>
      </section>
      <section class="mm-section">
        <div class="mm-section-heading"><h3>通勤设置</h3><SessionIcon name="route" :size="18" /></div>
        <label>默认出行方式
          <select v-model="travelMode" class="mm-input">
            <option value="driving">开车</option>
            <option value="walking">步行</option>
            <option value="transit">公交 / 地铁</option>
          </select>
        </label>
        <p class="mm-hint profile-data-note">地图与路线服务由应用内置，无需填写任何 Key。出行方式跟随你的账号。</p>
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
import { computed, ref, watch } from 'vue';
import { account, accountRequest } from '../platform/account';
import SessionIcon from './session/SessionIcon.vue';
import { useRoutineStore } from '../stores/routine';
import {
  OVERDUE_INTERVAL_RANGE,
  OVERDUE_SWITCH_RANGE,
  normalizeOverduePolicy,
  type OverduePolicy,
} from '../core/reminders';
const store = useRoutineStore();
const busy = ref(false), error = ref('');

/**
 * 两项设置从 store 读，**用 computed 的 getter/setter 而不是本地 ref**：
 * 设置的真实来源是 `routineStore.settings`（它由桥读出、并随账号云同步），
 * 用本地 ref 会出现「页面显示旧值、实际已同步新值」的分叉。
 *
 * setter 里 `void` 掉 promise：保存是后台动作，`saveSettings` 已保证失败静默
 * （桥内部 catch + 回落），不该让输入框卡住或弹错。
 *
 * ⚠️ 高德 Key 不在这里，也**不再存在**于任何设置里 —— 地图请求改走服务端代理，
 * 凭据从未进入客户端（见 `platform/commute.ts` 注释）。
 */
const travelMode = computed({
  get: () => store.settings.travelMode,
  set: (value: string) => void store.saveSettings({ travelMode: value }),
});

const speechEnabled = computed({
  get: () => store.settings.speechEnabled,
  set: (value: boolean) => void store.saveSettings({ speechEnabled: value }),
});

/**
 * 超时提醒频率（两阶段）。用户原话：「超时 10 分钟之内 2 分钟提醒一次，
 * 超时 10 分钟以上 1 分钟提醒一次，这个由用户设置，最小 1 分钟最大 10 分钟」。
 *
 * ⚠️ getter **必须过 `normalizeOverduePolicy`**：`store.settings` 里那一份来自
 * App Group / localStorage，可能是旧版本写的（整键缺失）或被人手改过（越界值）。
 * 不归一化时 `v-model.number` 会绑到 `undefined` → select 显示空 → 用户以为设置丢了。
 */
const overduePolicy = computed(() => normalizeOverduePolicy(store.settings.overduePolicy));

/** 改一项就写回**完整**策略对象：桥是整字段替换，只传一半会把另外两项抹掉。 */
function patchOverdue(patch: Partial<OverduePolicy>): void {
  void store.saveSettings({ overduePolicy: { ...overduePolicy.value, ...patch } });
}

const overdueEarly = computed({
  get: () => overduePolicy.value.earlyInterval,
  set: (value: number) => patchOverdue({ earlyInterval: Number(value) }),
});

const overdueSwitch = computed({
  get: () => overduePolicy.value.switchAfter,
  set: (value: number) => patchOverdue({ switchAfter: Number(value) }),
});

const overdueLate = computed({
  get: () => overduePolicy.value.lateInterval,
  set: (value: number) => patchOverdue({ lateInterval: Number(value) }),
});

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

/** 两个间隔都是 1–10 分钟（用户给的上下限）；切换点放宽到 1–60，够覆盖「拖了一小时」。 */
const INTERVAL_OPTIONS = range(OVERDUE_INTERVAL_RANGE.min, OVERDUE_INTERVAL_RANGE.max);
const SWITCH_OPTIONS = range(OVERDUE_SWITCH_RANGE.min, OVERDUE_SWITCH_RANGE.max);

/**
 * 把生效节奏用一句话说清楚 —— select 并排看容易误读成「两个独立规则」，
 * 这里明确「先是 A，满 N 分钟后改成 B」。两段同值时只报一个数，不啰嗦。
 */
const overdueSummary = computed(() => {
  const { earlyInterval, switchAfter, lateInterval } = overduePolicy.value;
  if (earlyInterval === lateInterval) {
    return `当前：全程每 ${earlyInterval} 分钟提醒一次。`;
  }
  return `当前：超时不到 ${switchAfter} 分钟每 ${earlyInterval} 分钟提醒一次，之后每 ${lateInterval} 分钟提醒一次。`;
});

// 首次进入本页时补一次读取：设置由 `performInit` 载入，但用户可能在 init 完成前
// 就切到本页（路由不 gate 在 ready 上），那样输入框会短暂显示空 key。
watch(
  () => store.ready,
  (ready) => {
    if (ready) {
      void store.ensureReady();
    }
  },
  { immediate: true },
);

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
/* 开关行：标签是整行可点的，行高给足以便触摸。 */
.profile-toggle { display: flex; align-items: center; gap: 10px; margin: 4px 0; padding: 10px 0; font-size: 14px; color: var(--mm-ink); cursor: pointer; }
/* 超时频率：两行「自然语言 + 内联 select」，比三个带标题的表单项好读。 */
.profile-overdue { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--mm-border); }
.profile-overdue-heading { margin: 0; font-size: 13px; font-weight: 600; color: var(--mm-ink); }
.profile-overdue-intro { margin: 6px 0 14px; }
.profile-overdue-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 0; font-size: 13px; color: #8390a4; }
.profile-overdue-label { min-width: 52px; }
.profile-overdue-value { min-width: 62px; font-variant-numeric: tabular-nums; color: var(--mm-ink); }
.profile-overdue-tail { color: #8390a4; }
.profile-overdue-select { width: auto; min-width: 88px; padding: 6px 8px; font-size: 13px; }
.profile-overdue-summary { margin: 12px 0 0; }
</style>
