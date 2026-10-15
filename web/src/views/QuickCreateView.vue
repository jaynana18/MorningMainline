<template>
  <div class="create-view">
    <header class="mm-toolbar">
      <button class="mm-btn mm-btn--secondary" @click="onCancel">取消</button>
      <span class="mm-title">{{ editingID ? '一句话修改' : '一句话创建' }}</span>
      <button class="mm-btn mm-btn--primary" :disabled="generated === null" @click="onSave">
        保存
      </button>
    </header>

    <main class="mm-page" style="max-width: 720px">
      <!-- ① 输入区 -->
      <section class="mm-section">
        <div class="mm-section-heading"><h3>把计划说出来</h3><span class="mm-eyebrow">一句话就够</span></div>
        <textarea
          v-model="input"
          class="mm-textarea"
          data-testid="create-input"
          placeholder="刷牙3分钟，去凯德逛30分钟，再去宜家待1小时，18点结束。"
        ></textarea>
        <!-- 示例文案：与 iOS 版一致，只在编辑器下方出现一次（原版 TextEditor 无 placeholder）。 -->
        <p class="mm-hint" style="margin-top: 8px">
          写下步骤、时长和目的地，会自动拆成你的任务线。
        </p>
        <p style="color: var(--mm-orange); font-size: 12px; display: flex; align-items: center; gap: 4px">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="6" y="1.5" width="4" height="8" rx="2" stroke="currentColor" stroke-width="1.3" />
            <path d="M3.5 7.5v.5a4.5 4.5 0 0 0 9 0v-.5M8 12.5V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <span>也可以点系统键盘的麦克风直接说</span>
        </p>
        <!-- footer 文案（逐字） -->
        <p class="mm-hint">截止时间可以直接写进去，比如「18点30结束」；生成后也能手动调整。</p>
      </section>

      <div v-if="destinationDialog" class="mm-modal-backdrop" @click.self="closeDestination">
        <section class="mm-modal" role="dialog" aria-modal="true" aria-label="确认目的地" style="max-height: 85vh; overflow-y: auto">
          <div class="mm-row"><h4>确认「{{ destination }}」</h4><button class="mm-btn mm-btn--secondary" @click="closeDestination">返回修改原句</button></div>
          <p class="mm-hint">第 {{ stopIndex + 1 }} / {{ pendingStops.length }} 个地点</p>
          <p class="mm-hint">{{ commuteItems.length ? `从${commuteItems[commuteItems.length - 1].route.address}出发` : '从当前位置出发' }}</p>
          <details style="margin-top: 10px">
            <summary>通勤设置</summary>
            <label>交通方式
              <select v-model="travelMode" class="mm-input">
                <option value="driving">开车</option>
                <option value="walking">步行</option>
                <option value="transit">公交 / 地铁</option>
              </select>
            </label>
          </details>
          <p class="mm-hint">优先搜索出发地附近的同名地点，定位失败时按名称搜索。选中后显示地图并查询路程。</p>
          <div v-if="selectedPlace" style="margin-top: 12px">
            <p>{{ selectedPlace.name }} <span class="mm-hint">{{ selectedPlace.address }}</span></p>
            <MapPreview :src="destinationMapURL(amapKey, selectedPlace.location)" :title="selectedPlace.name" />
          </div>
          <div v-if="needsOrigin">
            <label>出发地名称<input v-model="originQuery" class="mm-input" placeholder="例如：青岛站" /></label>
            <button class="mm-btn mm-btn--secondary" :disabled="routeBusy || !originQuery.trim()" @click="searchOrigin">搜索出发地</button>
            <button v-for="place in originCandidates" :key="place.id" class="mm-btn mm-btn--secondary" style="display: block; margin-top: 8px; white-space: normal" :disabled="routeBusy" @click="chooseOrigin(place)">{{ place.name }} · {{ place.address }}</button>
          </div>
          <p v-if="needsSecureLocation" class="mm-hint" style="color: var(--mm-red)">
            手机定位需要通过 HTTPS 打开。
            <a v-if="secureEntryURL" :href="secureEntryURL">切换到 HTTPS 版本</a>
            <span v-else>请使用 HTTPS 地址或电脑 localhost 测试。</span>
            未保存的输入不会随页面切换保留。
          </p>
          <p v-if="routeBusy" class="mm-hint">正在查询…</p>
          <button v-if="routeError" class="mm-btn mm-btn--secondary" :disabled="routeBusy" @click="lookupRoute()">重新搜索候选地点</button>
          <div v-if="destinationCandidates.length" style="margin-top: 12px">
            <p class="mm-hint">{{ candidateHint }}</p>
            <button v-for="candidate in destinationCandidates" :key="candidate.id"
              class="mm-btn mm-btn--secondary" style="display: block; width: 100%; margin-top: 8px; text-align: left; white-space: normal"
              :disabled="routeBusy" @click="selectPlace(candidate)">
              {{ candidate.name }}<span v-if="candidate.distanceMeters != null" class="mm-hint"> · {{ candidate.distanceMeters < 1000 ? `${candidate.distanceMeters}米` : `${(candidate.distanceMeters / 1000).toFixed(1)}公里` }}</span><br /><span class="mm-hint">{{ candidate.address }}</span>
            </button>
          </div>
          <p v-if="routeError" role="alert" style="color: var(--mm-red)">{{ routeError }}</p>
        </section>
      </div>
      <p v-if="errorMessage" role="alert" style="color: var(--mm-red)">{{ errorMessage }}</p>

      <!-- ② 计划设置（仅「重复」选择） -->
      <section class="mm-section">
        <div class="mm-section-heading"><h3>计划设置</h3></div>
        <div class="mm-row">
          <span>重复</span>
          <span class="mm-seg">
            <button
              v-for="option in RECURRENCES"
              :key="option"
              class="mm-seg__item"
              :class="{ 'mm-seg__item--active': recurrence === option }"
              @click="recurrence = option"
            >
              {{ RECURRENCE_TITLES[option] }}
            </button>
          </span>
        </div>
      </section>

      <!-- ③ 生成按钮 -->
      <section class="mm-section mm-form-actions">
        <button
          class="mm-btn mm-btn--primary"
          style="width: 100%"
          :disabled="input.trim() === '' || isParsing || routeBusy || destinationDialog"
          data-testid="generate"
          @click="generate"
        >
          <span v-if="isParsing">正在识别…</span>
          <span v-else>生成任务线</span>
        </button>
      </section>

      <!-- ④ 生成后才出现的截止时间区（④ 与 ⑤ 均在 generated 非空时渲染） -->
      <template v-if="generated !== null">
        <section class="mm-section" data-testid="deadline-section">
          <div class="mm-section-heading"><h3>钉住终点</h3><SessionIcon name="flag" :size="16" /></div>
          <label class="mm-toggle">
            <input v-model="hasDeadline" type="checkbox" data-testid="deadline-toggle" />
            <span>设置截止时间</span>
          </label>

          <div v-if="hasDeadline" style="margin-top: 10px">
            <input v-model="deadlineTime" type="time" class="mm-textarea" style="min-height: 0" />
            <p class="mm-hint">设置后，会按截止时间倒推出应该开始的时间。</p>
          </div>
          <p v-else class="mm-hint">不设置时，进入任务线后由你选择第一项开始正计时。</p>
        </section>

        <!-- ⑤ 预览区（不重复展示截止时间行） -->
        <section class="mm-section" data-testid="preview-section">
          <div class="mm-section-heading"><h3>你的任务线</h3><span class="mm-hint">{{ generated.steps.length }} 个步骤</span></div>
          <p v-if="parsingCaption" class="mm-hint">{{ parsingCaption }}</p>
          <div class="mm-preview-item">
            <span class="mm-inline">
              <SessionIcon :name="iconNameForSymbol(generated.symbol)" :size="14" />
              {{ generated.name }}
            </span>
          </div>
          <div class="mm-preview-item">
            <span>重复</span>
            <span class="mm-hint">{{ recurrenceTitle }}</span>
          </div>
          <div class="mm-preview-item">
            <span>计时方式</span>
            <span class="mm-hint">{{ modeTitle }}</span>
          </div>
          <div v-for="step in generated.steps" :key="step.id" class="mm-preview-item">
            <div class="create-preview-task">
              <span>{{ step.title }}</span>
              <CommuteMap v-if="step.commute" :route="step.commute" compact />
            </div>
            <span class="mm-hint">
              {{ step.role === 'deadline' ? '硬节点' : formatMinutes(step.duration) }}
            </span>
          </div>
          <template v-if="hasCommute && route && hasDeadline">
            <label>固定缓冲（分钟）<input v-model.number="bufferMinutes" class="mm-input" type="number" min="0" max="120" /></label>
            <p class="mm-hint">最晚开始准备 {{ preparationTime }} · 最晚出门 {{ departureTime }}</p>
          </template>
          <div style="margin-top: 16px">
            <input v-model="editInstruction" class="mm-input" placeholder="在刷牙前增加喝水 2 分钟 / 刷牙增加 1 分钟" />
            <button class="mm-btn mm-btn--secondary" style="margin-top: 8px" @click="applyEdit">预览修改</button>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  RECURRENCES,
  RECURRENCE_TITLES,
  formatMinutes,
  useRoutineStore,
  createStep,
  editTasks,
  queryCommute,
  type TravelMode,
  type CommuteRoute,
  type Recurrence,
  type RoutineStep,
  type RoutineTemplate,
} from '../stores/routine';
import { DestinationSelectionRequired, OriginRequired, destinationMapURL, developerAmapKey, type CommuteDestination } from '../platform/commute';
import CommuteMap from './CommuteMap.vue';
import MapPreview from './MapPreview.vue';
import { iconNameForSymbol } from './session/helpers';
import SessionIcon from './session/SessionIcon.vue';

