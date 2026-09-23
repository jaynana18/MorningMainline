/**
 * core/pipeline.ts — 规则优先、模型补位的解析管线（LOGIC_PORT_SPEC §2.1 / RoutineParsingService.swift）。
 *
 * 三个分支的严格优先级（§4 M23–M26）：
 *   1. 规则读全（leftover === ""）→ 直接返回，不调用增强（零成本短路）；
 *   2. 规则抛错 / 增强抛错 → 始终回退到可用的一方；
 *   3. 数量严格更多才整体采用增强；数量持平且规则无 deadline → 吸收增强 deadline。
 */

import type { ParseResult, RoutineParsingService } from './types';
import { makeParseResult } from './types';
import { analyze } from './parser';
import { defaultTimeZone } from './serialization';

/** 本机正则解析（毫秒级、零成本、离线可用）。 */
export class RuleRoutineParsingService implements RoutineParsingService {
  readonly source = 'rule' as const;
  private readonly tz: string;

  constructor(tz: string = defaultTimeZone()) {
    this.tz = tz;
  }

  async parse(input: string, now: Date): Promise<ParseResult | null> {
    const outcome = analyze(input, now, this.tz);
    if (!outcome.hasSteps) {
      return null;
    }
    return makeParseResult({
      steps: outcome.steps,
      deadline: outcome.deadline,
      source: 'rule',
      leftover: outcome.leftover,
    });
  }
}

/**
 * 解析管线。规则优先，`enhanced`（云端/端侧模型）只做补位。
 */
export class RoutineParsingPipeline {
  private ruleService: RoutineParsingService;
  private enhancedService: RoutineParsingService | null;

  constructor(options?: {
    rule?: RoutineParsingService;
    enhanced?: RoutineParsingService | null;
    tz?: string;
  }) {
    this.ruleService = options?.rule ?? new RuleRoutineParsingService(options?.tz);
    this.enhancedService = options?.enhanced ?? null;
  }

  /** 兼容 Swift 的属性式访问：`pipeline.rule`。 */
  get rule(): RoutineParsingService {
    return this.ruleService;
  }

  set rule(service: RoutineParsingService) {
    this.ruleService = service;
  }

  /** 兼容 Swift 的属性式访问：`pipeline.enhanced`。 */
  get enhanced(): RoutineParsingService | null {
    return this.enhancedService;
  }

  set enhanced(service: RoutineParsingService | null) {
    this.enhancedService = service;
  }

  /** §4 契约：注入 / 清空增强实现。 */
  setEnhanced(impl: RoutineParsingService | null): void {
    this.enhancedService = impl;
  }

  /** 是否已接入慢速通道（界面据此决定要不要显示加载态）。 */
  get hasEnhancedPath(): boolean {
    return this.enhancedService !== null;
  }

  async parse(input: string, now: Date = new Date()): Promise<ParseResult | null> {
    const fast = await this.tryParse(this.ruleService, input, now);
    if (fast && fast.isComplete) {
      return fast;
    }

    const better = this.enhancedService
      ? await this.tryParse(this.enhancedService, input, now)
      : null;

    if (!fast) {
      return better;
    }
    if (!better) {
      return fast;
    }
    if (better.steps.length > fast.steps.length) {
      return better;
    }

    // 任务数没增加 → 保留规则那份更确定的步骤；仅当规则没有 deadline 时吸收增强的 deadline。
    if (fast.deadline === null && better.deadline !== null) {
      return makeParseResult({
        steps: fast.steps,
        deadline: better.deadline,
        source: 'enhanced',
        leftover: fast.leftover,
      });
    }
    return fast;
  }

  /** 抛错视作 null（对应 Swift 的 `try?`）。 */
  private async tryParse(
    service: RoutineParsingService,
    input: string,
    now: Date,
  ): Promise<ParseResult | null> {
    try {
      return await service.parse(input, now);
    } catch {
      return null;
    }
  }
}
