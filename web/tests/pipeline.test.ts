import { describe, expect, it } from 'vitest';
import { RoutineParsingPipeline, RuleRoutineParsingService } from '../src/core/pipeline';
import { makeParseResult, type ParseResult, type RoutineParsingService } from '../src/core/types';
import { createStep } from '../src/core/types';
import {
  RemoteRoutineParsingService,
  createRemoteParsingConfiguration,
} from '../src/core/remote';
import { anchorNoon, TZ } from './helpers';

class RecordingService implements RoutineParsingService {
  readonly source = 'enhanced' as const;
  callCount = 0;
  constructor(private readonly result: ParseResult | null) {}
  async parse(): Promise<ParseResult | null> {
    this.callCount += 1;
    return this.result;
  }
}

class StubService implements RoutineParsingService {
  readonly source = 'enhanced' as const;
  constructor(
    private readonly result: ParseResult | null,
    private readonly shouldThrow = false,
  ) {}
  async parse(): Promise<ParseResult | null> {
    if (this.shouldThrow) {
      throw new Error('unavailable');
    }
    return this.result;
  }
}

function pipelineWith(enhanced: RoutineParsingService | null): RoutineParsingPipeline {
  return new RoutineParsingPipeline({ enhanced, tz: TZ });
}

describe('pipeline — 规则优先 / 模型补位（M23–M26，用例 15/19/20/21/22/23）', () => {
  it('用例 15：纯规则管线直接拿到时间在前的截止', async () => {
    const result = await new RoutineParsingPipeline({ tz: TZ }).parse(
      '18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟',
      anchorNoon(),
    );
    expect(result?.deadline).not.toBeNull();
    expect([result!.deadline!.getHours(), result!.deadline!.getMinutes()]).toEqual([18, 30]);
    expect(result?.steps).toHaveLength(3);
  });

  it('用例 19 / M23：规则读全则不调用增强（零成本短路）', async () => {
    const recorder = new RecordingService(null);
    const pipeline = pipelineWith(recorder);
    const result = await pipeline.parse('去厕所5分钟', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(recorder.callCount).toBe(0);
  });

  it('用例 20 / M24：增强抛错 → 回退规则', async () => {
    const pipeline = pipelineWith(new StubService(null, true));
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所']);
  });

  it('用例 21 / M25：增强任务数严格更多 → 整体采用', async () => {
    const better = makeParseResult({
      steps: [
        createStep({ title: '去厕所', duration: 5 * 60 }),
        createStep({ title: '倒垃圾', duration: 2 * 60 }),
      ],
      deadline: null,
      source: 'enhanced',
      leftover: '',
    });
    const pipeline = pipelineWith(new StubService(better));
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('enhanced');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所', '倒垃圾']);
  });

  it('用例 22 / M25：增强任务数不严格多于 → 保留规则步骤', async () => {
    const noBetter = makeParseResult({
      steps: [createStep({ title: '别的', duration: 60 })],
      deadline: null,
      source: 'enhanced',
      leftover: '',
    });
    const pipeline = pipelineWith(new StubService(noBetter));
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所']);
  });

  it('用例 23 / M26：数量持平 + 规则无 deadline → 吸收增强 deadline', async () => {
    const deadline = new Date(2026, 7, 13, 18, 30);
    const withDeadline = makeParseResult({
      steps: [createStep({ title: '去厕所', duration: 5 * 60 })],
      deadline,
      source: 'enhanced',
      leftover: '',
    });
    const pipeline = pipelineWith(new StubService(withDeadline));
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('enhanced');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所']);
    expect(result?.deadline?.getTime()).toBe(deadline.getTime());
  });

  it('G4：增强返回 null → 回退规则（source=rule，leftover 非空）', async () => {
    const pipeline = pipelineWith(new StubService(null));
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所']);
    expect(result?.leftover).not.toBe('');
  });

  it('G5：增强请求超时/抛错 → 被管线吞掉并回退规则，且有可观测日志', async () => {
    const logs: string[] = [];
    // 注入超时桩：fetcher 抛出（等价 URLSession 超时），绝不真连网关。
    const service = new RemoteRoutineParsingService(
      createRemoteParsingConfiguration({
        endpoint: 'https://example.invalid/v1/chat/completions',
        model: 'stub',
        timeout: 8,
      }),
      {
        tz: TZ,
        logger: (message) => logs.push(message),
        fetcher: async () => {
          throw new Error('AbortError: timeout');
        },
      },
    );

    // 增强层自身把超时抛出去……
    await expect(service.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon())).rejects.toThrow();
    expect(logs.length).toBeGreaterThan(0);

    // ……但管线把它吞掉，整体回退规则结果，创建流程不被卡住。
    const pipeline = new RoutineParsingPipeline({ enhanced: service, tz: TZ });
    const result = await pipeline.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(result?.steps.map((step) => step.title)).toEqual(['去厕所']);
  });

  it('hasEnhancedPath / setEnhanced 反映增强通道状态', () => {
    const pipeline = new RoutineParsingPipeline({ tz: TZ });
    expect(pipeline.hasEnhancedPath).toBe(false);
    pipeline.setEnhanced(new StubService(null));
    expect(pipeline.hasEnhancedPath).toBe(true);
    pipeline.enhanced = null;
    expect(pipeline.hasEnhancedPath).toBe(false);
  });

  it('RuleRoutineParsingService：无步骤返回 null，有步骤带 leftover', async () => {
    const service = new RuleRoutineParsingService(TZ);
    expect(await service.parse('别忘了倒垃圾', anchorNoon())).toBeNull();
    const result = await service.parse('去厕所5分钟 别忘了倒垃圾', anchorNoon());
    expect(result?.source).toBe('rule');
    expect(result?.leftover).toBe('别忘了倒垃圾');
  });
});