const store = useRoutineStore();
const router = useRouter();
const pageRoute = useRoute();

const input = ref('');
/** 解析出的任务步骤；改截止时间/重复方式时据此重算模板，避免重走解析。 */
const parsedSteps = ref<RoutineStep[]>([]);
const generated = ref<RoutineTemplate | null>(null);
const isParsing = ref(false);
/** 截止时间默认关闭（没识别到截止时间时保持关闭态）。 */
const hasDeadline = ref(false);
const selectedDeadline = ref<Date>(new Date());
const recurrence = ref<Recurrence>('once');
const editingID = ref<string | null>(null);
const editingTemplate = ref<RoutineTemplate | null>(null);
const editInstruction = ref('');
const errorMessage = ref('');
const hasCommute = ref(false);
const destination = ref('');
const travelMode = computed<TravelMode>({
  // 出行方式是**用户自定义行为**，跟账号云同步（不走开发者配置那条路）。
  // 旧版本只写 localStorage('mm-travel-mode')，那份值现在是死数据，不再读。
  get: () => (store.settings.travelMode as TravelMode) || 'driving',
  set: (value: TravelMode) => { void store.saveSettings({ travelMode: value }); },
});
/**
 * 高德 Key 是**开发者配置**，只在构建期由 `.env` 注入，不进用户界面。
 *
 * 这里保留成 computed 只为让模板少写一层调用；它是**只读**的 ——
 * 没有 setter，也不再有「用户填 Key」这条路径。要换 Key 由开发者改 `web/.env.local`
 * 后重新构建（WebView 宿主下另经 `syncDeveloperKeyToNative()` 广播给原生/手表）。
 */
