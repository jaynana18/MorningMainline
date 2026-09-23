import { describe, expect, it } from 'vitest';
import {
  analyze,
  chineseNumber,
  inferredDeadline,
  makeSteps,
} from '../src/core/parser';
import { anchorNoon, formatHM, localDate, TZ } from './helpers';

function assertDeadline(input: string, expected: string | null): void {
  const deadline = inferredDeadline(input, anchorNoon(), TZ);
  if (expected === null) {
    expect(deadline, `「${input}」不应被识别为截止时间`).toBeNull();
    return;
  }
  expect(deadline, `「${input}」应当被识别为截止时间`).not.toBeNull();
  expect(formatHM(deadline!)).toBe(expected);
}

describe('parser — 规则解析（M10/M12，用例 4/10/11/12/13/14）', () => {
  it('用例 4：只产出任务步骤，截止表达式被剥离', () => {
    const steps = makeSteps('博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分');
    expect(steps.map((step) => step.title)).toEqual(['博兴任务', '去厕所', 'App安装']);
    expect(steps.map((step) => step.duration)).toEqual([20 * 60, 5 * 60, 5 * 60]);
    expect(steps.every((step) => step.role === 'task')).toBe(true);
  });

  it('M12：小时 ×3600、分钟 ×60；标题剔除「然后/再/先」', () => {
    const steps = makeSteps('语文2小时 英语1小时 数学30分钟');
    expect(steps.map((step) => [step.title, step.duration])).toEqual([
      ['语文', 7200],
      ['英语', 3600],
      ['数学', 1800],
    ]);
    expect(makeSteps('先洗脸5分钟').map((step) => step.title)).toEqual(['洗脸']);
  });

  it('用例 10：所有时长被吃下 → leftover 为空、isComplete', () => {
    const outcome = analyze('博兴任务20分钟  去厕所5分钟', anchorNoon(), TZ);
    expect(outcome.steps.map((step) => step.title)).toEqual(['博兴任务', '去厕所']);
    expect(outcome.leftover).toBe('');
    expect(outcome.isComplete).toBe(true);
  });

  it('用例 11：未读懂片段进入 leftover', () => {
    const outcome = analyze('去厕所5分钟 别忘了倒垃圾', anchorNoon(), TZ);
    expect(outcome.steps.map((step) => step.title)).toEqual(['去厕所']);
    expect(outcome.leftover).toBe('别忘了倒垃圾');
    expect(outcome.isComplete).toBe(false);
  });

  it('用例 12：截止表达式不算未读懂', () => {
    const outcome = analyze('去厕所5分钟 截止时间18点10分', anchorNoon(), TZ);
    expect(outcome.steps.map((step) => step.title)).toEqual(['去厕所']);
    expect(outcome.leftover).toBe('');
    expect(outcome.deadline).not.toBeNull();
  });

  it('用例 13：时间在前的锚点词不污染 leftover，且能读 h:m', () => {
    const now = localDate(2026, 8, 13, 6, 0);
    const outcome = analyze('去厕所5分钟 8点出门', now, TZ);
    expect(outcome.steps.map((step) => step.title)).toEqual(['去厕所']);
    expect(outcome.leftover).toBe('');
    expect(outcome.deadline).not.toBeNull();
    expect(outcome.deadline!.getHours()).toBe(8);
    expect(outcome.deadline!.getMinutes()).toBe(0);
  });

  it('M10 / 用例 14：规范示例端到端 —— 3 任务 + 时间在前截止', () => {
    const outcome = analyze(
      '18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟',
      anchorNoon(),
      TZ,
    );
    expect(outcome.steps.map((step) => step.title)).toEqual(['去厕所', '刷杯子', '买水果']);
    expect(outcome.isComplete).toBe(true);
    expect(outcome.deadline).not.toBeNull();
    expect([outcome.deadline!.getHours(), outcome.deadline!.getMinutes()]).toEqual([18, 30]);
  });
});

describe('parser — 截止时间识别的语序与「半」（M5–M9/M11，用例 16/17/18）', () => {
  it('用例 16 / M7：四种语序的「半点」均得 :30', () => {
    assertDeadline('出门10点半', '10:30');
    assertDeadline('结束8点半', '8:30');
    assertDeadline('8点半出门', '8:30');
    assertDeadline('18点半结束', '18:30');
  });

  it('用例 17 / M5/M6/M8：锚点在前与时间在前两种语序回归', () => {
    assertDeadline('结束18:10', '18:10');
    assertDeadline('结束 18:10', '18:10');
    assertDeadline('截止8:35', '8:35');
    assertDeadline('结束18点10分', '18:10');
    assertDeadline('出门10点', '10:00');
    assertDeadline('去厕所5分钟 结束8:35', '8:35');
    assertDeadline('18点30结束，去厕所5分钟', '18:30');
    assertDeadline('8点出门', '8:00');
    assertDeadline('18:30结束', '18:30');
    assertDeadline('18点30分结束', '18:30');
    assertDeadline('18点结束', '18:00');
  });

  it('用例 18 / M9：普通任务时长不得被误判为截止', () => {
    assertDeadline('买水果10分钟', null);
    assertDeadline('去厕所5分钟 刷杯子2分钟', null);
    assertDeadline('7点起床，洗脸5分钟', null);
  });

  it('M11：越界时分被拒绝（hour∉0..23 或 minute∉0..59）', () => {
    // 「结束25:00」小时越界 → null；「8点70」分钟越界 → null
    assertDeadline('结束25:00', null);
    assertDeadline('8点70出门', null);
  });

  it('G16：「半」只在「点半」固定组合里归一，任务名里的「半」不受影响', () => {
    const steps = makeSteps('去厕所五分钟 刷杯子两分钟');
    expect(steps.map((step) => [step.title, step.duration])).toEqual([
      ['去厕所', 5 * 60],
      ['刷杯子', 2 * 60],
    ]);
    const half = makeSteps('半个西瓜20分钟');
    expect(half.map((step) => step.title)).toEqual(['半个西瓜']);
    expect(half[0].duration).toBe(20 * 60);
  });

  it('中文数字工具语义自检', () => {
    expect(chineseNumber('十')).toBe(10);
    expect(chineseNumber('十五')).toBe(15);
    expect(chineseNumber('二十')).toBe(20);
    expect(chineseNumber('三')).toBe(3);
    expect(chineseNumber('半')).toBeNull();
  });

  it('空输入返回空步骤', () => {
    expect(makeSteps('   ')).toEqual([]);
  });
});
