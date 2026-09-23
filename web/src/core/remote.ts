/**
 * core/remote.ts — 云端宽松解析 + 降级重试（RemoteRoutineParsingService 等价，LOGIC_PORT_SPEC §2.6）。
 *
 * 网络通过可注入的 `Fetcher` 收口：单测注入桩，绝不真连网关；生产默认走全局 fetch。
 */

import type {
  BodyVariant,
  ChatCompletion,
  Fetcher,
  ParseResult,
  ParsedRoutineItem,
  ParsedRoutinePayload,
  RemoteParsingConfiguration,
  RemoteParsingError,
  RoutineParsingService,
  ThinkingDisableStyle,
} from './types';
import { createStep, makeParseResult, remoteParsingErrorMessage } from './types';
import { defaultTimeZone, setHoursInTz } from './serialization';

interface Clock {
  hour: number;
  minute: number;
}
type Dict = Record<string, unknown>;

/** 模型没给出时长时的兜底值：宁可留一项待用户改，也不要丢掉这个任务。 */
export const FALLBACK_MINUTES = 5;

// ---------------------------------------------------------------------------
// 候选键名（比较前经 normalize 去大小写/下划线/连字符）
// ---------------------------------------------------------------------------

const CONTAINER_KEYS = [
  'steps', 'tasks', 'items', 'tasklist', 'list', 'routine', 'plan', '计划', '任务列表', '任务',
];
const TITLE_KEYS = [
  'title', 'name', 'task', 'action', 'label', 'activity', 'content', '任务', '任务名', '名称', '描述',
];
const MINUTE_KEYS = [
  'durationminutes', 'durationmin', 'minutes', 'minute', 'mins', 'min', 'duration', '时长',
];
const SECOND_KEYS = ['durationseconds', 'durationsec', 'seconds', 'second', 'sec', '秒数'];
const CLOCK_KEYS = ['time', 'at', 'deadline', 'deadlinetime', 'starttime', 'clock', '时间', '时刻'];
const HOUR_KEYS = ['deadlinehour', 'hour', 'deadlineh', '时', '小时'];
const MINUTE_OF_CLOCK_KEYS = ['deadlineminute', 'minute', 'deadlinemin', '分', '分钟数'];

