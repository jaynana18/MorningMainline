import { describe, expect, it } from 'vitest';
import {
  buildBodyVariants,
  chatCompletionsURL,
  cosmoMindConfiguration,
  createRemoteParsingConfiguration,
  decodePayload,
  doubleValue,
  extractJSONObject,
  isRejectedRequest,
  makeDeadline,
  minutes,
  normalize,
  RemoteRoutineParsingService,
  thinkingDisableBodyEntries,
} from '../src/core/remote';
import {
  THINKING_DISABLE_STYLES,
  type RemoteParsingConfiguration,
} from '../src/core/types';
import { localDate, TZ } from './helpers';

describe('remote — 云端宽松解析（M27，用例 24–37）', () => {
  it('用例 24：标准 JSON 字段', () => {
    const payload = decodePayload(
      '{"steps":[{"title":"去厕所","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}',
    );
    expect(payload?.steps.map((item) => item.title)).toEqual(['去厕所']);
    expect(payload?.steps[0].minutes).toBe(5);
    expect(payload?.deadlineHour).toBe(8);
    expect(payload?.deadlineMinute).toBe(35);
  });

  it('用例 25：剥 markdown 围栏 + 容忍前后白话', () => {
    const content =
      '好的，这是解析结果：\n```json\n{"steps":[{"title":"刷牙","durationMinutes":3}],"deadlineHour":null,"deadlineMinute":null}\n```\n需要我调整吗？';
    const payload = decodePayload(content);
    expect(payload?.steps.map((item) => item.title)).toEqual(['刷牙']);
    expect(payload?.deadlineHour).toBeNull();
  });

  it('用例 26：时长写成数字字符串', () => {
    const payload = decodePayload('{"steps":[{"title":"洗脸","durationMinutes":"5"}]}');
    expect(payload?.steps[0].minutes).toBe(5);
  });

  it('用例 27：实测自创字段名 tasks/name/duration_minutes/time', () => {
    const content =
      '{"tasks":[{"name":"去厕所","duration_minutes":5},{"name":"刷杯子","duration_minutes":2},{"name":"出门","time":"08:30"}]}';
    const payload = decodePayload(content);
    expect(payload?.steps.map((item) => item.title)).toEqual(['去厕所', '刷杯子']);
    expect(payload?.steps.map((item) => item.minutes)).toEqual([5, 2]);
    expect(payload?.deadlineHour).toBe(8);
    expect(payload?.deadlineMinute).toBe(30);
    expect(payload?.steps).toHaveLength(2);
  });

  it('用例 28：根是裸数组', () => {
    const payload = decodePayload('[{"title":"刷牙","durationMinutes":3}]');
    expect(payload?.steps.map((item) => item.title)).toEqual(['刷牙']);
  });

  it('用例 29：末项只有时刻无时长 → 当 deadline（「半」补 30）', () => {
    const payload = decodePayload(
      '{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}',
    );
    expect(payload?.steps.map((item) => item.title)).toEqual(['洗脸']);
    expect(payload?.deadlineHour).toBe(8);
    expect(payload?.deadlineMinute).toBe(30);
  });

  it('用例 30：顶层合成字段 deadline:"08:30"', () => {
    const payload = decodePayload('{"steps":[{"title":"洗脸","durationMinutes":5}],"deadline":"08:30"}');
    expect(payload?.deadlineHour).toBe(8);
    expect(payload?.deadlineMinute).toBe(30);
  });

  it('用例 31：只有截止无任务 → null', () => {
    expect(decodePayload('{"steps":[{"title":"出门","time":"8点半"}]}')).toBeNull();
  });

  it('用例 32：夹在中间的时刻只是描述，任务保留', () => {
    const payload = decodePayload(
      '{"steps":[{"title":"7点起床","time":"7:00"},{"title":"洗脸","durationMinutes":5}]}',
    );
    expect(payload?.steps.map((item) => item.title)).toEqual(['7点起床', '洗脸']);
  });

  it('用例 33：缺时长 → fallbackMinutes=5', () => {
    const payload = decodePayload(
      '{"steps":[{"title":"倒垃圾"},{"title":"洗脸","durationMinutes":5}]}',
    );
    expect(payload?.steps.map((item) => item.title)).toEqual(['倒垃圾', '洗脸']);
    expect(payload?.steps[0].minutes).toBe(RemoteRoutineParsingService.fallbackMinutes);
  });

  it('用例 34：空步骤列表 → null', () => {
    expect(decodePayload('{"steps":[]}')).toBeNull();
  });

  it('用例 35：垃圾输入 / 空串 → null', () => {
    expect(decodePayload('我不知道该怎么拆')).toBeNull();
    expect(decodePayload('')).toBeNull();
  });

  it('用例 36：时长字符串单位换算', () => {
    expect(minutes('5分钟')).toBe(5);
    expect(minutes('2小时')).toBe(120);
    expect(minutes('90秒')).toBe(1.5);
    expect(minutes('30min')).toBe(30);
    expect(minutes('没写')).toBeNull();
  });

  it('用例 37：makeDeadline 越界拒绝 / minute 缺省补 0', () => {
    const now = new Date();
    expect(makeDeadline(25, 0, now, TZ)).toBeNull();
    expect(makeDeadline(8, 70, now, TZ)).toBeNull();
    expect(makeDeadline(null, 30, now, TZ)).toBeNull();
    expect(makeDeadline(8, null, now, TZ)).not.toBeNull();
  });

  it('G15：minute 缺省补 0；「8点半」补 30（不得截成 08:00）', () => {
    const now = localDate(2026, 8, 13, 12, 0);
    const deadline = makeDeadline(8, null, now, TZ)!;
    expect([deadline.getHours(), deadline.getMinutes()]).toEqual([8, 0]);
    const payload = decodePayload('{"steps":[{"title":"出门","time":"8点半"}]}');
    expect(payload).toBeNull(); // 只有 deadline 无任务 → 回退
    const withTask = decodePayload(
      '{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}',
    );
    expect(withTask?.deadlineMinute).toBe(30);
  });
});

