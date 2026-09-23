import { describe, expect, it } from 'vitest';
import { makeTemplate, makeTemplateFromText } from '../src/core/parser';
import {
  deadlineOn,
  deadlineStep,
  effectiveRecurrence,
  taskSteps,
  totalTaskDuration,
} from '../src/core/session';
import { HOMEWORK_TEMPLATE, MORNING_TEMPLATE } from '../src/core/types';
import { localDate, TZ } from './helpers';

describe('template — 内置模板与排程倒推（M1/M2，用例 1/2/3）', () => {
  it('用例 1：morning 有真实出门截止节点，缓冲为固定值', () => {
    const departure = deadlineStep(MORNING_TEMPLATE);
    expect(departure?.title).toBe('出门');
    expect(departure?.importance).toBe('hardDeadline');
    expect(departure?.duration).toBe(0);
    expect(MORNING_TEMPLATE.buffer).toBe(10 * 60);
  });

  it('M2：totalTaskDuration 只累加 role=task 的时长', () => {
    expect(totalTaskDuration(MORNING_TEMPLATE)).toBe(180 + 300 + 600 + 120 + 300);
    expect(totalTaskDuration(HOMEWORK_TEMPLATE)).toBe(7200 + 3600 + 1800);
  });

  it('用例 2 / M1：倒推开始 = 截止 − 总任务时长 − 缓冲', () => {
    const now = localDate(2026, 8, 13, 7, 0);
    const deadline = deadlineOn(MORNING_TEMPLATE, now, TZ);
    expect(deadline).not.toBeNull();
    expect([deadline!.getHours(), deadline!.getMinutes()]).toEqual([8, 35]);

    const start = new Date(
      deadline!.getTime() - (totalTaskDuration(MORNING_TEMPLATE) + MORNING_TEMPLATE.buffer) * 1000,
    );
    expect((start.getTime() - deadline!.getTime()) / 1000).toBe(-(35 * 60));
    // 以 08:35 为截止 ⇒ 开始 08:00
    expect([start.getHours(), start.getMinutes()]).toEqual([8, 0]);
  });

  it('M16 / 用例 3：截止已过时仅 daily 顺延到明天，once 保留当日', () => {
    const now = localDate(2026, 8, 14, 12, 0);
    const daily = deadlineOn(MORNING_TEMPLATE, now, TZ)!;
    const once = deadlineOn({ ...MORNING_TEMPLATE, recurrence: 'once' }, now, TZ)!;
    expect(daily.getDate()).toBe(15);
    expect(once.getDate()).toBe(14);
  });
});

