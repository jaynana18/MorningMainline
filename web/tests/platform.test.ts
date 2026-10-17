import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridge } from '../src/platform/bridge';
import type { NotificationOpenedPayload } from '../src/platform/bridge';
import { createBrowserBridge } from '../src/platform/browser';
import { createMockBridge } from '../src/platform/mock';
import { WebViewBridge, decodeParseResultWire } from '../src/platform/webview';
import { isPageForeground } from '../src/platform/foreground';
import { encodeSnapshot } from '../src/core/serialization';
import { DEFAULT_OVERDUE_POLICY } from '../src/core/reminders';
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

  it('requestPermission 永不 settle 时超时兜底（返回 false，不永久挂起）', async () => {
    // 真实场景：用户在通知弹窗上既不点允许也不点拒绝（忽略/切走），Promise 不 settle。
    vi.useFakeTimers();
    const original = Reflect.get(globalThis, 'Notification');
    try {
      Reflect.set(globalThis, 'Notification', {
        permission: 'default',
        requestPermission: () => new Promise<never>(() => {}),
      });
      const bridge = createBrowserBridge();
      const pending = bridge.requestNotificationAuthorization();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      Reflect.set(globalThis, 'Notification', original);
      vi.useRealTimers();
    }
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

describe('platform/foreground — isPageForeground（宿主无关前台判定）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('无 document（node 默认）按前台处理', () => {
    expect(isPageForeground()).toBe(true);
  });

  it('document.visibilityState = hidden → 非前台', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    expect(isPageForeground()).toBe(false);
  });

  it('document.visibilityState = visible → 前台', () => {
    vi.stubGlobal('document', { visibilityState: 'visible' });
    expect(isPageForeground()).toBe(true);
  });
});

