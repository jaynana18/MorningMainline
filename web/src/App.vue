<template>
  <div class="app-shell">
    <router-view />

    <!-- 全局降级/失败提示（如「已回退本机规则」）。 -->
    <transition name="toast">
      <div v-if="store.notice" class="toast" role="status" data-testid="notice">
        {{ store.notice }}
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useRoutineStore } from './stores/routine';

const store = useRoutineStore();

onMounted(() => {
  void store.init();
});
</script>
