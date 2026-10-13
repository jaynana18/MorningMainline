<template>
  <button type="button" class="map-thumbnail" :aria-label="`放大查看${title}`" @click.stop="expanded = true">
    <img v-if="src && !failed" :src="src" :alt="title" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" />
    <span v-else>地图暂时无法加载</span>
    <small>点击放大</small>
  </button>
  <Teleport to="body">
    <div v-if="expanded" class="mm-modal-backdrop map-preview-backdrop" @click.stop.self="expanded = false" @keydown.esc.stop="expanded = false">
      <section class="mm-modal map-preview-dialog" role="dialog" aria-modal="true" :aria-label="title" @click.stop>
        <div class="mm-row"><b>{{ title }}</b><button ref="closeButton" type="button" class="mm-btn mm-btn--secondary" @click="expanded = false">关闭</button></div>
        <p v-if="commuteSeconds != null" class="map-preview-duration">{{ travelModeLabel }} · 预计通勤 <b>{{ Math.ceil(commuteSeconds / 60) }} 分钟</b></p>
        <img v-if="src && !failed" class="map-preview-image" :src="src" :alt="title" referrerpolicy="no-referrer" @error="failed = true" />
        <p v-else class="mm-hint">地图暂时无法加载，请稍后再试。</p>
        <a v-if="navigationUrl" :href="navigationUrl" class="mm-btn mm-btn--secondary">在高德打开路线 ↗</a>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
const props = defineProps<{ src: string; title: string; navigationUrl?: string; commuteSeconds?: number; travelModeLabel?: string }>();
const expanded = ref(false);
const failed = ref(false);
const closeButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;
watch(() => props.src, () => { failed.value = false; });
watch(expanded, async value => {
  if (value) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    closeButton.value?.focus();
  } else previousFocus?.focus();
});
</script>

<style scoped>
.map-thumbnail { position: relative; display: block; width: min(100%, 180px); padding: 0; overflow: hidden; border: 0; border-radius: 10px; background: #eef2e9; cursor: pointer; color: inherit; }
.map-thumbnail img { display: block; width: 100%; aspect-ratio: 2; object-fit: contain; }
.map-thumbnail > span { display: block; padding: 24px 8px; font-size: 12px; }
.map-thumbnail small { position: absolute; bottom: 4px; right: 4px; padding: 2px 5px; border-radius: 4px; background: #ffffffe6; font-size: 10px; }
.map-preview-backdrop { z-index: 2000; }
.map-preview-dialog { width: min(92vw, 720px); max-height: 90vh; overflow-y: auto; }
.map-preview-image { display: block; width: 100%; aspect-ratio: 2; object-fit: contain; margin: 14px 0; border-radius: 12px; background: #eef2e9; }
.map-preview-duration { margin: 8px 0; padding: 10px 12px; border-radius: 10px; background: var(--mm-primary-soft); color: #6d85a5; font-size: 13px; }
.map-preview-duration b { color: var(--mm-primary); font-weight: 650; }
</style>
