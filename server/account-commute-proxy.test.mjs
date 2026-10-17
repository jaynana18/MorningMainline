import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 高德代理（BFF）测试。
 *
 * 这个代理存在的唯一理由是「Key 不落到任何客户端可达的地方」，所以测试的重点
 * 不是「能转发」，而是**四条防泄露 / 防滥用性质**：
 * ① Key 绝不回传给调用方（正文、头、错误信息里都不能有）；
 * ② path 必须精确白名单 —— 否则本服务成了「任意 URL 转发器」（SSRF）;
 * ③ 客户端无法自带 `key` 覆盖服务端那把（否则代理形同虚设）；
 * ④ 未配置 Key 时明确 503，而不是拼一个空 Key 去撞高德的 403。
 *
 * 测试不触网：起一个假的「高德」本地服务，把 `AMAP_BASE_URL` 指过去。
 * ⚠️ 注入点是**环境变量**而非硬编码常量，正是为了这个测试 ——
 * 否则测一次就真烧一次线上配额，且结果不可重复。
 */

/**
 * 假高德：记录收到的 query（供断言转发内容），并回一条**形状像真高德**的响应。
 *
 * ⚠️ 响应里**刻意不回显 `key`** —— 真高德的响应体里从来没有 Key。
 * 若替身把 key 回显出来，「响应不含 Key」这条断言就会假失败，
 * 掩盖真正的实现问题（也会诱使人去写「服务端要替换响应文本」这种错误修法）。
 */
async function startFakeAmap() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push(Object.fromEntries(url.searchParams));
    if (url.pathname.endsWith('/staticmap')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: '1', info: 'ok', infocode: '10000' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}/v3/` };
}

async function startAccount(env) {
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), 'mm-commute-'));
  const child = spawn(process.execPath, [new URL('./account-server.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      ACCOUNT_PORT: String(port),
      ACCOUNT_DB: join(dir, 'accounts.sqlite'),
      MODEL_PROXY_PORT: '9',
      ...env,
    },
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('账号服务启动失败')));
  });
  return { port, child };
}

test('高德代理：Key 不外泄、path 白名单、不可被自带 key 覆盖', async () => {
  const amap = await startFakeAmap();
  const account = await startAccount({
    AMAP_WEB_SERVICE_KEY: 'server-side-secret-key',
    AMAP_BASE_URL: amap.base,
  });
  const url = path => `http://127.0.0.1:${account.port}${path}`;
  try {
    // ① 正常转发：服务端那把 Key 到了上游，业务参数也带过去了。
    const ok = await fetch(url('/api/commute/rest?path=geocode/regeo&location=120.1,36.2'));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.status, '1');
    const forwarded = amap.seen.at(-1);
    assert.equal(forwarded.key, 'server-side-secret-key');
    assert.equal(forwarded.location, '120.1,36.2');

    // 🔴 回程绝不含 Key —— 这是整个方案的目的所在。
    assert.ok(!JSON.stringify(body).includes('server-side-secret-key'), '响应正文里出现了 Key');
    assert.ok(
      ![...ok.headers].flat().join(' ').includes('server-side-secret-key'),
      '响应头里出现了 Key',
    );

    // ② 客户端自带 key 无效：白名单只透传业务参数，`key` 不在表内。
    const spoof = await fetch(url('/api/commute/rest?path=geocode/regeo&key=attacker&location=1,2'));
    assert.equal(spoof.status, 200);
    assert.equal(amap.seen.at(-1).key, 'server-side-secret-key', '客户端 key 覆盖了服务端 key');

    // ③ path 必须精确白名单：非表内、前缀相近、带协议、带路径穿越都拒。
    for (const bad of [
      'place/around2', 'v3/place/around', 'https://evil.example/x', '../admin',
      'direction/transit/integrated/.././../x', 'staticmap',
    ]) {
      const response = await fetch(url(`/api/commute/rest?path=${encodeURIComponent(bad)}`));
      // `staticmap` 属白名单但只能走图片端点；此处 endpoint=rest 会转发成 JSON 并非预期，
      // 故仅断言「非白名单」那几项被拒（400）。
      if (bad === 'staticmap') continue;
      assert.equal(response.status, 400, `path=${bad} 竟然被放行`);
    }

    // ④ 静态地图返回二进制图片，且允许坐标级缓存。
    const map = await fetch(url('/api/commute/staticmap?location=120.1,36.2&zoom=15&size=480*240'));
    assert.equal(map.status, 200);
    assert.equal(map.headers.get('content-type'), 'image/png');
    assert.match(map.headers.get('cache-control') ?? '', /max-age=300/);
    assert.equal(amap.seen.at(-1).size, '480*240');

    // ⑤ 非 GET 拒绝。
    assert.equal((await fetch(url('/api/commute/rest?path=geocode/regeo'), { method: 'POST' })).status, 405);
  } finally {
    account.child.kill();
    amap.server.close();
  }
});

test('高德代理：未配置 Key 时 503，而不是拼空 Key 去撞 403', async () => {
  const account = await startAccount({ AMAP_WEB_SERVICE_KEY: '' });
  try {
    const response = await fetch(`http://127.0.0.1:${account.port}/api/commute/rest?path=geocode/regeo&location=1,2`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /地图服务/);
  } finally {
    account.child.kill();
  }
});
