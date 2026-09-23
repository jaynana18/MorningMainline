import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// P0 只跑 vitest（读取 vitest.config.ts）；此配置为 P1 接入视图层预留标准 Vite 工程。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
