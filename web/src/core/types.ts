/**
 * core/types.ts — 可移植类型清单（对应 LOGIC_PORT_SPEC.md §1）。
 *
 * 设计约束（ARCHITECTURE.md §4 / §5）：
 * - 本文件只放「类型 + 纯构造工厂 + 内置模板常量」，不含任何 DOM / 平台 API。
 * - JSON key 一律使用 Swift 属性名（camelCase），见 §0 序列化契约。
 * - 时间字段在内存里用 JS `Date` 表示；拼装 / 解析快照时由 serialization.ts
 *   按「Apple 参考日期秒」换算（§5.1）。
 */

// ---------------------------------------------------------------------------
// 枚举（string union，值 = Swift enum rawValue）
// ---------------------------------------------------------------------------

/** 设备角色。JSON key 为 `primaryDevice` 时取此值。 */
export type DeviceRole = 'phone' | 'pad' | 'watch';

/** 步骤重要性。 */
export type StepImportance = 'normal' | 'hardDeadline';

/** 步骤角色：普通任务 / 截止节点。 */
export type StepRole = 'task' | 'deadline';

/** 排程模式：从 now 顺排 / 从截止时间倒排。 */
export type RoutineMode = 'forward' | 'backward';
/** 别名，对齐 LOGIC_PORT_SPEC §1.1 的 Swift 名 `ScheduleMode`。 */
export type ScheduleMode = RoutineMode;

/** 重复方式。 */
export type Recurrence = 'once' | 'daily';
/** 别名，对齐 LOGIC_PORT_SPEC §1.1 的 Swift 名 `RoutineRecurrence`。 */
export type RoutineRecurrence = Recurrence;

/** 临时任务插入位置（非 Codable，仅 UI/入参用途）。 */
export type TemporaryTaskPlacement = 'now' | 'afterCurrent';

/** 步骤状态。 */
export type StepState = 'pending' | 'active' | 'suspended' | 'completed' | 'skipped';

/** 会话状态。 */
export type SessionState = 'running' | 'completed' | 'cancelled';

/** 解析来源（非 Codable，仅内存态）。 */
export type ParseSource = 'rule' | 'enhanced';
/** 别名，对齐 LOGIC_PORT_SPEC §1.3 的 Swift 名 `RoutineParseSource`。 */
export type RoutineParseSource = ParseSource;

/** 关闭思考链的字段写法（CaseIterable）。 */
export type ThinkingDisableStyle =
  | 'none'
  | 'enableThinking'
  | 'chatTemplateKwargs'
  | 'thinkingTypeDisabled';

// 枚举配套常量（与 Swift 的 title/detail/CaseIterable 对齐）。
export const RECURRENCES: readonly Recurrence[] = ['once', 'daily'];
export const RECURRENCE_TITLES: Readonly<Record<Recurrence, string>> = {
  once: '单次',
  daily: '每天',
};
export const TEMPORARY_TASK_PLACEMENTS: readonly TemporaryTaskPlacement[] = ['now', 'afterCurrent'];
export const PLACEMENT_TITLES: Readonly<Record<TemporaryTaskPlacement, string>> = {
  now: '立即做',
  afterCurrent: '当前任务后',
};
export const PLACEMENT_DETAILS: Readonly<Record<TemporaryTaskPlacement, string>> = {
  now: '先暂停当前任务，做完马上回到主线。',
  afterCurrent: '先完成正在做的事，再执行这项临时任务。',
};
export const PARSE_SOURCE_TITLES: Readonly<Record<ParseSource, string>> = {
  rule: '本机识别',
  enhanced: '智能识别',
};
export const THINKING_DISABLE_STYLES: readonly ThinkingDisableStyle[] = [
  'none',
  'enableThinking',
  'chatTemplateKwargs',
  'thinkingTypeDisabled',
];

// ---------------------------------------------------------------------------
// 模型结构体（JSON key = 属性名）
// ---------------------------------------------------------------------------

export interface RoutineStep {
  id: string;
  title: string;
  /** 编码后非空：构造时未给则回落 `现在只做：{title}`。 */
  prompt: string;
  /** TimeInterval，单位秒。 */
  duration: number;
  importance: StepImportance;
  role: StepRole;
}