/** 归一化键名：忽略大小写与下划线、连字符，让 snake_case 与 camelCase 等价。 */
export function normalize(key: string): string {
  return key.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 在字典里按候选键取值（归一化后比较）；未命中返回 undefined。 */
function valueIn(dict: Dict | null, keys: string[]): unknown {
  if (!dict) {
    return undefined;
  }
  const wanted = new Set(keys.map(normalize));
  for (const [key, value] of Object.entries(dict)) {
    if (wanted.has(normalize(key))) {
      return value;
    }
  }
  return undefined;
}

function stringIn(dict: Dict, keys: string[]): string | null {
  const raw = valueIn(dict, keys);
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  return null;
}

export function doubleValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function firstNumber(text: string): number | null {
  const match = /\d+(?:\.\d+)?/.exec(text);
  return match ? Number.parseFloat(match[0]) : null;
}

/** 时长允许是数字、数字字符串，或带单位的中文串（"5分钟"、"2小时"、"90秒"）。 */
export function minutes(value: unknown): number | null {
  const number = doubleValue(value);
  if (number !== null) {
    return number > 0 ? number : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const first = firstNumber(value);
  if (first === null) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (value.includes('秒') || lowered.includes('sec')) {
    const converted = first / 60;
    return converted > 0 ? converted : null;
  }
  if (
    value.includes('小时') ||
    value.includes('时') ||
    lowered.includes('hour') ||
    lowered.endsWith('h')
  ) {
    return first * 60;
  }
  return first > 0 ? first : null;
}

function durationMinutesIn(item: Dict): number | null {
  const raw = valueIn(item, MINUTE_KEYS);
  if (raw !== undefined) {
    const parsed = minutes(raw);
    if (parsed !== null) {
      return parsed;
    }
  }
  const rawSeconds = valueIn(item, SECOND_KEYS);
  if (rawSeconds !== undefined) {
    const seconds = doubleValue(rawSeconds);
    if (seconds !== null) {
      const converted = seconds / 60;
      return converted > 0 ? converted : null;
    }
  }
  return null;
}

function validClock(hour: number, minute: number): Clock | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

/** 解析 "08:30" / "8点30" / "8点半" / "8点" 这类时刻文本。 */
export function clock(fromText: string): Clock | null {
  const match = /(\d{1,2})\s*(?::|：|点|時|时)\s*(\d{1,2})?/.exec(fromText);
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  let minute = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
  // "8点半" 没有显式分钟，靠「半」字补 30。
  if (match[2] === undefined && fromText.includes('半')) {
    minute = 30;
  }
  return validClock(hour, minute);
}

/** 以整数表示的时刻：0…23 当作小时，100…2359 当作 hhmm（如 830 → 8:30）。 */
export function clockFromNumber(value: number): Clock | null {
  const intValue = Math.trunc(value);
  if (intValue >= 0 && intValue <= 23) {
    return { hour: intValue, minute: 0 };
  }
  if (intValue >= 100 && intValue <= 2359) {
    return validClock(Math.trunc(intValue / 100), intValue % 100);
  }
  return null;
}

function integerIn(dict: Dict | null, keys: string[]): number | null {
  const raw = valueIn(dict, keys);
  if (raw === undefined) {
    return null;
  }
  const number = doubleValue(raw);
  if (number !== null) {
    return Math.trunc(number);
  }
  // 字段里塞了完整时刻（"8:30"）时取小时部分，别把 30 当小时用。
  if (typeof raw === 'string') {
    const parsedClock = clock(raw);
    if (parsedClock) {
      return parsedClock.hour;
    }
  }
  return null;
}

/** 解析步骤里的时间点：字符串 / 数字 / `{hour, minute}` 嵌套写法。 */
function clockComponentsIn(item: Dict): Clock | null {
  const raw = valueIn(item, CLOCK_KEYS);
  if (raw === undefined) {
    return null;
  }
  if (typeof raw === 'string') {
    return clock(raw);
  }
  if (typeof raw === 'number') {
    return clockFromNumber(raw);
  }
  if (isDict(raw)) {
    const hour = integerIn(raw, HOUR_KEYS);
    if (hour === null) {
      return null;
    }
    const minute = integerIn(raw, MINUTE_OF_CLOCK_KEYS) ?? 0;
    return validClock(hour, minute);
  }
  return null;
}

/** 取出任务数组：可能是根对象下的某个键，也可能根就是数组。 */
function itemDictionaries(object: unknown): Dict[] {
  if (Array.isArray(object)) {
    return object.every(isDict) ? (object as Dict[]) : [];
  }
  if (isDict(object)) {
    for (const key of CONTAINER_KEYS) {
      const candidate = valueIn(object, [key]);
      if (Array.isArray(candidate) && candidate.every(isDict)) {
        return candidate as Dict[];
      }
    }
  }
  return [];
}

/** 宽松解析核心：把任意 JSON 对象解析成任务与截止时间。 */
export function payloadFromObject(object: unknown): ParsedRoutinePayload | null {
  const root = isDict(object) ? object : null;
  const items = itemDictionaries(object);
  if (items.length === 0) {
    return null;
  }

  const resolved: ParsedRoutineItem[] = [];
  // 用 holder 保存闭包内赋值，避免 TS 控制流把跨回调赋值误判为 never。
  const deadlineHolder: { value: Clock | null } = { value: null };

  items.forEach((item, index) => {
    const rawTitle = stringIn(item, TITLE_KEYS);
    const title = rawTitle?.trim();
    if (!title) {
      return;
    }

    const itemMinutes = durationMinutesIn(item);
    const isLast = index === items.length - 1;

    // 只有末项的时刻才当最终节点；夹在中间的时刻只是对任务的描述，任务照常保留。
    if (isLast) {
      const itemClock = clockComponentsIn(item);
      if (itemClock) {
        deadlineHolder.value = itemClock;
        if (itemMinutes === null) {
          return;
        }
      }
    }

    resolved.push({ title, minutes: itemMinutes ?? FALLBACK_MINUTES });
  });

  if (resolved.length === 0) {
    return null;
  }

  // 顶层显式截止（拆开的 deadlineHour/Minute 或合成的 deadline:"08:30"）优先于末项时刻。
  const explicitClock = clockComponentsIn(root ?? {});
  const hour =
    explicitClock?.hour ?? integerIn(root, HOUR_KEYS) ?? deadlineHolder.value?.hour ?? null;
  const minute =
    explicitClock?.minute ??
    integerIn(root, MINUTE_OF_CLOCK_KEYS) ??
    deadlineHolder.value?.minute ??
    null;

  return { steps: resolved, deadlineHour: hour, deadlineMinute: minute };
}

/** 从模型输出里抠出 JSON 主体：先剥 markdown 围栏，再截取最外层的结构。 */
export function extractJSONObject(content: string): string | null {
  let text = content.trim();

  if (text.startsWith('```')) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    const closing = text.lastIndexOf('```');
    if (closing !== -1) {
      text = text.slice(0, closing);
    }
    text = text.trim();
  }

  const object = enclosingSubstring(text, '{', '}');
  const array = enclosingSubstring(text, '[', ']');

  if (object && array) {
    return array.start < object.start ? array.text : object.text;
  }
  if (object) {
    return object.text;
  }
  if (array) {
    return array.text;
  }
  return null;
}

/** 返回最外层结构的文本以及它在原串里的起点（用于判断谁是根）。 */
function enclosingSubstring(
  text: string,
  open: string,
  close: string,
): { text: string; start: number } | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || start >= end) {
    return null;
  }
  return { text: text.slice(start, end + 1), start };
}

