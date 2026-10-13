/**
 * core/serialization.ts — 跨端序列化契约 + 时区换算（ARCHITECTURE §5.1 / 约束 W1–W6）。
 *
 * 最大坑（§5.1）：Swift `JSONEncoder` 默认把 `Date` 写成「自 2001-01-01T00:00:00Z 起的
 * 秒」（Apple 参考日期），**不是 Unix 秒**：
 *     epochMs = (refSeconds + 978307200) * 1000
 *     refSeconds = epochMs / 1000 - 978307200
 * 直接当 Unix 秒处理会静默偏移约 31 年（仍是合法 Double，最难发现）。
 *
 * 本文件同时提供「在指定 IANA 时区里构造本地墙上时刻」的工具函数（约束 W2/W4）：
 * 所有时间函数显式接收 `tz`，禁止隐式读全局时区。
 */

import type {
  MainlineWidgetSnapshot,
  RoutineSession,
  RoutineSnapshot,
  RoutineStep,
  RoutineTemplate,
  StepProgress,
} from './types';
import {
  createProgress,
  createStep,
  createTemplate,
  cloneSession,
  cloneTemplate,
} from './types';

/** Apple 参考日期（2001-01-01T00:00:00Z）相对 Unix epoch 的秒偏移。 */
export const APPLE_REFERENCE_EPOCH_OFFSET = 978307200;

/** Apple 参考秒 → Unix 毫秒。 */
export function refSecondsToMs(refSeconds: number): number {
  return (refSeconds + APPLE_REFERENCE_EPOCH_OFFSET) * 1000;
}

/** Unix 毫秒 → Apple 参考秒。 */
export function msToRefSeconds(epochMs: number): number {
  return epochMs / 1000 - APPLE_REFERENCE_EPOCH_OFFSET;
}

/** UUID 比较统一大小写（建议全小写），不要假定输入的写法。 */
export function normalizeUUID(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// 时区工具（约束 W2：date(bySettingHour:) == 「同一天上设定时分」，不跨日）
// ---------------------------------------------------------------------------

export interface ZonedComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 读取某个绝对时刻在指定 IANA 时区里的墙上时间分量。 */
export function getZonedComponents(date: Date, tz: string): ZonedComponents {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10),
    day: Number.parseInt(map.day, 10),
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10),
    second: Number.parseInt(map.second, 10),
  };
}

/** 指定时区在某个 UTC 时刻的偏移（本地墙上时间 − UTC），单位毫秒。 */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const components = getZonedComponents(new Date(utcMs), tz);
  const asUtc = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
  );
  return asUtc - utcMs;
}

/** 把「某时区里的一个墙上时刻」换算成绝对 UTC 毫秒。 */
function wallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zoneOffsetMs(guess, tz);
  return guess - offset;
}

/**
 * 在 `date` 所在的**同一日历日**上把时钟设为 h:m:00（指定时区），不跨日滚动。
 * 对应 Swift `calendar.date(bySettingHour:minute:second:of:)`（约束 W2）。
 */
export function setHoursInTz(date: Date, hour: number, minute: number, tz: string): Date {
  const c = getZonedComponents(date, tz);
  return new Date(wallTimeToUtcMs(c.year, c.month, c.day, hour, minute, tz));
}

/** 在指定时区里加 `days` 个日历日（保持墙上时间），对应 `calendar.date(byAdding: .day,)`。 */
export function addDaysInTz(date: Date, days: number, tz: string): Date {
  const c = getZonedComponents(date, tz);
  const shifted = new Date(
    Date.UTC(c.year, c.month - 1, c.day + days, c.hour, c.minute, c.second),
  );
  return new Date(
    wallTimeToUtcMs(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate(),
      c.hour,
      c.minute,
      tz,
    ),
  );
}

