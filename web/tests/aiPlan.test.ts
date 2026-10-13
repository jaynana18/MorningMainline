import { describe, expect, it } from 'vitest';
import { readAIPlan } from '../src/core/aiPlan';

const plan = {
  preparation: [{ title: '刷牙', durationMinutes: 3 }, { title: '化妆', durationMinutes: 10 }],
  stops: [{ destination: '凯德', activities: [{ title: '逛', durationMinutes: 80 }] }, { destination: '宜家', activities: [{ title: '待', durationMinutes: 60 }] }],
  deadlineHour: 18, deadlineMinute: 0,
};
describe('AI计划校验与缓存复用', () => {
  it('保留地点顺序和复合停留时长', () => {
    const parsed = readAIPlan({ plan, cached: false });
    expect(parsed.preparation.map(step => step.duration)).toEqual([180, 600]);
    expect(parsed.stops.map(stop => [stop.query, stop.steps[0].duration])).toEqual([['凯德', 4800], ['宜家', 3600]]);
  });
  it('缓存结果按本次日期生成截止时刻，并为新任务分配新ID', () => {
    const a = readAIPlan({ plan, cached: true }, new Date(2026, 9, 13, 8));
    const b = readAIPlan({ plan, cached: true }, new Date(2026, 9, 14, 8));
    expect(a.deadline?.getDate()).toBe(13);
    expect(b.deadline?.getDate()).toBe(14);
    expect(b.deadline?.getHours()).toBe(18);
    expect(a.preparation[0].id).not.toBe(b.preparation[0].id);
  });
  it('异常时长和不完整时间拒绝生成，不回落到默认或本地规则', () => {
    expect(() => readAIPlan({ plan: { ...plan, preparation: [{ title: '刷牙', durationMinutes: -1 }] } })).toThrow();
    expect(() => readAIPlan({ plan: { ...plan, deadlineMinute: 90 } })).toThrow();
    expect(() => readAIPlan({ plan: { preparation: [], stops: [], deadlineHour: null, deadlineMinute: null } })).toThrow();
  });
});
