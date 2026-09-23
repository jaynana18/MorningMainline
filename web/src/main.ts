import { DEFAULT_TEMPLATES } from './core/types';

// 阶段 P0 只落地纯逻辑层（src/core/），界面在 P1 接入。
// 这里提供一个最小可运行入口，便于 `vite dev` 校验工程脚手架可用；不承载任何业务语义。
const root = document.querySelector<HTMLDivElement>('#app');
if (root) {
  root.textContent = `不跑偏 · 内置任务线 ${DEFAULT_TEMPLATES.length} 条（P0 逻辑层已就绪）`;
}
