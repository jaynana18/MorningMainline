/**
 * core/parser.ts — QuickRoutineParser 等价实现（LOGIC_PORT_SPEC §2.1）。
 *
 * 纯字符串/整数运算（约束 W6），不依赖 locale，不读全局时区。
 * 所有时间函数显式接收 `now` 与 `tz`（约束 W4）。
 */

import type { ParseOutcome, Recurrence, RoutineStep, RoutineTemplate } from './types';
import { createStep, createTemplate, makeParseOutcome } from './types';
import { getZonedComponents, setHoursInTz } from './serialization';

/** 「任务名 + 时长」的匹配式。解析与残余计算共用同一份，避免两套规则跑偏。 */
const STEP_PATTERN_SOURCE = '([^|\\d]+?)\\s*(\\d+(?:\\.5)?)\\s*(小时|h|H|分钟|分)';

/** 时间锚点词（截止节点可能前后出现这些词）。 */
const DEADLINE_ANCHORS = ['结束', '出门', '截止', '完成', '到期', '到达', '到'];
const ANCHOR_ALTERNATION = DEADLINE_ANCHORS.join('|');

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 全局正则替换（对应 Swift `replacing(pattern:in:with:)`）。 */
export function replacing(pattern: string, text: string, replacement: string): string {
  return text.replace(new RegExp(pattern, 'g'), replacement);
}

/** 中文数字 → 阿拉伯数字；遇到无法映射且非「十」的字符返回 null。 */
export function chineseNumber(text: string): number | null {
  let total = 0;
  let current = 0;
  for (const character of text) {
    if (Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, character)) {
      current = CHINESE_DIGITS[character];
    } else if (character === '十') {
      total += Math.max(1, current) * 10;
      current = 0;
    } else {
      return null;
    }
  }
  return total + current;
}

/**
 * 只转换紧挨着时长单位的中文数字，避免误改任务名称里的中文数字。
 * 正则 `([零〇一二三四五六七八九十两]+)\s*(?:个)?\s*(小时|分钟|分)`。
 */
export function replacingChineseDurationNumerals(text: string): string {
  const pattern = /([零〇一二三四五六七八九十两]+)\s*(?:个)?\s*(小时|分钟|分)/g;
  return text.replace(pattern, (full, numeral: string, unit: string) => {
    const value = chineseNumber(numeral);
    return value === null ? full : `${value}${unit}`;
  });
}