describe('platform/webview — Bridge 事件暂存（修掉冷启动窗口静默丢事件）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 构造 WebView 宿主的假 window（含 messageHandlers.mainline），供 `install()` 挂入口。 */
  function stubWebViewWindow(): void {
    vi.stubGlobal('window', {
      webkit: { messageHandlers: { mainline: { postMessage: () => {} } } },
    });
  }

  it('订阅前到达的快照事件被暂存，订阅后补发且 updatedAt 正确', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    const updatedAt = new Date(1_700_000_000_000);
    const encoded = encodeSnapshot(
      createSnapshot({ templates: [], activeSession: null, updatedAt }),
    );
    // store.performInit() 尚未订阅时，原生冷启动 emit 的快照。
    window.__mainlineEmit!('snapshot.changed', { snapshot: encoded });

    const received: number[] = [];
    bridge.onSnapshotChanged((snapshot) => received.push(snapshot.updatedAt.getTime()));
    expect(received).toEqual([updatedAt.getTime()]);
  });

  it('订阅前到达的多个快照只保留最新一个（快照是状态而非事件流）', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    const firstAt = new Date(1_700_000_000_000);
    const secondAt = new Date(1_700_000_900_000);
    window.__mainlineEmit!('snapshot.changed', {
      snapshot: encodeSnapshot(
        createSnapshot({ templates: [], activeSession: null, updatedAt: firstAt }),
      ),
    });
    window.__mainlineEmit!('snapshot.changed', {
      snapshot: encodeSnapshot(
        createSnapshot({ templates: [], activeSession: null, updatedAt: secondAt }),
      ),
    });

    const received: number[] = [];
    bridge.onSnapshotChanged((snapshot) => received.push(snapshot.updatedAt.getTime()));
    expect(received).toEqual([secondAt.getTime()]);
  });

  it('订阅前到达的通知点击事件按到达顺序逐条补发', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    window.__mainlineEmit!('notification.opened', { progressID: 'p1' });
    window.__mainlineEmit!('notification.opened', { minuteOffset: -1 });

    const received: NotificationOpenedPayload[] = [];
    bridge.onNotificationOpened((payload) => received.push(payload));
    expect(received).toEqual([{ progressID: 'p1' }, { minuteOffset: -1 }]);
  });

  it('订阅后的事件直接分发，且不重复投递此前暂存的条目（总次数正好）', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    window.__mainlineEmit!('notification.opened', { progressID: 'pending' });

    const received: NotificationOpenedPayload[] = [];
    bridge.onNotificationOpened((payload) => received.push(payload));
    expect(received).toEqual([{ progressID: 'pending' }]);

    // 订阅后到达的新事件走直接分发，不得再把旧事件重新补一遍。
    window.__mainlineEmit!('notification.opened', { progressID: 'live' });
    expect(received).toEqual([{ progressID: 'pending' }, { progressID: 'live' }]);
  });

  it('暂存队列封顶 64：超界丢最旧，保留最新一次点击（首尾双断言）', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    // 无订阅者时 emit 69 条（p0..p68），远超 64 条上限。
    const emitted = 69;
    for (let index = 0; index < emitted; index += 1) {
      window.__mainlineEmit!('notification.opened', { progressID: `p${index}` });
    }

    const received: NotificationOpenedPayload[] = [];
    bridge.onNotificationOpened((payload) => received.push(payload));

    expect(received).toHaveLength(64);
    // 首条应为 p5：证明丢的是最旧 5 条（p0..p4），而非丢最新。
    // 若把 shift() 误写成 pop()，末条会变成 p63 而非 p68 —— 该断言是本封顶的唯一防线。
    expect(received[0].progressID).toBe('p5');
    expect(received[received.length - 1].progressID).toBe('p68');
  });

  it('app.state 暂存：订阅前 emit {visible:false} → 订阅时立即收到 false（订阅即得当前值）', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    window.__mainlineEmit!('app.state', { visible: false });

    const received: boolean[] = [];
    bridge.onAppStateChanged((visible) => received.push(visible));
    expect(received).toEqual([false]);
  });

  it('app.state 只留最新：订阅前 emit false 再 true → 订阅只收到一次 true', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    window.__mainlineEmit!('app.state', { visible: false });
    window.__mainlineEmit!('app.state', { visible: true });

    const received: boolean[] = [];
    bridge.onAppStateChanged((visible) => received.push(visible));
    expect(received).toEqual([true]);
  });

  it('app.state 订阅后实时分发多次；取消订阅后不再收到', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    const received: boolean[] = [];
    const off = bridge.onAppStateChanged((visible) => received.push(visible));

    window.__mainlineEmit!('app.state', { visible: false });
    window.__mainlineEmit!('app.state', { visible: true });
    expect(received).toEqual([false, true]);

    off();
    window.__mainlineEmit!('app.state', { visible: false });
    expect(received).toEqual([false, true]);
  });

  it('app.state 脏载荷按 false 处理（严格 === true 守卫）', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();
    const received: boolean[] = [];
    bridge.onAppStateChanged((visible) => received.push(visible));

    window.__mainlineEmit!('app.state', {});
    window.__mainlineEmit!('app.state', { visible: 'yes' });
    window.__mainlineEmit!('app.state', { visible: true });
    // 前两条脏载荷 → false；第三条合法 → true。
    expect(received).toEqual([false, false, true]);
  });

  it('回归：新增 app.state 分支不影响 snapshot.changed / notification.opened', () => {
    stubWebViewWindow();
    const bridge = new WebViewBridge();

    const snapshots: number[] = [];
    const notifications: NotificationOpenedPayload[] = [];
    const appStates: boolean[] = [];
    bridge.onSnapshotChanged((snapshot) => snapshots.push(snapshot.updatedAt.getTime()));
    bridge.onNotificationOpened((payload) => notifications.push(payload));
    bridge.onAppStateChanged((visible) => appStates.push(visible));

    const updatedAt = new Date(1_700_000_000_000);
    window.__mainlineEmit!('snapshot.changed', {
      snapshot: encodeSnapshot(
        createSnapshot({ templates: [], activeSession: null, updatedAt }),
      ),
    });
    window.__mainlineEmit!('notification.opened', { progressID: 'p1' });
    window.__mainlineEmit!('app.state', { visible: false });

    // 三个通道各自收到自己那一条，互不串扰。
    expect(snapshots).toEqual([updatedAt.getTime()]);
    expect(notifications).toEqual([{ progressID: 'p1' }]);
    expect(appStates).toEqual([false]);
  });
});