export interface RoutineTemplate {
  id: string;
  name: string;
  symbol: string;
  mode: RoutineMode;
  deadlineHour: number | null;
  deadlineMinute: number | null;
  /** TimeInterval，单位秒。 */
  buffer: number;
  /** 旧数据可能整键缺失 → 解码后为 null；读时用 effectiveRecurrence 回落 `once`。 */
  recurrence: Recurrence | null;
  steps: RoutineStep[];
}

export interface StepProgress {
  id: string;
  step: RoutineStep;
  dueAt: Date;
  state: StepState;
  snoozeCount: number;
  completedAt: Date | null;
  isTemporary: boolean;
  /** 第一次生成计划时的完成时间，之后不随延误改写。 */
  plannedDueAt: Date | null;
  /** 挂起后尚未完成的时长（秒）；为空时使用 step.duration。 */
  remainingDuration: number | null;
  startedAt: Date | null;
}

export interface RoutineSession {
  id: string;
  templateID: string;
  templateName: string;
  templateSymbol: string;
  startedAt: Date;
  plannedStartAt: Date;
  targetDeadline: Date | null;
  state: SessionState;
  primaryDevice: DeviceRole;
  /** 数组顺序即执行顺序（index 0 最靠前）。 */
  progress: StepProgress[];
  /** TimeInterval，单位秒；初始化为 selectedBuffer，永不被延误扣减。 */
  remainingBuffer: number;
  updatedAt: Date;
  revision: number;
  /** 只有点击某项「开始」后才会有当前任务。 */
  activeProgressID: string | null;
  /** LIFO 栈，记录需返回的挂起任务。 */
  suspendedProgressIDs: string[] | null;
}

export interface RoutineSnapshot {
  templates: RoutineTemplate[];
  activeSession: RoutineSession | null;
  updatedAt: Date;
  /** 跨端仲裁用，见 conflict.ts。 */
  originID: string;
}

/** App Group 共享精简快照（复刻 Widget 才需要）。 */
export interface MainlineWidgetSnapshot {
  capturedAt: Date | null;
  currentTitle: string | null;
  currentDueAt: Date | null;
  originalDueAt: Date | null;
  isHardDeadline: boolean;
  estimatedCompletion: Date | null;
  isLate: boolean;
  delayDuration: number | null;
  hasActiveSession: boolean;
  sessionName: string | null;
}

/** Widget 时间线条目（MainlineWidgetProvider.entry(for:) 的等价物）。 */
export interface MainlineWidgetEntry {
  date: Date;
  currentTitle: string | null;
  currentDueAt: Date | null;
  isHardDeadline: boolean;
  estimatedCompletion: Date | null;
  isLate: boolean;
  delayDuration: number;
  hasActiveSession: boolean;
  sessionName: string | null;
}

// ---------------------------------------------------------------------------
// 解析相关类型（非 Codable，仅内存/服务层）
// ---------------------------------------------------------------------------

/** 规则解析的全部产物（QuickRoutineParser.ParseOutcome）。 */
export interface ParseOutcome {
  steps: RoutineStep[];
  deadline: Date | null;
  /** 未能归入任何任务的残余文本。为空说明规则完整吃下了输入。 */
  leftover: string;
  readonly hasSteps: boolean;
  readonly isComplete: boolean;
}

/** 一句话创建的解析结果（RoutineParseResult）。 */
export interface ParseResult {
  steps: RoutineStep[];
  deadline: Date | null;
  source: ParseSource;
  leftover: string;
  readonly hasSteps: boolean;
  readonly isComplete: boolean;
}

/** 解析服务协议。 */
export interface RoutineParsingService {
  readonly source: ParseSource;
  parse(input: string, now: Date): Promise<ParseResult | null>;
}

export interface BodyVariant {
  usesJSONMode: boolean;
  thinkingDisable: ThinkingDisableStyle;
}

