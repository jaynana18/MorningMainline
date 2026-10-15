/**
 * 「用户习惯」三项（出行方式 / 语音播报 / 超时提醒间隔）随账号云同步的守门测试。
 *
 * 为什么值得单测：这套逻辑最危险的一条是 **`amapKey` 永远不被云端覆盖** ——
 * 高德 Key 是开发者配置（构建期 env），服务端根本不存它；一旦哪天有人把
 * `pullPreferences` 写成整体替换，后果是「用户换一次账号，手机上的 Key 被清空、
 * 手表随即失去 Key」，而且**界面上没有任何地方能看出原因**（那个输入框已经删了）。
 * 属于典型的「静默失效」，必须用断言钉住。
 *
 * 环境说明：`withAccountSync` 在 `typeof window === 'undefined'` 时直接返回原桥
 * （给 SSR / 无宿主环境兜底），所以这里手工造一个最小 window + storage。
 * `accountRequest` 会走 `fetch`；相对 URL 在 Node 里解析不了，故直接 stub `fetch`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OVERDUE_POLICY } from '../src/core/reminders';
import { account, withAccountSync } from '../src/platform/account';
import { createMockBridge, type MockBridge } from '../src/platform/mock';

/** 服务端返回的偏好表（PUT 写入、GET 读出），模拟 LWW 存储。 */
let remote: { updatedAt: number; preferences: any } | null = null;
let putCalls: any[] = [];

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function installGlobals(): void {
  const storage = new Map<string, string>();
  const memoryStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  (globalThis as any).window = {
    addEventListener: () => {},
    location: { protocol: 'https:', hash: '' },
  };
  (globalThis as any).localStorage = memoryStorage;
  (globalThis as any).sessionStorage = memoryStorage;
}

beforeEach(() => {
  remote = null;
  putCalls = [];
  installGlobals();
  account.user = { id: 'user-1', username: '园游会na' };
  account.status = '';
  account.conflict = false;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/preferences') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      putCalls.push(body.preferences);
      remote = { updatedAt: Date.now(), preferences: body.preferences };
      return jsonResponse({ updatedAt: remote.updatedAt });
    }
    if (path.endsWith('/preferences')) {
      return jsonResponse(remote ?? { updatedAt: 0, preferences: null });
    }
    throw new Error(`未预期的请求：${path}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

function bridgeWithSettings(settings: Partial<Record<string, unknown>> = {}): MockBridge {
  const bridge = createMockBridge();
  // 模拟 App Group 里已有一份设置（含开发者注入的 Key）。
  void bridge.writeSettings({
    amapKey: 'developer-key',
    travelMode: 'driving',
    speechEnabled: true,
    overduePolicy: { ...DEFAULT_OVERDUE_POLICY },
    ...settings,
  } as any);
  bridge.writeSettingsCalls.length = 0;
  return bridge;
}

describe('withAccountSync — 偏好（用户习惯）随账号同步', () => {
  it('未登录时完全不碰偏好接口（本地 valeur 原样返回）', async () => {
    account.user = null;
    const bridge = withAccountSync(bridgeWithSettings({ travelMode: 'walking' }));
    await expect(bridge.readSettings()).resolves.toMatchObject({ travelMode: 'walking' });
    expect(putCalls).toHaveLength(0);
  });

  it('远端有偏好 → 三项以云端为准', async () => {
    remote = {
      updatedAt: 100,
      preferences: {
        travelMode: 'transit',
        speechEnabled: false,
        overduePolicy: { earlyInterval: 3, switchAfter: 20, lateInterval: 1 },
      },
    };
    const bridge = withAccountSync(bridgeWithSettings());
    const settings = await bridge.readSettings();
    expect(settings.travelMode).toBe('transit');
    expect(settings.speechEnabled).toBe(false);
    expect(settings.overduePolicy).toEqual({ earlyInterval: 3, switchAfter: 20, lateInterval: 1 });
  });

  it('🔴 云端偏好绝不覆盖本机的高德 Key（开发者配置不跟账号走）', async () => {
    remote = {
      updatedAt: 100,
      preferences: { travelMode: 'transit', speechEnabled: false, overduePolicy: { ...DEFAULT_OVERDUE_POLICY } },
    };
    const bridge = withAccountSync(bridgeWithSettings({ amapKey: 'developer-key' }));
    const settings = await bridge.readSettings();
    expect(settings.amapKey).toBe('developer-key');
  });

  it('远端为空（新账号首次登录）→ 不覆盖本机，并把本机现状推上去', async () => {
    const bridge = withAccountSync(bridgeWithSettings({ travelMode: 'walking', speechEnabled: false }));
    const settings = await bridge.readSettings();
    expect(settings.travelMode).toBe('walking');
    expect(settings.speechEnabled).toBe(false);
    // 推上去了，且**不含** amapKey。
    await vi.waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]).toMatchObject({ travelMode: 'walking', speechEnabled: false });
    expect(putCalls[0]).not.toHaveProperty('amapKey');
  });

  it('writeSettings：本机先落盘（手表拿 Key 的通道不能被网络拖慢），再推云端且不含 Key', async () => {
    const bridge = withAccountSync(bridgeWithSettings());
    await bridge.writeSettings({
      amapKey: 'developer-key',
      travelMode: 'walking',
      speechEnabled: true,
      overduePolicy: { ...DEFAULT_OVERDUE_POLICY },
    });
    // 本机写入是同步完成的。
    expect((bridge as unknown as MockBridge).writeSettingsCalls.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(putCalls).toHaveLength(1));
    expect(putCalls[0]).not.toHaveProperty('amapKey');
    expect(putCalls[0]).toMatchObject({ travelMode: 'walking' });
  });

  it('云端不可用 → 回落本机值，不抛错（改个开关不该因为网络抖动弹错）', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const bridge = withAccountSync(bridgeWithSettings({ travelMode: 'walking' }));
    await expect(bridge.readSettings()).resolves.toMatchObject({ travelMode: 'walking' });
  });
});
