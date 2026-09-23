/**
 * compare.ts — 跨端交叉验证比对脚本（用 vite-node 运行，见 README.md）。
 *
 * 三个方向：
 *   A. Swift→TS：Swift 真跑 JSONEncoder 产出字节 → TS decodeSnapshot 解码 → 逐字段比对绝对时刻/键名/enum/UUID
 *   B. nil optional 兼容：Swift 省略 nil 键 → TS 能否解；TS 写显式 null → Swift 能否解
 *   C. TS→Swift：TS encodeSnapshot 产出 → Swift JSONDecoder 解码
 *
 * 运行：web/node_modules/.bin/vite-node tools/cross-check/compare.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeSnapshot,
  encodeSnapshot,
  msToRefSeconds,
} from '../../web/src/core/serialization';
import {
  createProgress,
  createSession,
  createSnapshot,
  createStep,
  createTemplate,
  initialSnapshot,
  DISTANT_PAST,
  MORNING_TEMPLATE,
  type RoutineSession,
  type RoutineSnapshot,
} from '../../web/src/core/types';
import { RoutineStore } from '../../web/src/core/store';
import { makeWidgetSnapshot } from '../../web/src/core/widget';
import { analyze, inferredDeadline, makeSteps } from '../../web/src/core/parser';
import { decodePayload } from '../../web/src/core/remote';
import {
  estimatedCompletion,
  estimatedDueDates,
  expectedDeadline,
  isLate,
  originalDueAt,
  remainingWork,
  totalTaskDuration,
} from '../../web/src/core/session';

const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, 'SwiftHarness', 'harness');
const storeHarness = join(here, 'StoreHarness', 'store_harness');

function runHarness(mode: string, stdin?: string, tz?: string): string {
  return execFileSync(harness, [mode], {
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(tz ? { env: { ...process.env, TZ: tz } } : {}),
  });
}

function runStoreHarness(): string {
  return execFileSync(storeHarness, [], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'Asia/Shanghai' },
  });
}

const parserHarness = join(here, 'ParserHarness', 'parser_harness');
function runParserHarness(): Record<string, any> {
  const out = execFileSync(parserHarness, [], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TZ: 'Asia/Shanghai' },
  });
  return JSON.parse(out);
}

// 与 ParserHarness.swift 完全一致的输入清单
const deadlineInputs = [
  '出门10点半', '结束8点半', '8点半出门', '18点半结束',
  '结束18:10', '结束 18:10', '截止8:35', '结束18点10分', '出门10点',
  '去厕所5分钟 结束8:35', '18点30结束，去厕所5分钟', '8点出门',
  '18:30结束', '18点30分结束', '18点结束',
  '买水果10分钟', '去厕所5分钟 刷杯子2分钟', '7点起床，洗脸5分钟',
];
const stepInputs = [
  '博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分',
  '语文2小时 英语1小时 数学30分钟',
  '去厕所5分钟 别忘了倒垃圾',
  '18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟',
];
const analyzeInputs = [
  '博兴任务20分钟  去厕所5分钟',
  '去厕所5分钟 别忘了倒垃圾',
  '去厕所5分钟 截止时间18点10分',
  '去厕所5分钟 8点出门',
];
const remoteInputs = [
  '{"steps":[{"title":"去厕所","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}',
  '好的，这是解析结果：\n```json\n{"steps":[{"title":"刷牙","durationMinutes":3}],"deadlineHour":null,"deadlineMinute":null}\n```\n需要我调整吗？',
  '{"steps":[{"title":"洗脸","durationMinutes":"5"}]}',
  '{"tasks":[{"name":"去厕所","duration_minutes":5},{"name":"刷杯子","duration_minutes":2},{"name":"出门","time":"08:30"}]}',
  '[{"title":"刷牙","durationMinutes":3}]',
  '{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}',
  '{"steps":[{"title":"洗脸","durationMinutes":5}],"deadline":"08:30"}',
  '{"steps":[{"title":"出门","time":"8点半"}]}',
  '{"steps":[{"title":"7点起床","time":"7:00"},{"title":"洗脸","durationMinutes":5}]}',
  '{"steps":[{"title":"倒垃圾"},{"title":"洗脸","durationMinutes":5}]}',
  '{"steps":[]}',
  '我不知道该怎么拆',
  '',
];
const ANCHOR_MS = 1_786_593_600_000;

// ---------------------------------------------------------------------------
// 通用深比对
// ---------------------------------------------------------------------------
type Diff = { path: string; expected: unknown; actual: unknown };
const diffs: Diff[] = [];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function compare(truth: unknown, actual: unknown, path: string): void {
  if (Array.isArray(truth)) {
    if (!Array.isArray(actual)) {
      diffs.push({ path, expected: `array(len=${truth.length})`, actual: actual });
      return;
    }
    if (truth.length !== actual.length) {
      diffs.push({ path, expected: `array(len=${truth.length})`, actual: `array(len=${actual.length})` });
      return;
    }
    truth.forEach((item, i) => compare(item, actual[i], `${path}[${i}]`));
    return;
  }
  if (isObj(truth)) {
    if (!isObj(actual)) {
      diffs.push({ path, expected: 'object', actual: actual });
      return;
    }
    for (const key of Object.keys(truth)) {
      compare(truth[key], actual[key], `${path}.${key}`);
    }
    for (const key of Object.keys(actual)) {
      if (!(key in truth)) {
        diffs.push({ path: `${path}.${key}`, expected: '(absent in truth)', actual: actual[key] });
      }
    }
    return;
  }
  // primitive or null
  if (truth !== actual) {
    diffs.push({ path, expected: truth, actual: actual });
  }
}

// ---------------------------------------------------------------------------
// A. Swift→TS
// ---------------------------------------------------------------------------
function projectStep(s: { id: string; title: string; prompt: string; duration: number; importance: string; role: string }) {
  return { id: s.id, title: s.title, prompt: s.prompt, duration: s.duration, importance: s.importance, role: s.role };
}

function projectSnapshot(s: RoutineSnapshot): Record<string, unknown> {
  return {
    updatedAt: s.updatedAt.getTime(),
    originID: s.originID,
    templates: s.templates.map((t) => ({
      id: t.id,
      name: t.name,
      symbol: t.symbol,
      mode: t.mode,
      buffer: t.buffer,
      deadlineHour: t.deadlineHour,
      deadlineMinute: t.deadlineMinute,
      recurrence: t.recurrence,
      steps: t.steps.map(projectStep),
    })),
    activeSession: s.activeSession ? projectSession(s.activeSession) : null,
  };
}

function projectSession(s: RoutineSession): Record<string, unknown> {
  return {
    id: s.id,
    templateID: s.templateID,
    templateName: s.templateName,
    templateSymbol: s.templateSymbol,
    startedAt: s.startedAt.getTime(),
    plannedStartAt: s.plannedStartAt.getTime(),
    targetDeadline: s.targetDeadline ? s.targetDeadline.getTime() : null,
    state: s.state,
    primaryDevice: s.primaryDevice,
    remainingBuffer: s.remainingBuffer,
    updatedAt: s.updatedAt.getTime(),
    revision: s.revision,
    activeProgressID: s.activeProgressID,
    suspendedProgressIDs: s.suspendedProgressIDs,
    progress: s.progress.map((p) => ({
      id: p.id,
      dueAt: p.dueAt.getTime(),
      state: p.state,
      snoozeCount: p.snoozeCount,
      completedAt: p.completedAt ? p.completedAt.getTime() : null,
      isTemporary: p.isTemporary,
      plannedDueAt: p.plannedDueAt ? p.plannedDueAt.getTime() : null,
      remainingDuration: p.remainingDuration,
      startedAt: p.startedAt ? p.startedAt.getTime() : null,
      stepID: p.step.id,
    })),
  };
}

let passA = false;
function runA(): void {
  const emit = runHarness('emit').trim();
  const truth = JSON.parse(runHarness('truth')) as Record<string, unknown>;
  const decoded = decodeSnapshot(emit);
  console.log('--- A. Swift→TS ---');
  if (!decoded) {
    diffs.push({ path: '(decodeSnapshot)', expected: 'non-null', actual: 'null' });
    return;
  }
  compare(truth, projectSnapshot(decoded), '$');
  passA = diffs.length === 0;
}

// ---------------------------------------------------------------------------
// B. nil optional 兼容
// ---------------------------------------------------------------------------
function runB(): { omitConfirmed: boolean; tsDecodesSwiftNil: boolean; swiftDecodesTsNull: boolean } {
  console.log('--- B. nil optional ---');
  const nilOut = runHarness('nilcheck');
  const blocks = nilOut
    .split(/^===.*===$/m)
    .map((b) => b.trim())
    .filter((b) => b.startsWith('{'));
  let tsDecodesSwiftNil = true;
  for (const block of blocks) {
    const dec = decodeSnapshot(block);
    if (!dec) tsDecodesSwiftNil = false;
  }

  // 验证 Swift 确实「省略键」而非写 null
  const obj = JSON.parse(blocks[0]) as Record<string, unknown>;
  const t0 = (obj.templates as Record<string, unknown>[])[0];
  const omitConfirmed =
    !('recurrence' in t0) && !('deadlineHour' in t0) && !('deadlineMinute' in t0) && !('activeSession' in obj);

  // TS 写显式 null → Swift 能否解？
  const tsSnapshot = createSnapshot({
    templates: [
      createTemplate({
        id: '5E43ED14-458A-49CF-8673-A96DCA196001',
        name: '上班早晨',
        symbol: 'sun.max.fill',
        mode: 'backward',
        deadlineHour: 8,
        deadlineMinute: 35,
        buffer: 600,
        recurrence: 'daily',
        steps: [createStep({ id: '10000000-0000-0000-0000-000000000001', title: '刷牙', duration: 180 })],
      }),
      // recurrence=null / deadlineHour=null → TS 会写成显式 null
      createTemplate({
        id: 'AAAAAAAA-BBBB-CCCC-DDDD-0000000000AA',
        name: '空可选',
        symbol: 'x',
        mode: 'forward',
        recurrence: null,
        steps: [createStep({ id: '10000000-0000-0000-0000-000000000002', title: '任务', duration: 60 })],
      }),
    ],
    activeSession: createSession({
      id: '30000000-0000-0000-0000-000000000001',
      templateID: '5E43ED14-458A-49CF-8673-A96DCA196001',
      templateName: '上班早晨',
      templateSymbol: 'sun.max.fill',
      startedAt: new Date(1_700_000_000_000),
      plannedStartAt: new Date(1_699_999_400_000),
      targetDeadline: null,
      state: 'running',
      primaryDevice: 'phone',
      progress: [
        createProgress({
          id: '20000000-0000-0000-0000-000000000004',
          step: createStep({ id: '10000000-0000-0000-0000-000000000003', title: '裸', duration: 60 }),
          dueAt: new Date(1_700_000_060_000),
          // completedAt/plannedDueAt/remainingDuration/startedAt 全 nil → TS 写显式 null
        }),
      ],
      remainingBuffer: 0,
      updatedAt: new Date(1_700_000_000_000),
      revision: 1,
      // activeProgressID/suspendedProgressIDs nil → TS 写显式 null
    }),
    updatedAt: new Date(1_700_000_000_000),
    originID: 'AAAAAAAA-BBBB-CCCC-DDDD-000000000001',
  });
  const tsJson = encodeSnapshot(tsSnapshot);
  let swiftDecodesTsNull = false;
  try {
    const out = runHarness('decode', tsJson);
    swiftDecodesTsNull = out.startsWith('DECODE_OK');
  } catch (e) {
    console.log('Swift 解码 TS JSON 失败：', (e as Error).message);
  }

  console.log('Swift 省略 nil 键（非 null）:', omitConfirmed);
  console.log('TS 能解 Swift 省略键（含 activeSession 缺失）:', tsDecodesSwiftNil);
  console.log('Swift 能解 TS 显式 null:', swiftDecodesTsNull);
  return { omitConfirmed, tsDecodesSwiftNil, swiftDecodesTsNull };
}

// ---------------------------------------------------------------------------
// C. TS→Swift（字段级一致性）
// ---------------------------------------------------------------------------
function runC(): void {
  console.log('--- C. TS→Swift ---');
  const tsSnapshot = createSnapshot({
    templates: [
      createTemplate({
        id: '5E43ED14-458A-49CF-8673-A96DCA196001',
        name: '上班早晨',
        symbol: 'sun.max.fill',
        mode: 'backward',
        deadlineHour: 8,
        deadlineMinute: 35,
        buffer: 600,
        recurrence: 'daily',
        steps: [
          createStep({ id: '10000000-0000-0000-0000-000000000001', title: '刷牙', prompt: '先刷牙', duration: 180, importance: 'normal', role: 'task' }),
          createStep({ id: '10000000-0000-0000-0000-000000000004', title: '出门', prompt: '现在出门', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
        ],
      }),
    ],
    activeSession: createSession({
      id: '30000000-0000-0000-0000-000000000001',
      templateID: '5E43ED14-458A-49CF-8673-A96DCA196001',
      templateName: '上班早晨',
      templateSymbol: 'sun.max.fill',
      startedAt: new Date(1_700_000_000_000),
      plannedStartAt: new Date(1_699_999_400_000),
      targetDeadline: new Date(1_700_001_200_000),
      state: 'running',
      primaryDevice: 'phone',
      progress: [
        createProgress({
          id: '20000000-0000-0000-0000-000000000001',
          step: createStep({ id: '10000000-0000-0000-0000-000000000002', title: '洗脸', duration: 300 }),
          dueAt: new Date(1_700_000_600_000),
          state: 'active',
          plannedDueAt: new Date(1_700_000_600_000),
          remainingDuration: 300,
          startedAt: new Date(1_700_000_100_000),
        }),
      ],
      remainingBuffer: 600,
      updatedAt: new Date(1_700_000_000_000),
      revision: 3,
      activeProgressID: '20000000-0000-0000-0000-000000000001',
      suspendedProgressIDs: ['20000000-0000-0000-0000-000000000003'],
    }),
    updatedAt: new Date(1_699_999_990_000),
    originID: 'AAAAAAAA-BBBB-CCCC-DDDD-000000000001',
  });

  const tsJson = encodeSnapshot(tsSnapshot);
  const out = runHarness('decode', tsJson);
  if (!out.startsWith('DECODE_OK')) {
    diffs.push({ path: '(TS→Swift decode)', expected: 'DECODE_OK', actual: out.split('\n')[0] });
    return;
  }
  const truthIdx = out.indexOf('=== TRUTH ===');
  const truth = JSON.parse(out.slice(truthIdx + '=== TRUTH ==='.length).trim()) as Record<string, unknown>;
  compare(truth, projectSnapshot(tsSnapshot), '$');
}

// ---------------------------------------------------------------------------
// D. RoutineStore.start 排程算法交叉验证（M1/M3，含末尾 deadline 节点）
// ---------------------------------------------------------------------------
function projectStoreStart(): Record<string, unknown> {
  const store = new RoutineStore({
    deviceRole: 'phone',
    tz: 'Asia/Shanghai',
    deviceID: 'AAAAAAAA-BBBB-CCCC-DDDD-000000000001',
  });
  const now = new Date(1_786_575_600_000);
  store.start(MORNING_TEMPLATE, null, null, now);
  const s = store.session!;
  return {
    timeZone: 'Asia/Shanghai',
    now: now.getTime(),
    templateMode: MORNING_TEMPLATE.mode,
    templateDeadlineHour: MORNING_TEMPLATE.deadlineHour,
    templateDeadlineMinute: MORNING_TEMPLATE.deadlineMinute,
    templateBuffer: MORNING_TEMPLATE.buffer,
    totalTaskDuration: totalTaskDuration(MORNING_TEMPLATE),
    sessionState: s.state,
    targetDeadline: s.targetDeadline ? s.targetDeadline.getTime() : null,
    plannedStartAt: s.plannedStartAt.getTime(),
    remainingBuffer: s.remainingBuffer,
    revision: s.revision,
    activeProgressIDIsNil: s.activeProgressID === null,
    suspendedProgressIDsIsNil: s.suspendedProgressIDs === null,
    progress: s.progress.map((p) => ({
      title: p.step.title,
      role: p.step.role,
      importance: p.step.importance,
      stepDuration: p.step.duration,
      state: p.state,
      dueAt: p.dueAt.getTime(),
      plannedDueAt: p.plannedDueAt ? p.plannedDueAt.getTime() : null,
      remainingDuration: p.remainingDuration,
      snoozeCount: p.snoozeCount,
      isTemporary: p.isTemporary,
      startedAt: p.startedAt ? p.startedAt.getTime() : null,
      completedAt: p.completedAt ? p.completedAt.getTime() : null,
    })),
  };
}

function runD(): void {
  console.log('--- D. RoutineStore.start 排程 ---');
  const truth = JSON.parse(runStoreHarness()) as Record<string, unknown>;
  compare(truth, projectStoreStart(), '$start');
}

// ---------------------------------------------------------------------------
// E. RoutineSession 计算属性交叉验证（M17/M18/M19，测试 8 锚点）
// ---------------------------------------------------------------------------
function projectSessionAnchor(): Record<string, unknown> {
  // Swift: Date(timeIntervalSince1970: 10_000) = 10_000 秒；JS new Date(...) 收毫秒。
  const now = new Date(10_000_000);
  const target = new Date(now.getTime() - 600_000);
  const first = createProgress({
    id: '40000000-0000-0000-0000-000000000001',
    step: createStep({ title: 'first', duration: 300 }),
    dueAt: target,
    state: 'pending',
    plannedDueAt: target,
    remainingDuration: 300,
  });
  const second = createProgress({
    id: '40000000-0000-0000-0000-000000000002',
    step: createStep({ title: 'second', duration: 300 }),
    dueAt: new Date(target.getTime() + 300_000),
    state: 'pending',
    plannedDueAt: new Date(target.getTime() + 300_000),
    remainingDuration: 300,
  });
  const deadline = createProgress({
    id: '40000000-0000-0000-0000-000000000003',
    step: createStep({ title: '完成', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
    dueAt: new Date(target.getTime() + 300_000),
    state: 'pending',
    plannedDueAt: new Date(target.getTime() + 300_000),
  });
  const session = createSession({
    id: '30000000-0000-0000-0000-000000000001',
    templateID: '5E43ED14-458A-49CF-8673-A96DCA196001',
    templateName: '锚点',
    templateSymbol: 'x',
    startedAt: target,
    plannedStartAt: target,
    targetDeadline: target,
    state: 'running',
    primaryDevice: 'phone',
    progress: [first, second, deadline],
    remainingBuffer: 0,
    updatedAt: target,
    revision: 1,
    activeProgressID: null,
    suspendedProgressIDs: null,
  });
  const est = estimatedDueDates(session, now);
  return {
    now: now.getTime(),
    targetDeadline: target.getTime(),
    estimateFirst: est.get(first.id)?.getTime() ?? null,
    estimateSecond: est.get(second.id)?.getTime() ?? null,
    estimateDeadline: est.get(deadline.id)?.getTime() ?? null,
    estimatedCompletion: estimatedCompletion(session, now)?.getTime() ?? null,
    isLate: isLate(session, now),
    originalDueAtFirst: originalDueAt(first).getTime(),
    remainingWorkFirst: remainingWork(first),
    expectedDeadline: expectedDeadline(session)?.getTime() ?? null,
    timeZone: 'Asia/Shanghai',
  };
}

function runE(): void {
  console.log('--- E. RoutineSession 计算属性 ---');
  const truth = JSON.parse(runHarness('session', undefined, 'Asia/Shanghai')) as Record<string, unknown>;
  compare(truth, projectSessionAnchor(), '$session');
}

// ---------------------------------------------------------------------------
// F. Widget 延误公式交叉验证（复现 widget.test.ts 场景，核验 900 期望值）
// ---------------------------------------------------------------------------
function projectWidget(): Record<string, unknown> {
  const now = new Date(10_000); // 10 秒（widget.test.ts 的 new Date(10000) 毫秒）
  const target = new Date(now.getTime() - 600_000);
  const first = createProgress({
    id: '40000000-0000-0000-0000-000000000011',
    step: createStep({ title: '当前任务', duration: 300 }),
    dueAt: target,
    state: 'pending',
    plannedDueAt: target,
    remainingDuration: 300,
  });
  const deadline = createProgress({
    id: '40000000-0000-0000-0000-000000000012',
    step: createStep({ title: '完成', duration: 0, importance: 'hardDeadline', role: 'deadline' }),
    dueAt: target,
    state: 'pending',
    plannedDueAt: target,
  });
  const session = createSession({
    id: '30000000-0000-0000-0000-000000000001',
    templateID: '5E43ED14-458A-49CF-8673-A96DCA196001',
    templateName: '测试',
    templateSymbol: 'checkmark',
    startedAt: target,
    plannedStartAt: target,
    targetDeadline: target,
    state: 'running',
    primaryDevice: 'phone',
    progress: [first, deadline],
    remainingBuffer: 0,
    updatedAt: target,
    revision: 1,
    activeProgressID: null,
    suspendedProgressIDs: null,
  });
  const snap = createSnapshot({ templates: [], activeSession: session, updatedAt: target });
  const widget = makeWidgetSnapshot(snap, now);
  return {
    estimatedCompletion: widget.estimatedCompletion?.getTime() ?? null,
    delayDuration: widget.delayDuration,
    isLate: widget.isLate,
  };
}

function runF(): void {
  console.log('--- F. Widget 延误公式 ---');
  const truth = JSON.parse(runHarness('widget')) as Record<string, unknown>;
  compare(truth, projectWidget(), '$widget');
}

// ---------------------------------------------------------------------------
// G–J. 解析层交叉验证（M5–M12 / M27）
// ---------------------------------------------------------------------------
function runParser(): { g: number; h: number; i: number; j: number } {  console.log('--- G–J. 解析层 ---');
  const truth = runParserHarness();
  const anchor = new Date(ANCHOR_MS);

  const beforeG = diffs.length;
  const tsDeadline: Record<string, number | null> = {};
  for (const input of deadlineInputs) {
    const d = inferredDeadline(input, anchor, 'Asia/Shanghai');
    tsDeadline[input] = d ? d.getTime() : null;
  }
  compare(truth.deadline, tsDeadline, '$deadline');
  const g = diffs.length - beforeG;

  const beforeH = diffs.length;
  const tsSteps: Record<string, unknown> = {};
  for (const input of stepInputs) {
    tsSteps[input] = makeSteps(input).map((s) => ({ title: s.title, duration: s.duration, role: s.role }));
  }
  compare(truth.steps, tsSteps, '$steps');
  const h = diffs.length - beforeH;

  const beforeI = diffs.length;
  const tsAnalyze: Record<string, unknown> = {};
  for (const input of analyzeInputs) {
    const o = analyze(input, anchor, 'Asia/Shanghai');
    tsAnalyze[input] = {
      titles: o.steps.map((s) => s.title),
      leftover: o.leftover,
      isComplete: o.isComplete,
      deadline: o.deadline ? o.deadline.getTime() : null,
    };
  }
  compare(truth.analyze, tsAnalyze, '$analyze');
  const i = diffs.length - beforeI;

  const beforeJ = diffs.length;
  const tsRemote: Record<string, unknown> = {};
  for (const content of remoteInputs) {
    const p = decodePayload(content);
    tsRemote[content] = p
      ? {
          steps: p.steps.map((item) => ({ title: item.title, minutes: item.minutes })),
          deadlineHour: p.deadlineHour,
          deadlineMinute: p.deadlineMinute,
        }
      : null;
  }
  compare(truth.remote, tsRemote, '$remote');
  const j = diffs.length - beforeJ;

  return { g, h, i, j };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// K（信息项，不 gate）：Date.distantPast 常量对齐核查
// ---------------------------------------------------------------------------
function runK(): { swiftPastMs: number; tsPastMs: number; driftSeconds: number } {
  const info = JSON.parse(runHarness('constants')) as { distantPastMs: number };
  return {
    swiftPastMs: info.distantPastMs,
    tsPastMs: DISTANT_PAST.getTime(),
    driftSeconds: (info.distantPastMs - DISTANT_PAST.getTime()) / 1000,
  };
}

// ---- 自检：故意注入错误，证明比对器真的能发现问题（证伪脚本自身） ----
function selfTest(): boolean {
  const truth = JSON.parse(runHarness('truth')) as Record<string, unknown>;
  const emit = runHarness('emit').trim();
  const decoded = decodeSnapshot(emit)!;
  const proj = projectSnapshot(decoded);
  // 注入三处错误：日期偏移、enum 改值、UUID 改大小写
  const broken = JSON.parse(JSON.stringify(truth)) as any;
  broken.updatedAt = broken.updatedAt + 1000;
  broken.activeSession.state = 'cancelled';
  broken.templates[0].id = broken.templates[0].id.toLowerCase();
  const saved = diffs.splice(0, diffs.length);
  compare(broken, proj, '$');
  const detected = diffs.length;
  diffs.splice(0, diffs.length);
  diffs.push(...saved);
  return detected >= 3;
}

const selfTestOk = selfTest();
const k = runK();

const beforeA = diffs.length;
runA();
const aDiffs = diffs.slice(beforeA);
const b = runB();
const beforeC = diffs.length;
runC();
const cDiffs = diffs.slice(beforeC);

const beforeD = diffs.length;
runD();
const dDiffs = diffs.slice(beforeD);

const beforeE = diffs.length;
runE();
const eDiffs = diffs.slice(beforeE);

const beforeF = diffs.length;
runF();
const fDiffs = diffs.slice(beforeF);

const beforeP = diffs.length;
const parserCounts = runParser();
const parserDiffs = diffs.slice(beforeP);

console.log('\n=== 结果 ===');
console.log(`0. 比对器自检（注入 3 处错误 → 能否检出）: ${selfTestOk ? 'OK' : 'FAIL'}`);
console.log(`A. Swift→TS 字段一致性: ${aDiffs.length === 0 ? '一致' : '不一致（' + aDiffs.length + ' 处）'}`);
if (aDiffs.length) aDiffs.slice(0, 40).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`B. nil 省略确认=${b.omitConfirmed} | TS 解 Swift 省略键=${b.tsDecodesSwiftNil} | Swift 解 TS null=${b.swiftDecodesTsNull}`);
console.log(`C. TS→Swift 字段一致性: ${cDiffs.length === 0 ? '一致' : '不一致（' + cDiffs.length + ' 处）'}`);
if (cDiffs.length) cDiffs.slice(0, 40).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`D. RoutineStore.start 排程一致性: ${dDiffs.length === 0 ? '一致' : '不一致（' + dDiffs.length + ' 处）'}`);
if (dDiffs.length) dDiffs.slice(0, 40).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`E. RoutineSession 计算属性一致性: ${eDiffs.length === 0 ? '一致' : '不一致（' + eDiffs.length + ' 处）'}`);
if (eDiffs.length) eDiffs.slice(0, 40).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`F. Widget 延误公式一致性: ${fDiffs.length === 0 ? '一致' : '不一致（' + fDiffs.length + ' 处）'}`);
if (fDiffs.length) fDiffs.slice(0, 40).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`G. 截止时间推断一致性: ${parserCounts.g === 0 ? '一致' : '不一致（' + parserCounts.g + ' 处）'}`);
console.log(`H. makeSteps 一致性: ${parserCounts.h === 0 ? '一致' : '不一致（' + parserCounts.h + ' 处）'}`);
console.log(`I. analyze/leftover 一致性: ${parserCounts.i === 0 ? '一致' : '不一致（' + parserCounts.i + ' 处）'}`);
console.log(`J. 云端宽松解析一致性: ${parserCounts.j === 0 ? '一致' : '不一致（' + parserCounts.j + ' 处）'}`);
if (parserDiffs.length) parserDiffs.slice(0, 60).forEach((d) => console.log(`   差异 ${d.path}: swift=${JSON.stringify(d.expected)} ts=${JSON.stringify(d.actual)}`));
console.log(`K. [信息] Date.distantPast 对齐: swift=${k.swiftPastMs} ts=${k.tsPastMs} 漂移=${k.driftSeconds}s（${k.driftSeconds === 0 ? '完全相等' : '不相等，仅影响 year-1 哨兵值'}）`);

const allPass =
  selfTestOk &&
  aDiffs.length === 0 &&
  b.omitConfirmed &&
  b.tsDecodesSwiftNil &&
  b.swiftDecodesTsNull &&
  cDiffs.length === 0 &&
  dDiffs.length === 0 &&
  eDiffs.length === 0 &&
  fDiffs.length === 0 &&
  parserDiffs.length === 0;
console.log(allPass ? '\nALL_PASS' : '\nHAS_DIFFS');
process.exit(allPass ? 0 : 1);
