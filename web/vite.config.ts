import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

// P0 只跑 vitest（读取 vitest.config.ts）；此配置为 P1 接入视图层预留标准 Vite 工程。
//
// ⚠️ base 必须是 './'：iOS 生产形态用 WKWebView + loadFileURL 走 `file://`，
// Vite 默认的 `base: '/'` 会把资源写成 `/assets/xxx.js` 这种绝对路径，
// 在 `file://` 下解析到文件系统根 → 404 → 白屏。改成相对路径后，引用变成 `./assets/xxx.js`，
// 相对 index.html 所在目录解析，`file://` 下才能正确加载。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const httpsHost = env.VITE_DEV_HTTPS_URL ? new URL(env.VITE_DEV_HTTPS_URL).hostname : undefined;
  return {
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    // 只允许配置的 HTTPS 域名，不放开所有 Host。
    allowedHosts: httpsHost ? [httpsHost] : [],
    proxy: {
      '/api/account/': {
        target: 'https://47.104.95.146',
        changeOrigin: true,
        secure: true,
      },
      '/api/model/': {
        target: 'https://47.104.95.146',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  plugins: [
    vue(),
    {
      name: 'wkwebview-classic-entry',
      apply: 'build',
      transformIndexHtml(html) {
        return html.replace('<script type="module" crossorigin', '<script defer');
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WKWebView 从 bundle 读取的是 file:// 页面。WebKit 会把本地 ES module
    // 当成 opaque origin，样式能加载但入口 <script type="module"> 会被 CORS
    // 拦下，最终只剩一张米色空画布。这里产出单文件 IIFE，并在构建 HTML 中
    // 改成普通 defer 脚本；开发服务器仍保持 Vite 的 module/HMR 行为。
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  };
});
