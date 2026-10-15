import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { iconNameForSymbol } from '../src/views/session/helpers';

describe('views/session/helpers — iconNameForSymbol（SF Symbol → web 图标全表）', () => {
  const table: Array<[string, string]> = [
    ['sun.max.fill', 'sun'],
    ['book.closed.fill', 'book'],
    ['car.fill', 'car'],
    ['list.bullet.clipboard.fill', 'list'],
    ['list.bullet', 'list'],
    ['calendar.badge.exclamationmark', 'calendar-warning'],
    ['calendar.badge.clock', 'calendar-clock'],
    ['exclamationmark.triangle.fill', 'warning'],
    ['clock.arrow.circlepath', 'clock'],
    ['checkmark.circle.fill', 'check'],
    ['flag.fill', 'flag'],
    ['sparkles', 'sparkles'],
    ['circle', 'circle'],
    ['arrow.up.circle.fill', 'arrow-up'],
    ['arrow.right', 'chevron-right'],
    ['target', 'target'],
  ];

  it.each(table)('%s → %s', (symbol, icon) => {
    expect(iconNameForSymbol(symbol)).toBe(icon);
  });

  it('未知 / 空串 / null / undefined → target（对齐 Swift `?? "target"`）', () => {
    expect(iconNameForSymbol('mic.fill')).toBe('target');
    expect(iconNameForSymbol('')).toBe('target');
    expect(iconNameForSymbol(null)).toBe('target');
    expect(iconNameForSymbol(undefined)).toBe('target');
  });
});

/**
 * `SessionIcon` 对未知 `name` 会**静默渲染成空 SVG** —— 不报错、不警告，
 * 界面上就是「少了个图标」，极易漏到用户眼前才发现（2026-10-15 实际踩过：
 * 个人中心用了 `name="bell"`，而图标集里没有 bell）。
 *
 * 这条测试直接扫源码：凡是 `SessionIcon name="xxx"` 里出现的名字，
 * 都必须在组件里真的有一支 `v-else-if="name === 'xxx'"` 分支。
 */
describe('views/session/SessionIcon — 用到的图标名必须真的存在', () => {
  const SRC = join(__dirname, '..', 'src');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.vue') || full.endsWith('.ts') ? [full] : [];
    });
  }

  /** 组件里已实现的图标名（从 `name === '...'` 分支提取）。 */
  function implementedIcons(): Set<string> {
    const source = readFileSync(join(SRC, 'views', 'session', 'SessionIcon.vue'), 'utf8');
    return new Set(
      [...source.matchAll(/name === '([a-z-]+)'/g)].map((match) => match[1]!),
    );
  }

  /** 全仓 `SessionIcon ... name="..."` 的静态用法。 */
  function usedIcons(): Map<string, string[]> {
    const used = new Map<string, string[]>();
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      // ⚠️ 只看**字面量** name="x"。绑定形式 `:name="expr"` 是动态的，
      // 静态扫不出来（本项目目前没有这种用法；将来若引入需另想办法）。
      for (const match of source.matchAll(/<SessionIcon[^>]*\sname="([a-zA-Z-]+)"/g)) {
        const icon = match[1]!;
        used.set(icon, [...(used.get(icon) ?? []), file.replace(SRC, 'src')]);
      }
    }
    return used;
  }

  it('没有「用了但未实现」的图标名', () => {
    const implemented = implementedIcons();
    const missing = [...usedIcons().entries()]
      .filter(([icon]) => !implemented.has(icon))
      .map(([icon, files]) => `${icon}（出现在 ${[...new Set(files)].join(', ')}）`);

    expect(missing).toEqual([]);
  });

  it('扫得到用法（守卫本身没瞎，否则上一条会假绿）', () => {
    // 若正则写错、一个用法都扫不到，上一条断言会永远通过 —— 这条用来钉住它。
    expect(usedIcons().size).toBeGreaterThan(5);
    expect(implementedIcons().size).toBeGreaterThan(10);
  });
});