/** 把模型返回的文本解析成任务与截止时间。 */
export function decodePayload(raw: string): ParsedRoutinePayload | null {
  const json = extractJSONObject(raw);
  if (json === null) {
    return null;
  }
  let object: unknown;
  try {
    object = JSON.parse(json);
  } catch {
    return null;
  }
  return payloadFromObject(object);
}

/** 截止时间只在模型给出了合法时分时才构造。 */
export function makeDeadline(
  hour: number | null,
  minute: number | null,
  now: Date,
  tz: string,
): Date | null {
  if (hour === null || hour < 0 || hour > 23) {
    return null;
  }
  const resolvedMinute = minute ?? 0;
  if (resolvedMinute < 0 || resolvedMinute > 59) {
    return null;
  }
  return setHoursInTz(now, hour, resolvedMinute, tz);
}

/** 400 / 422 表示请求本身被服务端判为不合法（通常就是多了它不认识的字段）。 */
export function isRejectedRequest(statusCode: number): boolean {
  return statusCode === 400 || statusCode === 422;
}

/** 容忍 base URL 末尾带不带斜杠，也容忍调用方直接给完整路径。 */
export function chatCompletionsURL(base: string): string {
  let text = base.trim();
  while (text.endsWith('/')) {
    text = text.slice(0, -1);
  }
  if (!text.endsWith('/chat/completions')) {
    text += '/chat/completions';
  }
  try {
    return new URL(text).toString();
  } catch {
    return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  }
}

/** 关闭思考链的字段（键 → 值）。`.none` 必须写不出任何字段。 */
export function thinkingDisableBodyEntries(
  style: ThinkingDisableStyle,
): Record<string, unknown> {
  switch (style) {
    case 'none':
      return {};
    case 'enableThinking':
      return { enable_thinking: false };
    case 'chatTemplateKwargs':
      return { chat_template_kwargs: { enable_thinking: false } };
    case 'thinkingTypeDisabled':
      return { thinking: { type: 'disabled' } };
  }
}

