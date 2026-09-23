import { describe, expect, it } from 'vitest';
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