export interface RemoteParsingConfiguration {
  /** 完整 chat completions URL。 */
  endpoint: string;
  /** null = 由反向代理注入凭据。 */
  apiKey: string | null;
  model: string;
  /** 超时（秒），默认 8。 */
  timeout: number;
  usesJSONMode: boolean;
  thinkingDisable: ThinkingDisableStyle;
  retriesWithoutOptionalFields: boolean;
  readonly bodyVariants: BodyVariant[];
}

export interface ParsedRoutineItem {
  title: string;
  minutes: number;
}

export interface ParsedRoutinePayload {
  steps: ParsedRoutineItem[];
  deadlineHour: number | null;
  deadlineMinute: number | null;
}

/** 对应 Swift enum `RemoteParsingError`（带 errorDescription）。 */
export type RemoteParsingError =
  | { kind: 'invalidResponse' }
  | { kind: 'httpStatus'; code: number }
  | { kind: 'emptyContent' };

export function remoteParsingErrorMessage(error: RemoteParsingError): string {
  switch (error.kind) {
    case 'invalidResponse':
      return '服务返回了无法识别的响应。';
    case 'httpStatus':
      return `服务返回状态码 ${error.code}。`;
    case 'emptyContent':
      return '服务返回了空内容。';
  }
}

/** 传输结构（唯一使用 snake_case CodingKeys 的地方）。 */
export interface ChatCompletion {
  choices: { message: { content: string | null } }[];
  usage: {
    completion_tokens?: number | null;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  } | null;
}

/** 可注入的 HTTP 响应最小接口（便于单测，不真连网关）。 */
export interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** 可注入的 fetcher：默认实现走全局 fetch；单测注入桩。 */
export type Fetcher = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

// ---------------------------------------------------------------------------
// 纯构造工厂（替代 Swift 的 init(...= 默认值)）
// ---------------------------------------------------------------------------