/** 按「字段最全 → 逐级精简」排列的请求体变体（去重，保留先出现者）。 */
export function buildBodyVariants(config: {
  usesJSONMode: boolean;
  thinkingDisable: ThinkingDisableStyle;
}): BodyVariant[] {
  const variants: BodyVariant[] = [];
  const append = (variant: BodyVariant): void => {
    const duplicate = variants.some(
      (existing) =>
        existing.usesJSONMode === variant.usesJSONMode &&
        existing.thinkingDisable === variant.thinkingDisable,
    );
    if (!duplicate) {
      variants.push(variant);
    }
  };

  if (config.usesJSONMode) {
    append({ usesJSONMode: true, thinkingDisable: config.thinkingDisable });
    // 优先保住已验证可用的 response_format，先只去掉思考开关。
    append({ usesJSONMode: true, thinkingDisable: 'none' });
  }
  append({ usesJSONMode: false, thinkingDisable: config.thinkingDisable });
  append({ usesJSONMode: false, thinkingDisable: 'none' });
  return variants;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface RemoteParsingConfigurationInit {
  endpoint: string;
  apiKey?: string | null;
  model: string;
  timeout?: number;
  usesJSONMode?: boolean;
  thinkingDisable?: ThinkingDisableStyle;
  retriesWithoutOptionalFields?: boolean;
}

class RemoteParsingConfigurationImpl implements RemoteParsingConfiguration {
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly model: string;
  readonly timeout: number;
  readonly usesJSONMode: boolean;
  readonly thinkingDisable: ThinkingDisableStyle;
  readonly retriesWithoutOptionalFields: boolean;

  constructor(init: RemoteParsingConfigurationInit) {
    this.endpoint = init.endpoint;
    this.apiKey = init.apiKey ?? null;
    this.model = init.model;
    this.timeout = init.timeout ?? 8;
    this.usesJSONMode = init.usesJSONMode ?? true;
    this.thinkingDisable = init.thinkingDisable ?? 'none';
    this.retriesWithoutOptionalFields = init.retriesWithoutOptionalFields ?? true;
  }

  get bodyVariants(): BodyVariant[] {
    return buildBodyVariants(this);
  }
}

export function createRemoteParsingConfiguration(
  init: RemoteParsingConfigurationInit,
): RemoteParsingConfiguration {
  return new RemoteParsingConfigurationImpl(init);
}

/** 公司内网网关（cosmo-mind-coder）默认配置。 */
export function cosmoMindConfiguration(options: {
  apiKey: string | null;
  model?: string;
  baseURL?: string;
  thinkingDisable?: ThinkingDisableStyle;
}): RemoteParsingConfiguration {
  return createRemoteParsingConfiguration({
    endpoint: chatCompletionsURL(options.baseURL ?? 'https://gpt.cosmoplat.com/v1'),
    apiKey: options.apiKey,
    model: options.model ?? 'cosmo-mind-coder',
    thinkingDisable: options.thinkingDisable ?? 'none',
  });
}

/** 阿里云百炼（DashScope）qwen 系列配置。 */
export function dashScopeConfiguration(options: {
  apiKey: string;
  model?: string;
}): RemoteParsingConfiguration {
  return createRemoteParsingConfiguration({
    endpoint: chatCompletionsURL('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    apiKey: options.apiKey,
    model: options.model ?? 'qwen-flash',
  });
}

// ---------------------------------------------------------------------------
// 提示词与传输
// ---------------------------------------------------------------------------

/**
 * 提示词里必须出现 “JSON” 字样（OpenAI 系 json_object 模式的硬性要求）。
 * 改动时务必保留首行的“并以 JSON 返回”。
 */
export const SYSTEM_PROMPT = `你是任务拆解器。把用户口述的日程拆成按顺序排列的任务列表，并以 JSON 返回。

规则：
- 只提取用户明确说出的任务。不要补充、不要推测、不要替用户安排他没提的任务。
- 任务名沿用用户的原始说法，不要改写、不要加书名号、不要补全动词。
- 时长统一换算成分钟。用户说“半小时”就是 30，“一小时”就是 60，“一个半”就是 90。
- 用户没给某个任务的时长时，填 5。
- 用户提到截止、结束、出门、到期时间时，把小时填进 deadlineHour、分钟填进 deadlineMinute（24 小时制）。
  只给了“8点”这种小时没给分钟的，分钟填 0。
- 没有提到任何截止时间时，deadlineHour 与 deadlineMinute 都填 null。

返回的 JSON 结构：
{"steps":[{"title":"任务名","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}`;

interface HttpStatusError {
  kind: 'httpStatus';
  code: number;
}

function isHttpStatusError(error: unknown): error is HttpStatusError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'httpStatus' &&
    typeof (error as { code?: unknown }).code === 'number'
  );
}

/** 默认 fetcher：走全局 fetch（生产路径）。单测务必注入桩。 */
const defaultFetcher: Fetcher = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
  };
};

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * 云端解析实现：任何兼容 OpenAI Chat Completions 字段格式的网关都能用。
 */
export class RemoteRoutineParsingService implements RoutineParsingService {
  /** 模型没给出时长时的兜底（分钟）。 */
  static readonly fallbackMinutes = FALLBACK_MINUTES;

  readonly source = 'enhanced' as const;
  readonly configuration: RemoteParsingConfiguration;

  private readonly fetcher: Fetcher;
  private readonly tz: string;
  private readonly logger: (message: string) => void;

