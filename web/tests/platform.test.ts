import { describe, expect, it } from 'vitest';
import { createBridge } from '../src/platform/bridge';
import { createBrowserBridge } from '../src/platform/browser';
import { createMockBridge } from '../src/platform/mock';
import { decodeParseResultWire } from '../src/platform/webview';
import { createSnapshot, createSession, createProgress, createStep } from '../src/core/types';

describe('platform/bridge — 宿主探测', () => {
  it('无 window.webkit 时回落浏览器宿主（Node 环境）', () => {
    const bridge = createBridge();
    expect(bridge.host).toBe('browser');
  });
});

describe('platform/browser — 浏览器宿主能力与降级', () => {
  it('无后端代理时 parseWithModel 一律返回 null（绝不暴露 Key）', async () => {
    const bridge = createBrowserBridge();
    await expect(bridge.parseWithModel('去厕所5分钟')).resolves.toBeNull();
    expect(bridge.capabilities.modelParsing).toBe(false);
  });

  it('能力矩阵：watchSync/widget 恒为 false（浏览器物理边界）', () => {
    const bridge = createBrowserBridge();
    expect(bridge.capabilities.watchSync).toBe(false);
    expect(bridge.capabilities.widget).toBe(false);
    // backgroundNotification 取决于 Web Push 探测；Node 环境无 navigator → false。
    expect(bridge.capabilities.backgroundNotification).toBe(false);
  });

  it('deviceInfo().id 稳定且持久（同一实例多次调用一致）', async () => {
    const bridge = createBrowserBridge();
    const first = await bridge.deviceInfo();
    const second = await bridge.deviceInfo();
    expect(first.id).toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.role).toBe('phone');
  });

  it('writeSnapshot → readSnapshot 往返一致（内存兜底存储）', async () => {
    const bridge = createBrowserBridge();
    const updatedAt = new Date(1_700_000_000_000);
    const snapshot = createSnapshot({ templates: [], activeSession: null, updatedAt });
    await bridge.writeSnapshot(snapshot);
    const restored = await bridge.readSnapshot();
    expect(restored).not.toBeNull();
    expect(restored?.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(restored?.originID).toBe(snapshot.originID);
  });

  it('无快照时 readSnapshot 返回 null', async () => {
    const bridge = createBrowserBridge();
    await expect(bridge.readSnapshot()).resolves.toBeNull();
  });

  it('无 Notification 时 requestNotificationAuthorization 返回 false', async () => {
    const bridge = createBrowserBridge();
    await expect(bridge.requestNotificationAuthorization()).resolves.toBe(false);
  });

  it('presentNotification / replaceNotifications 在缺能力时静默 no-op（不抛错）', async () => {
    const bridge = createBrowserBridge();
    await expect(bridge.presentNotification({ title: 't', body: 'b' })).resolves.toBeUndefined();
    await expect(bridge.replaceNotifications(null)).resolves.toBeUndefined();
  });

  it('onSnapshotChanged / onNotificationOpened 返回可调用的取消函数', () => {
    const bridge = createBrowserBridge();
    const off1 = bridge.onSnapshotChanged(() => {});
    const off2 = bridge.onNotificationOpened(() => {});
    expect(typeof off1).toBe('function');
    expect(typeof off2).toBe('function');
    expect(() => off1()).not.toThrow();
    expect(() => off2()).not.toThrow();
  });
});

describe('platform/mock — 内存桥（记录调用 + 事件触发）', () => {
  it('默认 parseWithModel 返回 null 且记录输入', async () => {
    const bridge = createMockBridge();
    expect(bridge.capabilities.modelParsing).toBe(false);
    await expect(bridge.parseWithModel('abc')).resolves.toBeNull();
    expect(bridge.parseWithModelCalls).toEqual(['abc']);
  });

  it('writeSnapshot / replaceNotifications 同步记录调用（供 commit 断言）', async () => {
    const bridge = createMockBridge();
    const updatedAt = new Date(1_700_000_000_000);
    const snapshot = createSnapshot({ templates: [], activeSession: null, updatedAt });
    await bridge.writeSnapshot(snapshot);
    await bridge.replaceNotifications(null);
    expect(bridge.writeSnapshotCalls).toHaveLength(1);
    expect(bridge.replaceNotificationsCalls).toEqual([null]);
  });

  it('emitSnapshotChanged / emitNotificationOpened 触发订阅回调，取消后不再触发', () => {
    const bridge = createMockBridge();
    const received: number[] = [];
    const off = bridge.onSnapshotChanged((s) => received.push(s.updatedAt.getTime()));
    const snapshot = createSnapshot({
      templates: [],
      activeSession: null,
      updatedAt: new Date(1_700_000_000_000),
    });
    bridge.emitSnapshotChanged(snapshot);
    expect(received).toEqual([1_700_000_000_000]);
    off();
    bridge.emitSnapshotChanged(snapshot);
    expect(received).toHaveLength(1);
  });
});

describe('platform/webview — 线格式解码（Apple 参考秒）', () => {
  it('decodeParseResultWire 把参考秒 deadline 还原为 Date，并保留步骤/来源', () => {
    // 2026-08-13 18:30 CST (UTC+8) 的 Unix 秒 = 1786619400；参考秒 = 减 978307200。
    const unixSeconds = Date.UTC(2026, 7, 13, 10, 30) / 1000; // 18:30 CST
    const refSeconds = unixSeconds - 978307200;
    const decoded = decodeParseResultWire({
      steps: [
        { title: '去厕所', duration: 300, importance: 'normal', role: 'task' },
        { title: '刷杯子', duration: 120, importance: 'normal', role: 'task' },
      ],
      deadline: refSeconds,
      source: 'enhanced',
      leftover: '',
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.steps.map((s) => s.title)).toEqual(['去厕所', '刷杯子']);
    expect(decoded?.source).toBe('enhanced');
    expect(decoded?.deadline?.getTime()).toBe(unixSeconds * 1000);
  });

  it('decodeParseResultWire 对空/非法输入返回 null', () => {
    expect(decodeParseResultWire(null)).toBeNull();
    expect(decodeParseResultWire('nope')).toBeNull();
    expect(decodeParseResultWire({ steps: [] })).toBeNull();
  });
});

describe('platform — 会话线格式（encodeSession 走 Apple 参考秒）', () => {
  it('writeSnapshot 后读回的会话 revision/dueAt 保持一致', async () => {
    const bridge = createBrowserBridge();
    const dueAt = new Date(1_700_000_300_000);
    const progress = createProgress({
      step: createStep({ title: '刷牙', duration: 180 }),
      dueAt,
    });
    const session = createSession({
      templateID: 'T',
      templateName: '上班早晨',
      templateSymbol: 'sun.max.fill',
      startedAt: new Date(1_700_000_000_000),
      plannedStartAt: new Date(1_700_000_000_000),
      targetDeadline: null,
      state: 'running',
      primaryDevice: 'phone',
      progress: [progress],
      remainingBuffer: 600,
      updatedAt: new Date(1_700_000_000_000),
      revision: 3,
    });
    const snapshot = createSnapshot({
      templates: [],
      activeSession: session,
      updatedAt: new Date(1_700_000_000_000),
    });
    await bridge.writeSnapshot(snapshot);
    const restored = await bridge.readSnapshot();
    expect(restored?.activeSession?.revision).toBe(3);
    expect(restored?.activeSession?.progress[0].dueAt.getTime()).toBe(dueAt.getTime());
    expect(restored?.activeSession?.remainingBuffer).toBe(600);
  });
});