/** 去掉字符串首尾的空白与给定标点。 */
function stripEdges(text: string, punctuation: string): string {
  const escaped = punctuation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[\\s${escaped}]+|[\\s${escaped}]+$`, 'g');
  return text.replace(pattern, '');
}

/**
 * 把「任务名 + 时长」与截止时间表达统一规整成用 `|` 分段的中间文本。
 * 顺序（与 Swift 一致）：
 *   1. 中文数字时长归一；
 *   2. 截止表达整体替换为 `|`；
 *   3. 中文标点 `；，,。、` → `|`。
 */
export function normalizedSource(input: string): string {
  const normalizedDurations = replacingChineseDurationNumerals(input);
  const replacedDeadline = replacing(
    '(?:截止时间|截止|完成时间|到期时间)?\\s*\\d{1,2}\\s*(?:点|:|：)\\s*\\d{0,2}\\s*分?',
    normalizedDurations,
    '|',
  );
  return replacedDeadline.replace(/[；，,。、]/g, '|');
}

/** 识别「结束 18:10」「18点30结束」「出门 10 点」「出门10点半」等最终节点时间。 */
export function inferredDeadline(input: string, now: Date, tz: string): Date | null {
  // 「半」在正则里难表达，先归一成显式分钟：`10点半` → `10点30`、`8点半出门` → `8点30出门`。
  // 只替换「点半」这个固定组合，不影响任务名里其他位置的「半」（如「买半个西瓜」）。
  const normalized = input.split('点半').join('点30');

  // 组 1/2 = 锚点在前写法；组 3/4 = 时间在前写法（小时后必须跟「点/: /：」，分钟缺省为 0）。
  const pattern = new RegExp(
    `(?:${ANCHOR_ALTERNATION})(?:时间)?\\s*(\\d{1,2})(?:\\s*(?:点|:|：)\\s*(\\d{1,2}))?\\s*分?` +
      `|(\\d{1,2})\\s*(?:点|:|：)\\s*(\\d{0,2})\\s*分?\\s*(?:${ANCHOR_ALTERNATION})`,
  );
  const match = pattern.exec(normalized);
  if (!match) {
    return null;
  }

  let hour: number;
  let minute: number;
  if (match[1] !== undefined) {
    hour = Number.parseInt(match[1], 10);
    minute = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
  } else if (match[3] !== undefined) {
    hour = Number.parseInt(match[3], 10);
    minute = match[4] !== undefined && match[4] !== '' ? Number.parseInt(match[4], 10) : 0;
  } else {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return setHoursInTz(now, hour, minute, tz);
}

/**
 * 一句话只解析「任务名称 + 时长」。截止时间和重复方式由明确控件提供。
 */
export function makeSteps(input: string): RoutineStep[] {
  const compact = input.trim();
  if (compact === '') {
    return [];
  }

  const source = normalizedSource(compact);
  const regex = new RegExp(STEP_PATTERN_SOURCE, 'g');
  const steps: RoutineStep[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const title = stripEdges(
      match[1].split('然后').join('').split('再').join('').split('先').join(''),
      '|',
    );
    const number = Number.parseFloat(match[2]);
    const unit = match[3];
    const duration = unit === '小时' || unit.toLowerCase() === 'h' ? number * 3600 : number * 60;
    if (duration > 0 && title !== '') {
      steps.push(createStep({ title, duration }));
    }
  }
  return steps;
}

/**
 * 去掉所有已被「任务名 + 时长」吃掉的片段，剩下的就是规则没读懂的内容。
 *
 * 注：Swift 的 `leftoverText(from:)` 只接收 input；§4 契约额外列出 `deadline` 形参，
 * 这里保留该形参以对齐导出签名，但不参与计算（与 Swift 行为一致）。
 */
export function leftoverText(input: string, _deadline?: Date | null): string {
  const compact = input.trim();
  if (compact === '') {
    return '';
  }

  let residue = normalizedSource(compact).replace(new RegExp(STEP_PATTERN_SOURCE, 'g'), '');
  residue = residue.split('|').join('');
  // 「结束 8:35」「8 点出门」这类时间锚点不是任务，被切碎后不该算作没读懂。
  for (const anchor of DEADLINE_ANCHORS) {
    residue = residue.split(anchor).join('');
  }
  return stripEdges(residue, '，,。；;、|');
}

/** 一次拿到任务、截止时间与残余文本。 */
export function analyze(input: string, now: Date, tz: string): ParseOutcome {
  return makeParseOutcome({
    steps: makeSteps(input),
    deadline: inferredDeadline(input, now, tz),
    leftover: leftoverText(input),
  });
}

/**
 * 由已解析好的步骤组装任务线。模板形状（截止节点、倒推模式、命名）只在这里定义一处。
 */
export function makeTemplate(
  steps: RoutineStep[],
  deadline: Date | null,
  recurrence: Recurrence,
  // 保留 `now` 形参以对齐 §4 导出契约（Swift 同名 API 也接收 now）；截止时间已在上游算好。
  _now: Date,
  tz: string,
): RoutineTemplate | null {
  const taskSteps = steps.filter((step) => step.role === 'task');
  const firstStep = taskSteps[0];
  if (!firstStep) {
    return null;
  }

  const name = taskSteps.length === 1 ? firstStep.title : `${firstStep.title}等 ${taskSteps.length} 项`;

  if (deadline === null) {
    return createTemplate({
      name,
      symbol: 'list.bullet.clipboard.fill',
      mode: 'forward',
      recurrence,
      steps: taskSteps,
    });
  }

  const deadlineStep = createStep({
    title: '完成',
    prompt: '按计划完成，不再临时开新任务',
    duration: 0,
    importance: 'hardDeadline',
    role: 'deadline',
  });
  const components = getZonedComponents(deadline, tz);

  return createTemplate({
    name,
    symbol: 'list.bullet.clipboard.fill',
    mode: 'backward',
    deadlineHour: components.hour,
    deadlineMinute: components.minute,
    recurrence,
    steps: [...taskSteps, deadlineStep],
  });
}

/** 由文本直接生成任务线：先解析，再交给上面的重载组装（对应 Swift `makeTemplate(from:)`）。 */
export function makeTemplateFromText(
  input: string,
  deadline: Date | null,
  recurrence: Recurrence,
  now: Date,
  tz: string,
): RoutineTemplate | null {
  return makeTemplate(
    makeSteps(input),
    deadline ?? inferredDeadline(input, now, tz),
    recurrence,
    now,
    tz,
  );
}