  constructor(
    configuration: RemoteParsingConfiguration,
    options?: { fetcher?: Fetcher; tz?: string; logger?: (message: string) => void },
  ) {
    this.configuration = configuration;
    this.fetcher = options?.fetcher ?? defaultFetcher;
    this.tz = options?.tz ?? defaultTimeZone();
    this.logger = options?.logger ?? (() => {});
  }

  // ---- §4 契约的静态方法（同时有同名顶层函数导出） ----

  static decodePayload(raw: string): ParsedRoutinePayload | null {
    return decodePayload(raw);
  }

  static makeDeadline(
    hour: number | null,
    minute: number | null,
    now: Date,
    tz: string,
  ): Date | null {
    return makeDeadline(hour, minute, now, tz);
  }

  static isRejectedRequest(statusCode: number): boolean {
    return isRejectedRequest(statusCode);
  }

  static buildBodyVariants(config: RemoteParsingConfiguration): BodyVariant[] {
    return buildBodyVariants(config);
  }

  static normalize(key: string): string {
    return normalize(key);
  }

  static minutes(value: unknown): number | null {
    return minutes(value);
  }

  static chatCompletionsURL(base: string): string {
    return chatCompletionsURL(base);
  }

  static cosmoMind(options: {
    apiKey: string | null;
    model?: string;
    baseURL?: string;
    thinkingDisable?: ThinkingDisableStyle;
  }): RemoteParsingConfiguration {
    return cosmoMindConfiguration(options);
  }

  async parse(input: string, now: Date): Promise<ParseResult | null> {
    const trimmed = input.trim();
    if (trimmed === '') {
      return null;
    }

    if (!this.configuration.apiKey) {
      this.logger('未取到 API Key，请求会因未授权失败。');
    }

    const content = await this.requestCompletion(trimmed);
    const payload = decodePayload(content);
    if (!payload) {
      this.logger('模型返回无法解析为任务列表，已回退本机规则');
      return null;
    }

    const steps = payload.steps.map((item) =>
      createStep({ title: item.title, duration: item.minutes * 60 }),
    );
    if (steps.length === 0) {
      return null;
    }

    return makeParseResult({
      steps,
      deadline: makeDeadline(payload.deadlineHour, payload.deadlineMinute, now, this.tz),
      source: 'enhanced',
      leftover: '',
    });
  }

  /** 逐级降级地发请求：服务端不认某个额外字段（400/422）就去掉它再试。 */
  private async requestCompletion(input: string): Promise<string> {
    let variants = buildBodyVariants(this.configuration);
    if (!this.configuration.retriesWithoutOptionalFields) {
      variants = variants.slice(0, 1);
    }

    let lastError: RemoteParsingError = { kind: 'invalidResponse' };

    for (let index = 0; index < variants.length; index += 1) {
      try {
        return await this.performRequest(input, variants[index]);
      } catch (error) {
        if (isHttpStatusError(error) && isRejectedRequest(error.code)) {
          lastError = { kind: 'httpStatus', code: error.code };
          this.logger(`服务端拒绝请求（${error.code}），降级到下一个请求体变体`);
          if (index === variants.length - 1) {
            throw lastError;
          }
        } else {
          // 网络/超时等非「请求形状」错误：不触发降级重试，直接上报；管线会吞掉并回退规则。
          this.logger('增强解析请求失败，回退本机规则');
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async performRequest(input: string, variant: BodyVariant): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.configuration.apiKey && this.configuration.apiKey !== '') {
      headers.Authorization = `Bearer ${this.configuration.apiKey}`;
    }

    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.configuration.timeout * 1000)
      : null;

    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await this.fetcher(this.configuration.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildBody(input, variant)),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }

    if (response.status < 200 || response.status >= 300) {
      throw { kind: 'httpStatus', code: response.status } satisfies RemoteParsingError;
    }

    const decoded = (await response.json()) as ChatCompletion;
    const content = decoded?.choices?.[0]?.message?.content;
    if (!content) {
      throw { kind: 'emptyContent' } satisfies RemoteParsingError;
    }
    return content;
  }

  /** 手工拼请求体（关闭思考链的字段键名是动态的）。 */
  private buildBody(input: string, variant: BodyVariant): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.configuration.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
      temperature: 0,
    };
    if (variant.usesJSONMode) {
      body.response_format = { type: 'json_object' };
    }
    Object.assign(body, thinkingDisableBodyEntries(variant.thinkingDisable));
    return body;
  }
}

/** 便于消费方引用错误文案。 */
export { remoteParsingErrorMessage };
