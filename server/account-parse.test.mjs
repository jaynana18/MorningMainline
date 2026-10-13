import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('AI缓存按账号隔离、去重，不缓存失败或非法结果', async () => {
  let calls = 0;
  const plan = { preparation: [{ title: '刷牙', durationMinutes: 3 }], stops: [{ destination: '凯德', activities: [{ title: '逛', durationMinutes: 80 }] }], deadlineHour: 18, deadlineMinute: 0 };
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls++;
    const body = JSON.parse(raw);
    assert.equal(body.task_format, 'itinerary-ai-v1');
    const result = body.messages[1].content === 'bad' ? { ...plan, deadlineHour: 88 } : plan;
    setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] })); }, 40);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'mm-ai-cache-'));
  const child = spawn(process.execPath, [new URL('./account-server.mjs', import.meta.url).pathname], { env: {
    ...process.env, ACCOUNT_PORT: String(port), ACCOUNT_DB: join(dir, 'accounts.sqlite'), MODEL_PROXY_PORT: String(model.address().port),
  } });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('账号服务启动失败'))); });
    const request = async (path, body, cookie = '') => {
      const response = await fetch(`http://127.0.0.1:${port}/api/account${path}`, { method: 'POST', headers: { Origin: 'http://localhost:5174', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    assert.equal((await request('/parse', { input: '计划' })).status, 401);
    const a = await request('/register', { username: 'cacheA', password: 'test-only-password' });
    const b = await request('/register', { username: 'cacheB', password: 'test-only-password' });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const first = await request('/parse', { input: '凯德逛1小时20分钟' }, a.cookie);
    assert.equal(first.data.cached, false);
    assert.equal(first.data.plan.stops[0].activities[0].durationMinutes, 80);
    assert.equal((await request('/parse', { input: '凯德逛1小时20分钟' }, a.cookie)).data.cached, true);
    assert.equal(calls, 1);
    assert.equal((await request('/parse', { input: '凯德逛1小时20分钟' }, b.cookie)).data.cached, false);
    assert.equal(calls, 2);
    const parallel = await Promise.all([request('/parse', { input: '新计划' }, a.cookie), request('/parse', { input: '新计划' }, a.cookie)]);
    assert(parallel.every(result => result.status === 200)); assert.equal(calls, 3);
    assert.equal((await request('/parse', { input: 'bad' }, a.cookie)).status, 502);
    assert.equal((await request('/parse', { input: 'bad' }, a.cookie)).status, 502);
    assert.equal(calls, 5);
  } finally {
    child.kill(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
});
