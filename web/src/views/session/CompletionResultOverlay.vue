<template>
  <!--
    CompletionResultOverlay（ContentView.swift 271–340）
    完成结算浮层：标题 / 强调值 / 原计划与当前时间 / 鼓励语 / 「收下啦」。
    点背景或「收下啦」关闭（对应 Swift 的 `dismiss`）。
  -->
  <div class="mm-overlay" @click.self="$emit('dismiss')" data-testid="completion-overlay">
    <div class="mm-result-card">
      <p class="mm-inline mm-hint" style="gap: 8px; font-weight: 700; margin: 0">
        <SessionIcon :name="result.isAhead ? 'sparkles' : 'cloud'" :size="15" />
        不跑偏 · 本次结果
      </p>

      <h2 class="mm-result__headline">{{ result.headline }}</h2>

      <p class="mm-result__emphasis">{{ result.emphasis }}</p>

      <div class="mm-result__times">
        <p v-if="result.plannedTime" style="margin: 0">原计划&nbsp;&nbsp;{{ result.plannedTime }}</p>
        <p style="margin: 0">当前时间&nbsp;&nbsp;{{ currentTime }}</p>
      </div>

      <div class="mm-result__banner">
        <SessionIcon :name="result.isAhead ? 'smile' : 'heart'" :size="20" />
        <span>{{ result.isAhead ? '今天也稳稳守住主线' : '没关系，下次继续守住主线' }}</span>
        <span class="mm-result__pencil">
          <SessionIcon name="pencil" :size="16" />
        </span>
      </div>

      <button class="mm-btn mm-btn--primary" @click="$emit('dismiss')">收下啦</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatClock, type CompletionResult } from './helpers';
import SessionIcon from './SessionIcon.vue';

const props = defineProps<{ result: CompletionResult }>();

defineEmits<{ dismiss: [] }>();

const currentTime = computed(() => formatClock(props.result.completedAt));
</script>