/** 生产环境默认时区（浏览器/Node 本地时区）；测试必须注入固定时区（约束 W4）。 */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ---------------------------------------------------------------------------
// 快照编解码（JSON key = Swift 属性名；Date = Apple 参考秒）
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`serialization: 字段 ${field} 期望 string`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`serialization: 字段 ${field} 期望 number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredRefDate(value: unknown, field: string): Date {
  return new Date(refSecondsToMs(requiredNumber(value, field)));
}

/**
 * 可选日期：键缺失与 `null` 都当 undefined 处理（§0 旧数据兼容）。
 * 显式给出的非法值（非 number 非 null）视为缺失，不抛错。
 */
function optionalRefDate(value: unknown): Date | null {
  const seconds = optionalNumber(value);
  return seconds === null ? null : new Date(refSecondsToMs(seconds));
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalStringArray(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return null;
}

function requireObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`serialization: 字段 ${field} 期望对象`);
  }
  return value;
}

const STEP_IMPORTANCE_VALUES = ['normal', 'hardDeadline'] as const;
const STEP_ROLE_VALUES = ['task', 'deadline'] as const;
const MODE_VALUES = ['forward', 'backward'] as const;
const RECURRENCE_VALUES = ['once', 'daily'] as const;
const STEP_STATE_VALUES = ['pending', 'active', 'suspended', 'completed', 'skipped'] as const;
const SESSION_STATE_VALUES = ['running', 'completed', 'cancelled'] as const;
const DEVICE_ROLE_VALUES = ['phone', 'pad', 'watch'] as const;

function requiredEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`serialization: 字段 ${field} 取值非法：${String(value)}`);
  }
  return value as T;
}

// ---- encode ----

function encodeStep(step: RoutineStep): JsonObject {
  return {
    ...(step.commute ? { commute: { ...step.commute } } : {}),
    id: step.id,
    title: step.title,
    prompt: step.prompt,
    duration: step.duration,
    importance: step.importance,
    role: step.role,
  };
}

function encodeTemplate(template: RoutineTemplate): JsonObject {
  return {
    id: template.id,
    name: template.name,
    symbol: template.symbol,
    mode: template.mode,
    deadlineHour: template.deadlineHour,
    deadlineMinute: template.deadlineMinute,
    buffer: template.buffer,
    recurrence: template.recurrence,
    steps: template.steps.map(encodeStep),
    ...(template.commute ? { commute: { ...template.commute } } : {}),
  };
}

function encodeProgress(progress: StepProgress): JsonObject {
  return {
    id: progress.id,
    step: encodeStep(progress.step),
    dueAt: msToRefSeconds(progress.dueAt.getTime()),
    state: progress.state,
    snoozeCount: progress.snoozeCount,
    completedAt: progress.completedAt ? msToRefSeconds(progress.completedAt.getTime()) : null,
    isTemporary: progress.isTemporary,
    plannedDueAt: progress.plannedDueAt ? msToRefSeconds(progress.plannedDueAt.getTime()) : null,
    remainingDuration: progress.remainingDuration,
    startedAt: progress.startedAt ? msToRefSeconds(progress.startedAt.getTime()) : null,
  };
}

function encodeSession(session: RoutineSession): JsonObject {
  return {
    id: session.id,
    templateID: session.templateID,
    templateName: session.templateName,
    templateSymbol: session.templateSymbol,
    startedAt: msToRefSeconds(session.startedAt.getTime()),
    plannedStartAt: msToRefSeconds(session.plannedStartAt.getTime()),
    targetDeadline: session.targetDeadline ? msToRefSeconds(session.targetDeadline.getTime()) : null,
    state: session.state,
    primaryDevice: session.primaryDevice,
    progress: session.progress.map(encodeProgress),
    remainingBuffer: session.remainingBuffer,
    updatedAt: msToRefSeconds(session.updatedAt.getTime()),
    revision: session.revision,
    activeProgressID: session.activeProgressID,
    suspendedProgressIDs: session.suspendedProgressIDs,
  };
}

/** 把内存快照编码成与 Swift `JSONEncoder` 兼容的 JSON 文本。 */
export function encodeSnapshot(snapshot: RoutineSnapshot): string {
  return JSON.stringify({
    templates: snapshot.templates.map(encodeTemplate),
    activeSession: snapshot.activeSession ? encodeSession(snapshot.activeSession) : null,
    updatedAt: msToRefSeconds(snapshot.updatedAt.getTime()),
    originID: snapshot.originID,
  });
}

// ---- decode ----

function decodeStep(raw: unknown): RoutineStep {
  const obj = requireObject(raw, 'step');
  return createStep({
    ...(obj.commute ? { commute: decodeCommute(obj.commute) } : {}),
    id: requiredString(obj.id, 'step.id'),
    title: requiredString(obj.title, 'step.title'),
    // prompt 在 Swift 里非可选；旧数据若缺失，回落默认值。
    prompt: optionalString(obj.prompt) ?? `现在只做：${requiredString(obj.title, 'step.title')}`,
    duration: requiredNumber(obj.duration, 'step.duration'),
    importance: requiredEnum(obj.importance, STEP_IMPORTANCE_VALUES, 'step.importance'),
    role: requiredEnum(obj.role, STEP_ROLE_VALUES, 'step.role'),
  });
}

function decodeTemplate(raw: unknown): RoutineTemplate {
  const obj = requireObject(raw, 'template');
  const rawSteps = obj.steps;
  if (!Array.isArray(rawSteps)) {
    throw new Error('serialization: template.steps 期望数组');
  }
  const recurrence =
    obj.recurrence === null || obj.recurrence === undefined
      ? null
      : requiredEnum(obj.recurrence, RECURRENCE_VALUES, 'template.recurrence');
  return createTemplate({
    id: requiredString(obj.id, 'template.id'),
    name: requiredString(obj.name, 'template.name'),
    symbol: requiredString(obj.symbol, 'template.symbol'),
    mode: requiredEnum(obj.mode, MODE_VALUES, 'template.mode'),
    deadlineHour: optionalNumber(obj.deadlineHour),
    deadlineMinute: optionalNumber(obj.deadlineMinute),
    buffer: requiredNumber(obj.buffer, 'template.buffer'),
    recurrence,
    steps: rawSteps.map(decodeStep),
    ...(obj.commute ? { commute: decodeCommute(obj.commute) } : {}),
  });
}

function decodeCommute(raw: unknown): NonNullable<RoutineTemplate['commute']> {
  const obj = requireObject(raw, 'commute');
  return {
    address: requiredString(obj.address, 'commute.address'),
    location: requiredString(obj.location, 'commute.location'),
    origin: requiredString(obj.origin, 'commute.origin'),
    mode: requiredEnum(obj.mode, ['driving', 'walking', 'transit'] as const, 'commute.mode'),
    seconds: requiredNumber(obj.seconds, 'commute.seconds'),
    polyline: requiredString(obj.polyline, 'commute.polyline'),
  };
}

function decodeProgress(raw: unknown): StepProgress {
  const obj = requireObject(raw, 'progress');
  // 旧数据缺 state → 回落 pending（§0 兼容要求）。
  const state =
    obj.state === undefined || obj.state === null
      ? 'pending'
      : requiredEnum(obj.state, STEP_STATE_VALUES, 'progress.state');
  return createProgress({
    id: requiredString(obj.id, 'progress.id'),
    step: decodeStep(obj.step),
    dueAt: requiredRefDate(obj.dueAt, 'progress.dueAt'),
    state,
    snoozeCount: optionalNumber(obj.snoozeCount) ?? 0,
    completedAt: optionalRefDate(obj.completedAt),
    isTemporary: typeof obj.isTemporary === 'boolean' ? obj.isTemporary : false,
    plannedDueAt: optionalRefDate(obj.plannedDueAt),
    remainingDuration: optionalNumber(obj.remainingDuration),
    startedAt: optionalRefDate(obj.startedAt),
  });
}

function decodeSession(raw: unknown): RoutineSession {
  const obj = requireObject(raw, 'session');
  const rawProgress = obj.progress;
  if (!Array.isArray(rawProgress)) {
    throw new Error('serialization: session.progress 期望数组');
  }
  return {
    id: requiredString(obj.id, 'session.id'),
    templateID: requiredString(obj.templateID, 'session.templateID'),
    templateName: requiredString(obj.templateName, 'session.templateName'),
    templateSymbol: requiredString(obj.templateSymbol, 'session.templateSymbol'),
    startedAt: requiredRefDate(obj.startedAt, 'session.startedAt'),
    plannedStartAt: requiredRefDate(obj.plannedStartAt, 'session.plannedStartAt'),
    targetDeadline: optionalRefDate(obj.targetDeadline),
    state: requiredEnum(obj.state, SESSION_STATE_VALUES, 'session.state'),
    primaryDevice: requiredEnum(obj.primaryDevice, DEVICE_ROLE_VALUES, 'session.primaryDevice'),
    progress: rawProgress.map(decodeProgress),
    remainingBuffer: requiredNumber(obj.remainingBuffer, 'session.remainingBuffer'),
    updatedAt: requiredRefDate(obj.updatedAt, 'session.updatedAt'),
    revision: requiredNumber(obj.revision, 'session.revision'),
    activeProgressID: optionalString(obj.activeProgressID),
    suspendedProgressIDs: optionalStringArray(obj.suspendedProgressIDs),
  };
}

/** 解码 Swift 端写出的快照 JSON；任何字段非法/缺失返回 null（等价 Swift decode 抛错）。 */
export function decodeSnapshot(json: string): RoutineSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  try {
    const obj = requireObject(parsed, 'snapshot');
    const rawTemplates = obj.templates;
    if (!Array.isArray(rawTemplates)) {
      throw new Error('serialization: snapshot.templates 期望数组');
    }
    return {
      templates: rawTemplates.map(decodeTemplate),
      activeSession: obj.activeSession === null || obj.activeSession === undefined
        ? null
        : decodeSession(obj.activeSession),
      updatedAt: requiredRefDate(obj.updatedAt, 'snapshot.updatedAt'),
      originID: requiredString(obj.originID, 'snapshot.originID'),
    };
  } catch {
    return null;
  }
}

// ---- widget 快照编解码（App Group 共享精简快照，§1.2） ----

/** 编码 MainlineWidgetSnapshot（与 Swift Codable 对齐）。 */
export function encodeWidgetSnapshot(snapshot: MainlineWidgetSnapshot): string {
  return JSON.stringify({
    capturedAt: snapshot.capturedAt ? msToRefSeconds(snapshot.capturedAt.getTime()) : null,
    currentTitle: snapshot.currentTitle,
    currentDueAt: snapshot.currentDueAt ? msToRefSeconds(snapshot.currentDueAt.getTime()) : null,
    originalDueAt: snapshot.originalDueAt
      ? msToRefSeconds(snapshot.originalDueAt.getTime())
      : null,
    isHardDeadline: snapshot.isHardDeadline,
    estimatedCompletion: snapshot.estimatedCompletion
      ? msToRefSeconds(snapshot.estimatedCompletion.getTime())
      : null,
    isLate: snapshot.isLate,
    delayDuration: snapshot.delayDuration,
    hasActiveSession: snapshot.hasActiveSession,
    sessionName: snapshot.sessionName,
  });
}

/** 解码 MainlineWidgetSnapshot。 */
export function decodeWidgetSnapshot(json: string): MainlineWidgetSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isObject(parsed)) {
    return null;
  }
  const obj = parsed;
  return {
    capturedAt: optionalRefDate(obj.capturedAt),
    currentTitle: optionalString(obj.currentTitle),
    currentDueAt: optionalRefDate(obj.currentDueAt),
    originalDueAt: optionalRefDate(obj.originalDueAt),
    isHardDeadline: typeof obj.isHardDeadline === 'boolean' ? obj.isHardDeadline : false,
    estimatedCompletion: optionalRefDate(obj.estimatedCompletion),
    isLate: typeof obj.isLate === 'boolean' ? obj.isLate : false,
    delayDuration: optionalNumber(obj.delayDuration),
    hasActiveSession: typeof obj.hasActiveSession === 'boolean' ? obj.hasActiveSession : false,
    sessionName: optionalString(obj.sessionName),
  };
}

/** 重新导出：便于其他 core 模块从 serialization 取用深拷贝工具。 */
export { cloneSession, cloneTemplate };
