/**
 * Vue SFC 类型声明：让 `tsc --noEmit` 能解析 `*.vue` 导入。
 * SFC 内部模板的类型检查由 vue-tsc 负责，此处仅给出模块形状。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