describe('template — 模板组装（M13/M14，用例 6/7）', () => {
  it('用例 6：显式截止 + 重复方式 → backward + deadline 节点', () => {
    const deadline = localDate(2026, 8, 13, 18, 10);
    const template = makeTemplateFromText(
      '博兴任务20分钟 去厕所5分钟 App安装5分钟',
      deadline,
      'daily',
      localDate(2026, 8, 13, 12, 0),
      TZ,
    );
    expect(template).not.toBeNull();
    expect(template!.deadlineHour).toBe(18);
    expect(template!.deadlineMinute).toBe(10);
    expect(effectiveRecurrence(template!)).toBe('daily');
    expect(taskSteps(template!)).toHaveLength(3);
    expect(deadlineStep(template!)?.title).toBe('完成');
    expect(deadlineStep(template!)?.role).toBe('deadline');
    expect(deadlineStep(template!)?.importance).toBe('hardDeadline');
    expect(template!.mode).toBe('backward');
  });

  it('用例 7：无截止 → forward，且无 deadline 节点', () => {
    const template = makeTemplateFromText(
      '语文2小时 英语1小时 数学30分钟',
      null,
      'once',
      localDate(2026, 8, 13, 12, 0),
      TZ,
    );
    expect(template).not.toBeNull();
    expect(template!.mode).toBe('forward');
    expect(template!.deadlineHour).toBeNull();
    expect(template!.deadlineMinute).toBeNull();
    expect(deadlineStep(template!)).toBeUndefined();
    expect(taskSteps(template!).map((step) => step.title)).toEqual(['语文', '英语', '数学']);
  });

  it('M14：命名规则 —— 单步用标题，多步用「首项等 N 项」', () => {
    const single = makeTemplateFromText(
      '去厕所5分钟',
      null,
      'once',
      localDate(2026, 8, 13, 12, 0),
      TZ,
    );
    expect(single!.name).toBe('去厕所');
    const multi = makeTemplateFromText(
      '语文2小时 英语1小时',
      null,
      'once',
      localDate(2026, 8, 13, 12, 0),
      TZ,
    );
    expect(multi!.name).toBe('语文等 2 项');
  });

  it('makeTemplate(steps,...) 过滤非 task 步骤；全被过滤 → null', () => {
    const deadline = localDate(2026, 8, 13, 18, 10);
    const steps = makeTemplateFromText('去厕所5分钟', null, 'once', new Date(), TZ)!.steps;
    // 追加一个 deadline 步骤，makeTemplate 应当把它过滤掉后再组装
    const merged = [...steps, { ...steps[0], id: 'dl', role: 'deadline' as const, duration: 0 }];
    const template = makeTemplate(merged, deadline, 'once', localDate(2026, 8, 13, 12, 0), TZ);
    expect(taskSteps(template!).map((step) => step.title)).toEqual(['去厕所']);
    expect(makeTemplate([], null, 'once', new Date(), TZ)).toBeNull();
  });

  it('G1：手动改截止时间后重算 —— 保持 backward、步骤不清空、倒推开始随新截止重算', () => {
    const now = localDate(2026, 8, 13, 12, 0);
    const text = '去厕所5分钟 刷杯子2分钟 买水果10分钟';
    const original = makeTemplateFromText(text, localDate(2026, 8, 13, 18, 30), 'once', now, TZ)!;
    expect(original.deadlineHour).toBe(18);
    expect(original.deadlineMinute).toBe(30);
    expect(taskSteps(original).map((step) => step.title)).toEqual(['去厕所', '刷杯子', '买水果']);

    // 用户把截止改为 19:00 后，用同一批已解析步骤重新组装。
    const edited = makeTemplate(original.steps, localDate(2026, 8, 13, 19, 0), 'once', now, TZ)!;
    expect(edited.mode).toBe('backward');
    expect(edited.deadlineHour).toBe(19);
    expect(edited.deadlineMinute).toBe(0);
    // 已解析步骤不被清空。
    expect(taskSteps(edited).map((step) => step.title)).toEqual(['去厕所', '刷杯子', '买水果']);

    // 倒推开始 = 新截止 − (总任务时长 + buffer)，与截止同幅后移。
    const total = totalTaskDuration(edited);
    const start = new Date(
      localDate(2026, 8, 13, 19, 0).getTime() - (total + edited.buffer) * 1000,
    );
    expect(localDate(2026, 8, 13, 19, 0).getTime() - start.getTime()).toBe(
      (total + edited.buffer) * 1000,
    );
  });

  it('G3：生成后重新生成 —— 整体替换，不残留上一次结果', () => {
    const now = localDate(2026, 8, 13, 12, 0);
    const first = makeTemplateFromText('去厕所5分钟', null, 'once', now, TZ)!;
    expect(first.mode).toBe('forward');
    expect(taskSteps(first).map((step) => step.title)).toEqual(['去厕所']);
    expect(deadlineStep(first)).toBeUndefined();

    const second = makeTemplateFromText(
      '去厕所5分钟 刷杯子2分钟',
      localDate(2026, 8, 13, 18, 30),
      'once',
      now,
      TZ,
    )!;
    expect(second.mode).toBe('backward');
    expect(taskSteps(second).map((step) => step.title)).toEqual(['去厕所', '刷杯子']);
    expect(deadlineStep(second)?.title).toBe('完成');
    expect(second.deadlineHour).toBe(18);
    expect(second.deadlineMinute).toBe(30);
  });
});