describe('remote — 网关地址、思考链开关与降级重试（M28，用例 38–44）', () => {
  it('用例 38：base URL 归一化（去尾斜杠、补 /chat/completions、不重复拼接）', () => {
    expect(chatCompletionsURL('https://gpt.cosmoplat.com/v1')).toBe(
      'https://gpt.cosmoplat.com/v1/chat/completions',
    );
    expect(chatCompletionsURL('https://gpt.cosmoplat.com/v1/')).toBe(
      'https://gpt.cosmoplat.com/v1/chat/completions',
    );
    expect(chatCompletionsURL('https://gpt.cosmoplat.com/v1/chat/completions')).toBe(
      'https://gpt.cosmoplat.com/v1/chat/completions',
    );
  });

  it('用例 39：cosmoMind 默认配置', () => {
    const configuration = cosmoMindConfiguration({ apiKey: 'sk-test' });
    expect(configuration.endpoint).toBe('https://gpt.cosmoplat.com/v1/chat/completions');
    expect(configuration.model).toBe('cosmo-mind-coder');
    expect(configuration.usesJSONMode).toBe(true);
    expect(configuration.retriesWithoutOptionalFields).toBe(true);
    expect(configuration.thinkingDisable).toBe('none');
  });

  it('用例 40：思考关闭样式完备，且 .none 写不出任何字段', () => {
    expect(THINKING_DISABLE_STYLES).toContain('enableThinking');
    expect(THINKING_DISABLE_STYLES).toContain('chatTemplateKwargs');
    expect(THINKING_DISABLE_STYLES).toContain('thinkingTypeDisabled');
    expect(thinkingDisableBodyEntries('none')).toEqual({});
    expect(thinkingDisableBodyEntries('enableThinking')).toEqual({ enable_thinking: false });
    expect(thinkingDisableBodyEntries('chatTemplateKwargs')).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(thinkingDisableBodyEntries('thinkingTypeDisabled')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('用例 41：仅请求形状错误触发降级重试', () => {
    expect(isRejectedRequest(400)).toBe(true);
    expect(isRejectedRequest(422)).toBe(true);
    expect(isRejectedRequest(401)).toBe(false);
    expect(isRejectedRequest(429)).toBe(false);
    expect(isRejectedRequest(500)).toBe(false);
  });

  it('用例 42：请求体变体由全到简（4 档）', () => {
    const configuration = createRemoteParsingConfiguration({
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'test',
      usesJSONMode: true,
      thinkingDisable: 'chatTemplateKwargs',
    });
    expect(configuration.bodyVariants).toEqual([
      { usesJSONMode: true, thinkingDisable: 'chatTemplateKwargs' },
      { usesJSONMode: true, thinkingDisable: 'none' },
      { usesJSONMode: false, thinkingDisable: 'chatTemplateKwargs' },
      { usesJSONMode: false, thinkingDisable: 'none' },
    ]);
  });

  it('用例 43：thinking=.none 时不产生多余变体（2 档）', () => {
    const configuration = createRemoteParsingConfiguration({
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'test',
      usesJSONMode: true,
      thinkingDisable: 'none',
    });
    expect(configuration.bodyVariants).toEqual([
      { usesJSONMode: true, thinkingDisable: 'none' },
      { usesJSONMode: false, thinkingDisable: 'none' },
    ]);
  });

  it('用例 44：两开关都关 → 单一最简变体，无重复', () => {
    const configuration = createRemoteParsingConfiguration({
      endpoint: 'https://example.com/v1/chat/completions',
      model: 'test',
      usesJSONMode: false,
      thinkingDisable: 'none',
    });
    expect(configuration.bodyVariants).toEqual([{ usesJSONMode: false, thinkingDisable: 'none' }]);
  });
});

describe('remote — 工具函数与静态契约方法', () => {
  it('normalize：忽略大小写与下划线/连字符', () => {
    expect(normalize('duration_minutes')).toBe(normalize('durationMinutes'));
    expect(normalize('duration_minutes')).toBe(normalize('DURATION-MINUTES'));
  });

  it('extractJSONObject：对象嵌数组取起点更早者；裸数组取数组', () => {
    expect(extractJSONObject('{"steps":[{"a":1}]}')).toBe('{"steps":[{"a":1}]}');
    expect(extractJSONObject('[{"a":1}]')).toBe('[{"a":1}]');
    expect(extractJSONObject('no json here')).toBeNull();
  });

  it('doubleValue：数字/数字串，非法返回 null', () => {
    expect(doubleValue(5)).toBe(5);
    expect(doubleValue(' 5 ')).toBe(5);
    expect(doubleValue('abc')).toBeNull();
  });

  it('静态契约方法可用（§4 导出名）', () => {
    expect(RemoteRoutineParsingService.normalize('duration_minutes')).toBe('durationminutes');
    expect(RemoteRoutineParsingService.minutes('2小时')).toBe(120);
    expect(RemoteRoutineParsingService.isRejectedRequest(422)).toBe(true);
    expect(RemoteRoutineParsingService.decodePayload('{"steps":[]}')).toBeNull();
    expect(
      RemoteRoutineParsingService.makeDeadline(8, 30, localDate(2026, 8, 13, 12, 0), TZ)!.getHours(),
    ).toBe(8);
    const configuration: RemoteParsingConfiguration =
      RemoteRoutineParsingService.cosmoMind({ apiKey: null });
    expect(RemoteRoutineParsingService.buildBodyVariants(configuration)).toHaveLength(2);
    expect(RemoteRoutineParsingService.fallbackMinutes).toBe(5);
  });

  it('buildBodyVariants 独立函数与配置 getter 一致', () => {
    expect(buildBodyVariants({ usesJSONMode: false, thinkingDisable: 'none' })).toEqual([
      { usesJSONMode: false, thinkingDisable: 'none' },
    ]);
  });
});