const amapKey = computed<string>(() => developerAmapKey());
const needsSecureLocation = !window.webkit?.messageHandlers?.mainline && !window.isSecureContext;
const secureEntryURL = import.meta.env.DEV && import.meta.env.VITE_DEV_HTTPS_URL
  ? `${import.meta.env.VITE_DEV_HTTPS_URL.replace(/\/$/, '')}/${window.location.hash || '#/create'}`
  : '';
const route = ref<CommuteRoute | null>(null);
const routeBusy = ref(false);
const bufferMinutes = ref(10);
const commuteItems = ref<{ step: RoutineStep; route: CommuteRoute }[]>([]);
const destinationDialog = ref(false);
const routeError = ref('');
const parsingCaption = ref('');
const selectedPlace = ref<CommuteDestination | null>(null);
const needsOrigin = ref(false);
const originQuery = ref('');
const originCandidates = ref<CommuteDestination[]>([]);
const manualOrigin = ref('');
function selectPlace(place: CommuteDestination): void {
  selectedPlace.value = place;
  void lookupRoute(place);
}
async function searchOrigin(): Promise<void> {
  const requestID = ++routeRequest;
  routeBusy.value = true;
  routeError.value = '';
  originCandidates.value = [];
  try {
    await queryCommute(amapKey.value, originQuery.value, travelMode.value);
  } catch (error) {
    if (requestID !== routeRequest) return;
    if (error instanceof DestinationSelectionRequired) originCandidates.value = error.candidates;
    else routeError.value = error instanceof Error ? error.message : '搜索失败，请重试。';
  } finally { if (requestID === routeRequest) routeBusy.value = false; }
}
function chooseOrigin(place: CommuteDestination): void {
  manualOrigin.value = place.location;
  needsOrigin.value = false;
  originCandidates.value = [];
  if (selectedPlace.value) void lookupRoute(selectedPlace.value);
}
let routeRequest = 0;
let generation = 0;
const pendingStops = ref<{ query: string; steps: RoutineStep[] }[]>([]);
const stopIndex = ref(0);
function openDestination(): void {
  selectedPlace.value = null;
  needsOrigin.value = false;
  destination.value = pendingStops.value[stopIndex.value].query;
  routeError.value = '';
  destinationCandidates.value = [];
  destinationDialog.value = true;
  void lookupRoute();
}
function closeDestination(): void {
  generation++;
  routeRequest++;
  destinationDialog.value = false;
  routeBusy.value = false;
  destinationCandidates.value = [];
  generated.value = null;
}
const destinationCandidates = ref<CommuteDestination[]>([]);
const candidateHint = ref('请选择具体目的地，确认后查询通勤：');
const departureTime = computed(() => {
  const firstTravel = parsedSteps.value.findIndex(step => commuteItems.value.some(item => item.step.id === step.id));
  const remaining = parsedSteps.value.slice(Math.max(0, firstTravel)).reduce((sum, step) => sum + step.duration, 0);
  const date = new Date(selectedDeadline.value.getTime() - (remaining + bufferMinutes.value * 60) * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
});
const preparationTime = computed(() => {
  const seconds = parsedSteps.value.filter((step) => step.role === 'task').reduce((sum, step) => sum + step.duration, 0);
  const date = new Date(selectedDeadline.value.getTime() - (seconds + bufferMinutes.value * 60) * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
});

async function lookupRoute(selectedDestination?: CommuteDestination): Promise<void> {
  const requestedDestination = destination.value;
  const requestedMode = travelMode.value;
  const requestID = ++routeRequest;
  routeBusy.value = true;
  routeError.value = '';
  if (!selectedDestination) destinationCandidates.value = [];
  try {
    const previous = commuteItems.value[commuteItems.value.length - 1]?.route;
    const result = await queryCommute(amapKey.value, requestedDestination, requestedMode, selectedDestination, previous?.location || manualOrigin.value || undefined);
    if (requestID !== routeRequest || destination.value !== requestedDestination || travelMode.value !== requestedMode || !hasCommute.value) return;
    const tasks = pendingStops.value[stopIndex.value].steps;
    if (requestID !== routeRequest || !destinationDialog.value) return;
    route.value = result;
    const step = createStep({ title: `通勤到${result.address}`, duration: result.seconds, commute: result });
    commuteItems.value.push({ step, route: result });
    parsedSteps.value.push(step, ...tasks.map(task => ({ ...task, title: `${result.address} · ${task.title}` })));
    stopIndex.value++;
    if (stopIndex.value < pendingStops.value.length) openDestination();
    else {
      destinationDialog.value = false;
      destinationCandidates.value = [];
      rebuild();
    }
  } catch (error) {
    if (requestID !== routeRequest || destination.value !== requestedDestination || travelMode.value !== requestedMode || !hasCommute.value) return;
    if (error instanceof OriginRequired) {
      needsOrigin.value = true;
      routeError.value = error.message;
    } else if (error instanceof DestinationSelectionRequired) {
      destinationCandidates.value = error.candidates;
      candidateHint.value = error.message;
    }
    else routeError.value = error instanceof Error ? error.message : '通勤查询失败，请重试。';
  }
  finally { if (requestID === routeRequest) routeBusy.value = false; }
}

function applyEdit(): void {
  try {
    parsedSteps.value = editTasks(parsedSteps.value, editInstruction.value);
    rebuild();
    editInstruction.value = '';
    errorMessage.value = '';
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : '没有识别到修改。'; }
}

onMounted(() => {
  const template = pageRoute.query.edit ? store.pendingTemplate : null;
  if (!template) return;
  editingID.value = template.id;
  editingTemplate.value = template;
  parsedSteps.value = template.steps.filter((step) => step.role === 'task').map((step) => ({ ...step }));
  recurrence.value = template.recurrence ?? 'once';
  hasDeadline.value = template.mode === 'backward';
  const date = new Date();
  date.setHours(template.deadlineHour ?? 0, template.deadlineMinute ?? 0, 0, 0);
  selectedDeadline.value = date;
  generated.value = template;
});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `<input type="time">` ↔ Date 的双向绑定（只取时分）。 */
const deadlineTime = computed<string>({
  get: () => `${pad(selectedDeadline.value.getHours())}:${pad(selectedDeadline.value.getMinutes())}`,
  set: (value: string) => {
    const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
    const next = new Date(selectedDeadline.value);
    next.setHours(Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, 0, 0);
    selectedDeadline.value = next;
  },
});

const recurrenceTitle = computed(() =>
  generated.value ? RECURRENCE_TITLES[generated.value.recurrence ?? 'once'] : '',
);
const modeTitle = computed(() =>
  generated.value?.mode === 'backward' ? '按截止时间倒推' : '开始后正计时',
);

async function generate(): Promise<void> {
  const currentGeneration = ++generation;
  isParsing.value = true;
  errorMessage.value = '';
  generated.value = null;
  commuteItems.value = [];
  route.value = null;
  parsingCaption.value = '';
  try {
    const result = await store.parsePlan(input.value);
    if (currentGeneration !== generation) return;
    pendingStops.value = result.stops;
    stopIndex.value = 0;
    hasCommute.value = result.stops.length > 0;
    const resolved = result.deadline;
    parsedSteps.value = result.preparation;
    parsingCaption.value = result.cached ? '已复用这句话的识别结果，请确认任务与时长。' : 'AI 已识别，请确认任务与时长。';
    hasDeadline.value = resolved !== null;
    if (resolved) {
      selectedDeadline.value = resolved;
    }
    if (hasCommute.value) openDestination();
    else rebuild();
  } catch (error) {
    if (currentGeneration !== generation) return;
    generated.value = null;
    errorMessage.value = error instanceof Error ? error.message : '生成失败，请重试。';
  } finally {
    isParsing.value = false;
  }
}

/** 只重算模板，不碰解析结果 —— 改截止时间/重复方式都走这里，绝不丢掉已解析步骤。 */
function rebuild(): void {
  if (parsedSteps.value.length === 0 && !commuteItems.value.length) {
    generated.value = null;
    return;
  }
  try {
    generated.value = store.createTemplate(input.value, {
      deadline: hasDeadline.value ? selectedDeadline.value : null,
      recurrence: recurrence.value,
      steps: parsedSteps.value,
    });
    if (editingTemplate.value) {
      generated.value.id = editingTemplate.value.id;
      generated.value.name = editingTemplate.value.name;
      generated.value.symbol = editingTemplate.value.symbol;
      generated.value.buffer = editingTemplate.value.buffer;
      generated.value.commute = editingTemplate.value.commute;
      const oldDeadline = editingTemplate.value.steps.find((step) => step.role === 'deadline');
      const newDeadline = generated.value.steps.find((step) => step.role === 'deadline');
      if (oldDeadline && newDeadline) { newDeadline.title = oldDeadline.title; newDeadline.prompt = oldDeadline.prompt; }
    }
    if (hasCommute.value) {
      generated.value.commute = route.value ? { ...route.value } : undefined;
      generated.value.buffer = Math.max(0, Number(bufferMinutes.value) || 0) * 60;
      generated.value.name = `去${route.value?.address ?? destination.value}`;
      const deadline = generated.value.steps.find((step) => step.role === 'deadline');
      if (deadline) deadline.title = pendingStops.value[pendingStops.value.length - 1]?.steps.length
        ? '结束' : `到达${route.value?.address ?? destination.value}`;
    }
  } catch {
    generated.value = null;
  }
}

// 改截止时间 / 重复方式 → 即时重算且保留已解析步骤。
watch([hasDeadline, selectedDeadline, recurrence, bufferMinutes], () => {
  if (generated.value !== null) {
    rebuild();
  }
});
watch(travelMode, () => {
  destinationCandidates.value = [];
  routeRequest++;
  routeBusy.value = false;
  routeError.value = '';
  if (destinationDialog.value) void lookupRoute();
});

// 输入变化 → 上次生成结果作废（截止时间区随之收回）。
watch(input, () => {
  closeDestination();
  parsedSteps.value = [];
  generated.value = null;
  commuteItems.value = [];
  route.value = null;
  hasCommute.value = false;
});

async function onSave(): Promise<void> {
  if (!generated.value) {
    void router.push('/');
    return;
  }
  // 保存要落到 core 状态机（addTemplate → requireRoutine）；解析/生成都不需要它，
  // 所以只有这一步必须等 init 完成（web 特有：routine 实例是异步建的）。
  try {
    await store.ensureReady();
  } catch {
    store.notice = '数据还没准备好，请稍后再试。';
    return;
  }
  if (editingID.value) store.replaceTemplate(generated.value);
  else store.addTemplate(generated.value);
  // 保存后进预览页（选本次计划 / 原计划），对齐 Swift `selectedTemplate = template`。
  store.selectTemplate(generated.value);
  void router.push('/preview');
}

function onCancel(): void {
  void router.push('/');
}
</script>

<style scoped>
.create-preview-task { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.create-preview-task > span { min-width: 0; overflow-wrap: anywhere; }
.create-preview-task :deep(.commute-map--compact) { width: 56px; flex-basis: 56px; flex-shrink: 0; }
.mm-preview-item > .mm-hint { white-space: nowrap; flex-shrink: 0; }
</style>