/** 标准全局 crypto（Node 19+ / 浏览器 / WebView 均有），非 DOM/宿主专属 API。 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export interface RoutineStepInit {
  id?: string;
  title: string;
  prompt?: string | null;
  duration: number;
  importance?: StepImportance;
  role?: StepRole;
}

export function createStep(init: RoutineStepInit): RoutineStep {
  return {
    id: init.id ?? randomUUID(),
    title: init.title,
    prompt: init.prompt ?? `现在只做：${init.title}`,
    duration: init.duration,
    importance: init.importance ?? 'normal',
    role: init.role ?? 'task',
  };
}

export interface RoutineTemplateInit {
  id?: string;
  name: string;
  symbol: string;
  mode: RoutineMode;
  deadlineHour?: number | null;
  deadlineMinute?: number | null;
  buffer?: number;
  recurrence?: Recurrence | null;
  steps: RoutineStep[];
}

export function createTemplate(init: RoutineTemplateInit): RoutineTemplate {
  return {
    id: init.id ?? randomUUID(),
    name: init.name,
    symbol: init.symbol,
    mode: init.mode,
    deadlineHour: init.deadlineHour ?? null,
    deadlineMinute: init.deadlineMinute ?? null,
    buffer: init.buffer ?? 0,
    recurrence: init.recurrence === undefined ? 'once' : init.recurrence,
    steps: init.steps,
  };
}

export interface StepProgressInit {
  id?: string;
  step: RoutineStep;
  dueAt: Date;
  state?: StepState;
  snoozeCount?: number;
  completedAt?: Date | null;
  isTemporary?: boolean;
  plannedDueAt?: Date | null;
  remainingDuration?: number | null;
  startedAt?: Date | null;
}

export function createProgress(init: StepProgressInit): StepProgress {
  return {
    id: init.id ?? randomUUID(),
    step: init.step,
    dueAt: init.dueAt,
    state: init.state ?? 'pending',
    snoozeCount: init.snoozeCount ?? 0,
    completedAt: init.completedAt ?? null,
    isTemporary: init.isTemporary ?? false,
    plannedDueAt: init.plannedDueAt ?? null,
    remainingDuration: init.remainingDuration ?? null,
    startedAt: init.startedAt ?? null,
  };
}

export interface RoutineSessionInit {
  id?: string;
  templateID: string;
  templateName: string;
  templateSymbol: string;
  startedAt: Date;
  plannedStartAt: Date;
  targetDeadline: Date | null;
  state: SessionState;
  primaryDevice: DeviceRole;
  progress: StepProgress[];
  remainingBuffer: number;
  updatedAt: Date;
  revision: number;
  activeProgressID?: string | null;
  suspendedProgressIDs?: string[] | null;
}

export function createSession(init: RoutineSessionInit): RoutineSession {
  return {
    id: init.id ?? randomUUID(),
    templateID: init.templateID,
    templateName: init.templateName,
    templateSymbol: init.templateSymbol,
    startedAt: init.startedAt,
    plannedStartAt: init.plannedStartAt,
    targetDeadline: init.targetDeadline,
    state: init.state,
    primaryDevice: init.primaryDevice,
    progress: init.progress,
    remainingBuffer: init.remainingBuffer,
    updatedAt: init.updatedAt,
    revision: init.revision,
    activeProgressID: init.activeProgressID ?? null,
    suspendedProgressIDs: init.suspendedProgressIDs ?? null,
  };
}

export interface RoutineSnapshotInit {
  templates: RoutineTemplate[];
  activeSession?: RoutineSession | null;
  updatedAt: Date;
  originID?: string;
}

export function createSnapshot(init: RoutineSnapshotInit): RoutineSnapshot {
  return {
    templates: init.templates,
    activeSession: init.activeSession ?? null,
    updatedAt: init.updatedAt,
    originID: init.originID ?? randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// 深拷贝（纯逻辑层内部使用，避免快照/会话被别名改写）
// ---------------------------------------------------------------------------

export function cloneStep(step: RoutineStep): RoutineStep {
  return { ...step };
}

export function cloneTemplate(template: RoutineTemplate): RoutineTemplate {
  return { ...template, steps: template.steps.map(cloneStep) };
}

export function cloneProgress(progress: StepProgress): StepProgress {
  return {
    ...progress,
    step: cloneStep(progress.step),
    dueAt: new Date(progress.dueAt.getTime()),
    completedAt: progress.completedAt ? new Date(progress.completedAt.getTime()) : null,
    plannedDueAt: progress.plannedDueAt ? new Date(progress.plannedDueAt.getTime()) : null,
    startedAt: progress.startedAt ? new Date(progress.startedAt.getTime()) : null,
  };
}

export function cloneSession(session: RoutineSession): RoutineSession {
  return {
    ...session,
    startedAt: new Date(session.startedAt.getTime()),
    plannedStartAt: new Date(session.plannedStartAt.getTime()),
    targetDeadline: session.targetDeadline ? new Date(session.targetDeadline.getTime()) : null,
    updatedAt: new Date(session.updatedAt.getTime()),
    progress: session.progress.map(cloneProgress),
    suspendedProgressIDs: session.suspendedProgressIDs ? [...session.suspendedProgressIDs] : null,
  };
}

export function cloneSnapshot(snapshot: RoutineSnapshot): RoutineSnapshot {
  return {
    templates: snapshot.templates.map(cloneTemplate),
    activeSession: snapshot.activeSession ? cloneSession(snapshot.activeSession) : null,
    updatedAt: new Date(snapshot.updatedAt.getTime()),
    originID: snapshot.originID,
  };
}

// ---------------------------------------------------------------------------
// 内置模板（RoutineTemplate.defaults = [morning, homework, ikea]）
// ---------------------------------------------------------------------------

export const MORNING_TEMPLATE: RoutineTemplate = createTemplate({
  id: '5E43ED14-458A-49CF-8673-A96DCA196001',
  name: '上班早晨',
  symbol: 'sun.max.fill',
  mode: 'backward',
  deadlineHour: 8,
  deadlineMinute: 35,
  buffer: 10 * 60,
  recurrence: 'daily',
  steps: [
    createStep({ title: '刷牙', prompt: '先刷牙，不开新任务', duration: 3 * 60 }),
    createStep({ title: '洗脸', duration: 5 * 60 }),
    createStep({ title: '弄头发', duration: 10 * 60 }),
    createStep({ title: '装午饭', prompt: '午饭装好就下楼，不再收拾车', duration: 2 * 60 }),
    createStep({
      title: '下楼',
      prompt: '现在下楼，安安的临时需求优先交接',
      duration: 5 * 60,
      importance: 'hardDeadline',
    }),
    createStep({
      title: '出门',
      prompt: '不预测路况，现在出门',
      duration: 0,
      importance: 'hardDeadline',
      role: 'deadline',
    }),
  ],
});

export const HOMEWORK_TEMPLATE: RoutineTemplate = createTemplate({
  id: '5E43ED14-458A-49CF-8673-A96DCA196002',
  name: '写作业',
  symbol: 'book.closed.fill',
  mode: 'forward',
  recurrence: 'once',
  steps: [
    createStep({ title: '语文', prompt: '先做语文，只要开始', duration: 2 * 60 * 60 }),
    createStep({ title: '英语', duration: 60 * 60 }),
    createStep({ title: '数学', duration: 30 * 60 }),
  ],
});

export const IKEA_TEMPLATE: RoutineTemplate = createTemplate({
  id: '5E43ED14-458A-49CF-8673-A96DCA196003',
  name: '去宜家',
  symbol: 'car.fill',
  mode: 'backward',
  deadlineHour: 9,
  deadlineMinute: 0,
  buffer: 15 * 60,
  recurrence: 'once',
  steps: [
    createStep({ title: '洗脸刷牙', duration: 15 * 60 }),
    createStep({ title: '给安安喂早饭', duration: 20 * 60 }),
    createStep({ title: '安安穿衣服', duration: 10 * 60 }),
    createStep({ title: '路上', prompt: '带好必需品，直接出发', duration: 40 * 60 }),
    createStep({
      title: '到宜家',
      prompt: '到达就好，不追求一路完美',
      duration: 0,
      importance: 'hardDeadline',
      role: 'deadline',
    }),
  ],
});

export const DEFAULT_TEMPLATES: readonly RoutineTemplate[] = [
  MORNING_TEMPLATE,
  HOMEWORK_TEMPLATE,
  IKEA_TEMPLATE,
];

/**
 * `Date.distantPast` 的等价常量。
 *
 * 必须与 Swift 逐字节对齐：`Date.distantPast` = Apple 参考秒 -63114076800，
 * 换算成 Unix 毫秒 = (-63114076800 + 978307200) * 1000 = -62135769600000。
 *
 * 注意：这与「0001-01-01T00:00:00Z」并不相等（后者 = -62135596800000，差 2 天）。
 * 该值会参与跨端冲突裁决（`updatedAt` 比较），哨兵值不一致会让「初始快照谁胜出」
 * 在两端出现非对称，故不能用直觉值，必须用 Swift 实测值。
 * 依据：tools/cross-check/run.sh 的 K 组对齐检查。
 */
