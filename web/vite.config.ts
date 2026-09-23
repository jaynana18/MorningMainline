import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// P0 只跑 vitest（读取 vitest.config.ts）；此配置为 P1 接入视图层预留标准 Vite 工程。
//
// ⚠️ base 必须是 './'：iOS 生产形态用 WKWebView + loadFileURL 走 `file://`，
// Vite 默认的 `base: '/'` 会把资源写成 `/assets/xxx.js` 这种绝对路径，
// 在 `file://` 下解析到文件系统根 → 404 → 白屏。改成相对路径后，引用变成 `./assets/xxx.js`，
// 相对 index.html 所在目录解析，`file://` 下才能正确加载。
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
