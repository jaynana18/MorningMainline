import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 用户偏好（跨设备「用户习惯」）接口测试。
 *
 * 覆盖四条最容易出事的性质：
 * ① **按账号隔离** —— 串号会让 A 的提醒节奏跑到 B 头上，且极难察觉；
 * ② **未登录拒绝** —— 偏好是用户数据，不能匿名读写；
 * ③ **拒绝越界值** —— 偏好直接驱动提醒频率，`lateInterval: 0` 会让提醒每 0 分钟响一次；
 * ④ **被拒的写入不能污染已有数据** —— 否则一次笔误就把用户的设置打坏。
 */
test('用户偏好：按账号隔离、拒绝越界、LWW 覆盖', async () => {
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'mm-prefs-'));
  const child = spawn(process.execPath, [new URL('./account-server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      ACCOUNT_PORT: String(port),
      ACCOUNT_DB: join(dir, 'accounts.sqlite'),
      MODEL_PROXY_PORT: '9',
    },
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('账号服务启动失败')));
    });
    const request = async (path, { method = 'GET', body, cookie = '' } = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/account${path}`, {
        method,
        headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json', Cookie: cookie },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };

    // ② 未登录拒绝。
    assert.equal((await request('/preferences')).status, 401);
    assert.equal((await request('/preferences', { method: 'PUT', body: { preferences: {} } })).status, 401);

    const register = async username => {
      const response = await fetch(`http://127.0.0.1:${port}/api/account/register`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'test-only-password' }),
      });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const userA = await register('prefsA');
    const userB = await register('prefsB');
    assert.equal(userA.status, 200);
    assert.equal(userB.status, 200);

    // ③ 首次读取：没有存量偏好。
    const empty = await request('/preferences', { cookie: userA.cookie });
    assert.equal(empty.status, 200);
    assert.equal(empty.data.updatedAt, 0);
    assert.equal(empty.data.preferences, null);

    // 正常写入 + 读回。
    const policy = { earlyInterval: 2, switchAfter: 10, lateInterval: 1 };
    const first = await request('/preferences', {
      method: 'PUT', cookie: userA.cookie,
      body: { preferences: { travelMode: 'walking', speechEnabled: false, overduePolicy: policy } },
    });
    assert.equal(first.status, 200);
    assert(Number.isInteger(first.data.updatedAt) && first.data.updatedAt > 0);

    const readBack = await request('/preferences', { cookie: userA.cookie });
    assert.deepEqual(readBack.data.preferences, {
      travelMode: 'walking', speechEnabled: false, overduePolicy: policy,
    });
    assert.equal(readBack.data.updatedAt, first.data.updatedAt);

    // ③ 越界值一律拒绝，且**不污染**已存数据。
    const badBodies = [
      { overduePolicy: { earlyInterval: 0, switchAfter: 10, lateInterval: 1 } }, // 间隔下限 1
      { overduePolicy: { earlyInterval: 2, switchAfter: 10, lateInterval: 11 } }, // 间隔上限 10
      { overduePolicy: { earlyInterval: 2, switchAfter: 61, lateInterval: 1 } }, // 切换点上限 60
      { overduePolicy: { earlyInterval: 2.5, switchAfter: 10, lateInterval: 1 } }, // 必须整数
      { travelMode: 'flying' },
      { speechEnabled: 'yes' },
      { overduePolicy: null },
      'not-an-object',
    ];
    for (const bad of badBodies) {
      const response = await request('/preferences', {
        method: 'PUT', cookie: userA.cookie, body: { preferences: bad },
      });
      assert.equal(response.status, 400, `应拒绝：${JSON.stringify(bad)}`);
    }
    const afterBad = await request('/preferences', { cookie: userA.cookie });
    assert.deepEqual(afterBad.data.preferences, readBack.data.preferences, '被拒的写入不得改动已有偏好');

    // ① 账号隔离：B 看不到 A 的，B 写自己的也不影响 A。
    const bEmpty = await request('/preferences', { cookie: userB.cookie });
    assert.equal(bEmpty.data.preferences, null);
    const bWrite = await request('/preferences', {
      method: 'PUT', cookie: userB.cookie,
      body: { preferences: { travelMode: 'transit', speechEnabled: true, overduePolicy: { earlyInterval: 5, switchAfter: 20, lateInterval: 3 } } },
    });
    assert.equal(bWrite.status, 200);
    assert.equal((await request('/preferences', { cookie: userB.cookie })).data.preferences.travelMode, 'transit');
    assert.equal((await request('/preferences', { cookie: userA.cookie })).data.preferences.travelMode, 'walking');

    // ④ LWW：后写覆盖先写，updatedAt 单调前进（客户端据此判断要不要采纳）。
    const second = await request('/preferences', {
      method: 'PUT', cookie: userA.cookie,
      body: { preferences: { travelMode: 'driving', speechEnabled: true, overduePolicy: policy } },
    });
    assert.equal(second.status, 200);
    assert(second.data.updatedAt >= first.data.updatedAt);
    assert.equal((await request('/preferences', { cookie: userA.cookie })).data.preferences.travelMode, 'driving');
  } finally {
    child.kill();
  }
});