export const DISTANT_PAST = new Date(-62135769600000);

/** 空快照（RoutineSnapshot.initial 的等价物，originID 为新 UUID）。 */
export function initialSnapshot(): RoutineSnapshot {
  return {
    templates: DEFAULT_TEMPLATES.map(cloneTemplate),
    activeSession: null,
    updatedAt: new Date(DISTANT_PAST.getTime()),
    originID: randomUUID(),
  };
}

/** 便捷工厂：把 {steps, deadline, source, leftover} 组装成带派生字段的 ParseResult。 */
export function makeParseResult(init: {
  steps: RoutineStep[];
  deadline: Date | null;
  source: ParseSource;
  leftover: string;
}): ParseResult {
  return {
    steps: init.steps,
    deadline: init.deadline,
    source: init.source,
    leftover: init.leftover,
    hasSteps: init.steps.length > 0,
    isComplete: init.leftover === '',
  };
}

/** 便捷工厂：组装 ParseOutcome。 */
export function makeParseOutcome(init: {
  steps: RoutineStep[];
  deadline: Date | null;
  leftover: string;
}): ParseOutcome {
  return {
    steps: init.steps,
    deadline: init.deadline,
    leftover: init.leftover,
    hasSteps: init.steps.length > 0,
    isComplete: init.leftover === '',
  };
}