describe('platform/browser — 前台去重第二层（页面可见时不发系统通知）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 安装记录构造次数的假 Notification（permission=granted）。 */
  function stubGrantedNotification(constructed: string[]): void {
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      constructor(title: string) {
        constructed.push(title);
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
  }

  it('页面可见时 presentNotification 不构造系统通知（交给页内弹窗）', async () => {
    const constructed: string[] = [];
    stubGrantedNotification(constructed);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const bridge = createBrowserBridge();
    await bridge.presentNotification({ title: '该起床了', body: '去刷牙' });
    expect(constructed).toHaveLength(0);
  });

  it('页面隐藏时 presentNotification 构造系统通知', async () => {
    const constructed: string[] = [];
    stubGrantedNotification(constructed);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    const bridge = createBrowserBridge();
    await bridge.presentNotification({ title: '该起床了', body: '去刷牙' });
    expect(constructed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 语音播报（2026-10-16 新增）
// ---------------------------------------------------------------------------

describe('platform — 语音播报（speak）', () => {
  it('浏览器宿主：Node 环境无 speechSynthesis → 能力为 false，speak 静默 no-op', async () => {
    const bridge = createBrowserBridge();
    expect(bridge.capabilities.speech).toBe(false);
    // 无能力时绝不抛错（§4b.1：绝不可拖住提醒引擎）。
    await expect(bridge.speak('现在是9 点 5 分。')).resolves.toBeUndefined();
  });

  it('浏览器宿主：有 speechSynthesis 时按 zh-CN 发声，且先 cancel 上一句', async () => {
    const spoken: string[] = [];
    let cancelCount = 0;
    class FakeUtterance {
      lang = '';
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('window', {
      speechSynthesis: {
        cancel: () => {
          cancelCount += 1;
        },
        speak: (u: FakeUtterance) => {
          spoken.push(u.text);
        },
      },
    });

    const bridge = createBrowserBridge();
    expect(bridge.capabilities.speech).toBe(true);

    await bridge.speak('现在是9 点 5 分。到点了，现在做“写周报”。');
    expect(spoken).toEqual(['现在是9 点 5 分。到点了，现在做“写周报”。']);
    // 每次播报前 cancel：提醒是「此时这一件」，旧的那句该让位。
    expect(cancelCount).toBe(1);
  });

  it('浏览器宿主：空文本不产生任何发声调用', async () => {
    let calls = 0;
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    vi.stubGlobal('window', {
      speechSynthesis: {
        cancel: () => {},
        speak: () => {
          calls += 1;
        },
      },
    });

    await createBrowserBridge().speak('');
    expect(calls).toBe(0);
  });

  it('WebView 宿主：speak 经 speech.speak 桥方法发出，参数为 text', async () => {
    const posted: { id: string; method: string; params: Record<string, unknown> }[] = [];
    const host = {
      webkit: {
        messageHandlers: {
          mainline: {
            postMessage: (message: { id: string; method: string; params: Record<string, unknown> }) => {
              posted.push(message);
              // 同步回执，模拟原生：否则要干等 5s 超时（且会掩盖真实失败）。
              (host as unknown as { __mainlineReply?: (r: unknown) => void }).__mainlineReply?.({
                id: message.id,
                ok: true,
              });
            },
          },
        },
      },
      __mainlineReply: undefined as unknown,
    };
    vi.stubGlobal('window', host);

    const bridge = new WebViewBridge();
    expect(bridge.capabilities.speech).toBe(true);

    await bridge.speak('现在是11 点 12 分。“写代码”已经延误 2 分钟了，先把它收尾。');

    const call = posted.find((item) => item.method === 'speech.speak');
    expect(call).toBeDefined();
    expect(call!.params).toEqual({
      text: '现在是11 点 12 分。“写代码”已经延误 2 分钟了，先把它收尾。',
    });
  });

  it('WebView 宿主：空文本不发消息（省一次无意义的桥往返）', async () => {
    const posted: string[] = [];
    vi.stubGlobal('window', {
      webkit: {
        messageHandlers: {
          mainline: {
            postMessage: (message: { id: string; method: string }) => {
              posted.push(message.method);
              (window as unknown as { __mainlineReply?: (r: unknown) => void }).__mainlineReply?.({
                id: message.id,
                ok: true,
              });
            },
          },
        },
      },
    });

    await new WebViewBridge().speak('');
    expect(posted).toHaveLength(0);
  });
});

describe('platform — 跨设备设置里的播报开关（speechEnabled）', () => {
  it('浏览器宿主：无存量设置时默认开（新装用户不该先去设置里找开关）', async () => {
    const bridge = createBrowserBridge();
    await expect(bridge.readSettings()).resolves.toEqual({
      travelMode: 'driving',
      speechEnabled: true,
      overduePolicy: DEFAULT_OVERDUE_POLICY,
    });
  });

  it('浏览器宿主：写入 false 后读回仍是 false（关得住）', async () => {
    const bridge = createBrowserBridge();
    await bridge.writeSettings({
      travelMode: 'walking',
      speechEnabled: false,
      overduePolicy: DEFAULT_OVERDUE_POLICY,
    });
    const restored = await bridge.readSettings();
    expect(restored.speechEnabled).toBe(false);
    expect(restored.travelMode).toBe('walking');
  });

  it('浏览器宿主：旧数据缺 speechEnabled 键 → 按开处理（不能当成用户主动关闭）', async () => {
    // 直接往存储里塞一份「上个版本写下」的 JSON：没有 speechEnabled，
    // 这比走 writeSettings 更真 —— writeSettings 的入参是完整 SharedSettings，
    // 构造不出「缺键」的形态。
    const bridge = createBrowserBridge();
    const internals = bridge as unknown as {
      store: { set(key: string, value: unknown): Promise<void> };
    };
    await internals.store.set(
      'morning-mainline.settings.v1',
      JSON.stringify({ travelMode: 'transit' }),
    );

    const restored = await bridge.readSettings();
    // `!== false` 而非 `=== true`：缺键走 true。用 `=== true` 会让老用户静默变哑巴。
    expect(restored.speechEnabled).toBe(true);
    // 老版本存过的字段照常还原。
    expect(restored.travelMode).toBe('transit');
  });

  it('WebView 宿主：settings.write 把 speechEnabled 一并发出（原生才是权威存储）', async () => {
    const posted: { id: string; method: string; params: Record<string, unknown> }[] = [];
    const host = {
      webkit: {
        messageHandlers: {
          mainline: {
            postMessage: (message: { id: string; method: string; params: Record<string, unknown> }) => {
              posted.push(message);
              (host as unknown as { __mainlineReply?: (r: unknown) => void }).__mainlineReply?.({
                id: message.id,
                ok: true,
              });
            },
          },
        },
      },
      __mainlineReply: undefined as unknown,
    };
    vi.stubGlobal('window', host);

    await new WebViewBridge().writeSettings({
      travelMode: 'driving',
      speechEnabled: false,
      overduePolicy: DEFAULT_OVERDUE_POLICY,
    });

    const call = posted.find((item) => item.method === 'settings.write');
    expect(call).toBeDefined();
    expect(call!.params).toEqual({
      travelMode: 'driving',
      speechEnabled: false,
      overduePolicy: DEFAULT_OVERDUE_POLICY,
    });
  });

  it('WebView 宿主：settings.read 缺 speechEnabled 时兜成开（旧原生包不返回该字段）', async () => {
    const host = {
      webkit: {
        messageHandlers: {
          mainline: {
            postMessage: (message: { id: string }) => {
              // 模拟「旧原生包」：只回 travelMode，没有 speechEnabled。
              (host as unknown as { __mainlineReply?: (r: unknown) => void }).__mainlineReply?.({
                id: message.id,
                ok: true,
                result: { travelMode: 'driving' },
              });
            },
          },
        },
      },
      __mainlineReply: undefined as unknown,
    };
    vi.stubGlobal('window', host);

    const restored = await new WebViewBridge().readSettings();
    expect(restored.speechEnabled).toBe(true);
    // 旧原生包同样没有 overduePolicy → 必须回落默认（全程 2 分钟），而不是 undefined。
    // 若漏了兜底，`overdueRound` 会在 tick 里算 NaN 轮次 → 超时提醒**永远不触发**。
    expect(restored.overduePolicy).toEqual(DEFAULT_OVERDUE_POLICY);
  });

  it('WebView 宿主：settings.read 的 overduePolicy 脏值被夹回合法范围', async () => {
    const host = {
      webkit: {
        messageHandlers: {
          mainline: {
            postMessage: (message: { id: string }) => {
              // 模拟「原生侧存了越界/非法值」：负数、超上限、非数字、缺字段混合。
              (host as unknown as { __mainlineReply?: (r: unknown) => void }).__mainlineReply?.({
                id: message.id,
                ok: true,
                result: {
                  travelMode: 'driving',
                  speechEnabled: true,
                  overduePolicy: { earlyInterval: 0, switchAfter: 999, lateInterval: 'x' },
                },
              });
            },
          },
        },
      },
      __mainlineReply: undefined as unknown,
    };
    vi.stubGlobal('window', host);

    const restored = await new WebViewBridge().readSettings();
    expect(restored.overduePolicy).toEqual({
      earlyInterval: 1, // 0 夹到下限
      switchAfter: 60, // 999 夹到上限
      lateInterval: 2, // 非数字 → 默认
    });
  });
});
