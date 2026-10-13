<template>
  <div class="commute-map" :class="{ 'commute-map--compact': compact }" @click.stop>
    <MapPreview :src="mapURL" :title="`到${route.address}的路线`" :navigation-url="commuteNavigationURL(route)" />
    <span class="commute-map__caption">{{ modeLabel }} · 约 {{ Math.ceil(route.seconds / 60) }} 分钟</span>
    <span v-if="!route.polyline" class="commute-map__note">仅显示起终点，完整路线请在高德查看</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MapPreview from './MapPreview.vue';
import type { CommuteInfo } from '../core/types';
import { commuteMapURL, commuteNavigationURL } from '../platform/commute';
const props = defineProps<{ route: CommuteInfo; compact?: boolean }>();
const mapURL = computed(() => commuteMapURL(props.route));
const modeLabel = computed(() => ({ driving: '开车', walking: '步行', transit: '公交' })[props.route.mode]);
</script>

<style scoped>
.commute-map { display: block; width: min(100%, 180px); overflow: hidden; border-radius: 10px; background: #fff9; color: inherit; }
.commute-map img { display: block; width: 100%; aspect-ratio: 2; object-fit: contain; background: #eef2e9; }
.commute-map__fallback { display: flex; min-height: 80px; align-items: center; justify-content: center; padding: 10px; font-size: 12px; }
.commute-map__caption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; padding: 8px; font-size: 11px; font-weight: 600; }
.commute-map__caption > span { color: #2563eb; }
.commute-map__note { display: block; padding: 0 8px 8px; font-size: 11px; opacity: .65; }
.commute-map--compact { width: 64px; flex: 0 0 64px; }
.commute-map--compact .commute-map__caption, .commute-map--compact .commute-map__note { display: none; }
.commute-map--compact :deep(.map-thumbnail small) { display: none; }
</style>
