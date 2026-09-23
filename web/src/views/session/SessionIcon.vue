<template>
  <!--
    内联 SVG 图标集（项目规范：视图内禁止 emoji，图标一律内联 SVG）。
    Swift 用 SF Symbols（sun.max.fill / exclamationmark.triangle.fill / …）；Web 无法渲染
    系统符号，这里用等价的手绘线条 SVG 替代，形状尽量贴近语义。
  -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'circle'">
      <circle cx="8" cy="8" r="5.5" />
    </template>
    <template v-else-if="name === 'target'">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'check'">
      <circle cx="8" cy="8" r="6" />
      <path d="M5.1 8.2l2 2 3.8-4.2" />
    </template>
    <template v-else-if="name === 'pause'">
      <circle cx="8" cy="8" r="6" />
      <path d="M6.4 5.8v4.4M9.6 5.8v4.4" />
    </template>
    <template v-else-if="name === 'flag'">
      <path d="M4 13.6V2.8" />
      <path d="M4 3.2h7.6l-1.7 2.1 1.7 2H4" />
      <path d="M6.7 3.2v4.1M9.2 3.2v4.1" :stroke-width="strokeWidth * 0.7" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.6V8l2.3 1.6" />
    </template>
    <template v-else-if="name === 'calendar'">
      <rect x="2.6" y="3.4" width="10.8" height="9.6" rx="2" />
      <path d="M2.6 6.4h10.8M5.6 2.4v2M10.4 2.4v2" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M3.4 4.6h9.2M6.6 4.6V3.2h2.8v1.4M5.1 4.6l.6 8.2h4.6l.6-8.2" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M8 3.5v9M3.5 8h9" />
    </template>
    <template v-else-if="name === 'sparkles'">
      <path d="M8 2.2l1.3 3.5 3.5 1.3-3.5 1.3L8 11.8 6.7 8.3 3.2 7l3.5-1.3z" />
    </template>
    <template v-else-if="name === 'cloud'">
      <path d="M4.9 11.6h6.1a2.3 2.3 0 0 0 .2-4.6 3.2 3.2 0 0 0-6.1-.7 2.4 2.4 0 0 0-.2 5.3z" />
      <path d="M6.3 13.5l-.5 1.2M9.4 13.5l-.5 1.2" :stroke-width="strokeWidth * 0.8" />
    </template>
    <template v-else-if="name === 'smile'">
      <circle cx="8" cy="8" r="6" />
      <path d="M5.7 9.3a2.7 2.7 0 0 0 4.6 0" />
      <path d="M6.2 6.3h.02M9.8 6.3h.02" />
    </template>
    <template v-else-if="name === 'heart'">
      <path d="M8 13.2S2.9 10.1 2.9 6.6A2.7 2.7 0 0 1 8 5.7a2.7 2.7 0 0 1 5.1.9c0 3.5-5.1 6.6-5.1 6.6z" />
    </template>
    <template v-else-if="name === 'pencil'">
      <path d="M11.3 2.6l2 2-7.5 7.5-2.8.8.8-2.8z" />
    </template>
    <template v-else-if="name === 'warning'">
      <path d="M8 2.5l5.7 9.9H2.3z" />
      <path d="M8 6.4v3.1M8 11.3h.02" />
    </template>
    <template v-else-if="name === 'arrow-up'">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 11.2V5.3M5.7 7.6L8 5.3l2.3 2.3" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="M6.3 4.2L10 8l-3.7 3.8" />
    </template>
    <template v-else-if="name === 'chevron-down'">
      <path d="M4.2 6.3L8 10l3.8-3.7" />
    </template>
    <template v-else-if="name === 'chevron-up'">
      <path d="M4.2 9.7L8 6l3.8 3.7" />
    </template>
  </svg>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 16,
    strokeWidth: 1.4,
  },
);
</script>
