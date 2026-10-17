import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PARSER_VERSION, decodePlan, validatePlan } from './parse-contract.mjs';

process.umask(0o077);
const filename = resolve(process.env.ACCOUNT_DB || './data/accounts.sqlite');
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(filename);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(owner_id TEXT PRIMARY KEY REFERENCES users(id), scope TEXT NOT NULL DEFAULT 'personal', revision INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences(owner_id TEXT PRIMARY KEY REFERENCES users(id), updated_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parse_cache(owner_id TEXT NOT NULL REFERENCES users(id), input_hash TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,input_hash,version));`);
const secure = process.env.COOKIE_SECURE === 'true';
const origins = new Set((process.env.ACCOUNT_ALLOWED_ORIGINS || 'http://localhost:5174,http://127.0.0.1:5174,https://47.104.95.146').split(','));
const digest = value => createHash('sha256').update(value).digest('hex');
const attempts = new Map();
const pendingParses = new Map();
async function parseForUser(userID, input) {
  const hash = digest(input);
  const row = db.prepare('SELECT data FROM parse_cache WHERE owner_id=? AND input_hash=? AND version=?').get(userID, hash, PARSER_VERSION);
  if (row) return { plan: validatePlan(JSON.parse(row.data)), cached: true };
  const jobKey = `${userID}:${hash}:${PARSER_VERSION}`;
  if (pendingParses.has(jobKey)) return pendingParses.get(jobKey);
  const job = (async () => {
    const response = await fetch('http://127.0.0.1:' + (process.env.MODEL_PROXY_PORT || 8787) + '/api/model/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_format: 'itinerary-ai-v1', response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: '你是任务拆解器。' }, { role: 'user', content: input },
      ] }), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('AI解析服务暂时不可用，请稍后重试');
    const data = await response.json();
    const plan = decodePlan(data.choices?.[0]?.message?.content);
    db.prepare('INSERT INTO parse_cache VALUES(?,?,?,?,?) ON CONFLICT(owner_id,input_hash,version) DO UPDATE SET data=excluded.data,created_at=excluded.created_at').run(userID, hash, PARSER_VERSION, JSON.stringify(plan), Date.now());
    db.prepare('DELETE FROM parse_cache WHERE owner_id=? AND rowid NOT IN (SELECT rowid FROM parse_cache WHERE owner_id=? ORDER BY created_at DESC LIMIT 200)').run(userID, userID);
    return { plan, cached: false };
  })();
  pendingParses.set(jobKey, job);
  try { return await job; } finally { pendingParses.delete(jobKey); }
}
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function cookie(res, value, age) { res.setHeader('Set-Cookie', `mm_session=${value}; HttpOnly; SameSite=Strict; Path=/api/account; Max-Age=${age}${secure ? '; Secure' : ''}`); }
function userFor(req) {
  const token = /(?:^|;\s*)mm_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT users.id, username FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(digest(token), Date.now());
}
async function bodyOf(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 2_000_000) throw new Error('请求内容过大'); }
  return JSON.parse(data || '{}');
}
function validSnapshot(snapshot) {
  return snapshot && Array.isArray(snapshot.templates) && snapshot.templates.length <= 1000
    && snapshot.templates.every(t => t && typeof t.id === 'string' && typeof t.name === 'string'
      && Array.isArray(t.steps) && t.steps.every(s => typeof s.id === 'string' && typeof s.title === 'string' && Number.isFinite(s.duration) && s.duration >= 0))
    && (snapshot.activeSession === null || (snapshot.activeSession && typeof snapshot.activeSession.id === 'string' && Array.isArray(snapshot.activeSession.progress)))
    && Number.isFinite(snapshot.updatedAt) && typeof snapshot.originID === 'string';
}
/**
 * 用户偏好（跨设备「用户习惯」）。只收**已知字段**，拒绝任何越界值。
 *
 * 存的是「用户自定义行为」三项：出行方式、语音播报、超时提醒间隔。
 * ⚠️ **不含高德 Key** —— 那是开发者配置（服务端 / 构建期 env 注入），
 * 不是用户数据，不该跟着账号在设备间漂。
 *
 * 校验刻意严格到「一个不对就整单拒绝」：偏好会直接驱动提醒节奏与播报行为，
 * 半截数据比没数据更难查（例如 `lateInterval: 0` 会让提醒每 0 分钟触发一次）。
 */
function validPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { travelMode, speechEnabled, overduePolicy } = value;
  if (travelMode !== undefined && !['driving', 'walking', 'transit'].includes(travelMode)) return false;
  if (speechEnabled !== undefined && typeof speechEnabled !== 'boolean') return false;
  if (overduePolicy !== undefined) {
    if (!overduePolicy || typeof overduePolicy !== 'object' || Array.isArray(overduePolicy)) return false;
    const inRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    // 区间与 web/src/core/reminders.ts 的 OVERDUE_INTERVAL_RANGE / OVERDUE_SWITCH_RANGE 一致。
    if (!inRange(overduePolicy.earlyInterval, 1, 10)) return false;
    if (!inRange(overduePolicy.switchAfter, 1, 60)) return false;
    if (!inRange(overduePolicy.lateInterval, 1, 10)) return false;
  }
  return true;
}
// ---- 高德地图代理（BFF）----
//
// 「后端代理」的核心动机：**高德 Key 不进任何客户端的可达范围**。
// 之前 Key 走 `VITE_` 构建期注入 → 被原样打进 `dist/assets/index-*.js`，
// 线上任何人 `curl` 一下产物就能拿到 Key 去盗刷配额（已实测复现）。
// 现在 Key 只存在服务端进程环境变量里，前端 / 原生 / 手表都只看到「同一个来源的代理地址」。
//
// ⚠️ 这个代理**不引入第二把客户端凭据**。理由：任何内嵌在 JS 产物里的 token
// 跟原 Key 一样会被 curl 走，等于白加一层；真正拦得住的是
// ①高德 Key 本体不外泄（攻击者无法绕开本服务直连高德）+
// ②path 精确白名单（本服务不能被当成「任意 URL 转发器」）+
// ③按 IP 限流（把「借用我们的配额」限制在免费额度内）。
// `AMAP_BASE_URL` 只为测试可注入（指向本地假高德，避免测试真的烧线上配额）。
const AMAP_BASE = process.env.AMAP_BASE_URL || 'https://restapi.amap.com/v3/';
/** 允许转发的高德接口。**精确字符串白名单**，不做前缀匹配 —— 这是防 SSRF 的关键。 */
const AMAP_PATHS = new Set([
  'assistant/coordinate/convert',
  'geocode/regeo',
  'place/around',
  'place/text',
  'direction/driving',
  'direction/walking',
  'direction/transit/integrated',
  'staticmap',
]);
/**
 * 允许透传给高德的参数名。**不在表内的一律丢弃**（含 `key`：客户端永远无权指定 Key）。
 * 用白名单而不是黑名单：高德以后新增「写」类接口参数时，默认是拒绝而不是放行。
 */
const AMAP_PARAMS = new Set([
  'location', 'locations', 'coordsys', 'keywords', 'city', 'cityd', 'citylimit', 'types',
  'radius', 'sortrule', 'offset', 'page', 'extensions', 'origin', 'destination',
  'strategy', 'nightflag', 'size', 'zoom', 'markers', 'paths', 'scale', 'traffic',
]);
/** 单 IP 额度：每分钟 60 次、每天 2000 次。家庭自用远超够，盗刷则被压到可忽略。 */
const AMAP_PER_MINUTE = 60;
const AMAP_PER_DAY = Number(process.env.AMAP_DAILY_LIMIT || 2000);
const commuteUsage = new Map();
function commuteQuota(ip) {
  const now = Date.now();
  const entry = commuteUsage.get(ip) ?? { minute: now, perMinute: 0, day: now, perDay: 0 };
  if (now - entry.minute >= 60_000) { entry.minute = now; entry.perMinute = 0; }
  if (now - entry.day >= 86_400_000) { entry.day = now; entry.perDay = 0; }
  entry.perMinute += 1;
  entry.perDay += 1;
  commuteUsage.set(ip, entry);
  // 防无界增长：条目多了才顺手清一遍过期窗口，避免每个请求都遍历。
  if (commuteUsage.size > 5000) {
    for (const [key, value] of commuteUsage) if (now - value.day >= 86_400_000) commuteUsage.delete(key);
  }
  return entry.perMinute <= AMAP_PER_MINUTE && entry.perDay <= AMAP_PER_DAY;
}
/**
 * 转发一次高德请求。`kind` 为 `rest`（JSON）或 `staticmap`（图片）。
 *
 * 🔴 响应体**原样透传**，但高德 Key 只出现在去程 query 里，回程不含它 ——
 * 所以这里不需要（也不应该）对 body 做文本替换：那会破坏 JSON 结构。
 */
async function handleCommute(req, res, kind) {
  if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' });
  // 带了 Origin 就必须在白名单内（浏览器 / 第三方网页）；原生 URLSession 与 curl 没有 Origin。
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) return send(res, 403, { error: '请求来源不允许' });
  const key = (process.env.AMAP_WEB_SERVICE_KEY || '').trim();
  if (!key) return send(res, 503, { error: '地图服务尚未配置' });
  if (!commuteQuota(req.socket.remoteAddress ?? 'unknown')) {
    return send(res, 429, { error: '地图服务请求过于频繁，请稍后重试' });
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const target = kind === 'staticmap' ? 'staticmap' : String(url.searchParams.get('path') ?? '');
  if (!AMAP_PATHS.has(target)) return send(res, 400, { error: '不支持的地图接口' });
  const upstream = new URL(target, AMAP_BASE);
  upstream.searchParams.set('key', key);
  // 只透传白名单参数；重复参数取最后一个（`set`），防止用重复项放大单次请求。
  for (const [name, value] of url.searchParams) if (AMAP_PARAMS.has(name)) upstream.searchParams.set(name, value);
  try {
    const response = await fetch(upstream, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'MorningMainline/1.0' },
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? (kind === 'staticmap' ? 'image/png' : 'application/json'),
      // 静态地图按坐标缓存 5 分钟（配额友好）；REST 结果一律不缓存（通勤时长会变）。
      'Cache-Control': kind === 'staticmap' ? 'private, max-age=300' : 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch (error) {
    console.error('Amap proxy failed:', error.name);
    return send(res, 502, { error: '地图服务暂时不可用，请稍后重试' });
  }
}
http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (path === '/api/commute/rest' || path === '/api/commute/staticmap') {
    return void handleCommute(req, res, path.endsWith('staticmap') ? 'staticmap' : 'rest');
  }
  if (!path?.startsWith('/api/account/')) return send(res, 404, { error: '接口不存在' });
  if (req.method !== 'GET' && (!origins.has(req.headers.origin) || !req.headers['content-type']?.startsWith('application/json'))) return send(res, 403, { error: '请求来源不允许' });
  try {
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    if (['/api/account/login', '/api/account/register'].includes(path) && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const now = Date.now();
      for (const [key, value] of attempts) if (now - value.start > 900_000) attempts.delete(key);
      const limit = attempts.get(ip) || { start: now, count: 0 };
      if (++limit.count > 20) return send(res, 429, { error: '尝试次数过多，请15分钟后重试' });
      attempts.set(ip, limit);
      const { username, password } = await bodyOf(req);
      if (typeof username !== 'string' || !/^[\p{L}\p{N}_-]{2,32}$/u.test(username) || typeof password !== 'string' || password.length < 8 || password.length > 128) return send(res, 400, { error: '用户名需2–32个字母、数字或汉字；密码需8–128位' });
      let user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (path.endsWith('/register')) {
        if (process.env.ALLOW_REGISTRATION === 'false') return send(res, 403, { error: '暂未开放注册' });
        if (user) return send(res, 409, { error: '用户名已被使用' });
        const id = randomUUID(), salt = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, username, salt, scryptSync(password, salt, 64).toString('hex'));
        user = { id, username };
      } else {
        const actual = scryptSync(password, user?.salt || 'missing-user', 64);
        if (!user || !timingSafeEqual(actual, Buffer.from(user.password, 'hex'))) return send(res, 401, { error: '用户名或密码不正确' });
      }
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, Date.now() + 30 * 86400000);
      cookie(res, token, 30 * 86400);
      return send(res, 200, { user: { id: user.id, username: user.username } });
    }
    const user = userFor(req);
    if (!user) return send(res, 401, { error: '请先登录' });
    if (path === '/api/account/parse' && req.method === 'POST') {
      const { input } = await bodyOf(req);
      if (typeof input !== 'string' || !input.trim() || input.length > 2000) return send(res, 400, { error: '请输入2000字以内的任务描述' });
      try { return send(res, 200, await parseForUser(user.id, input.trim().replace(/\r\n/g, '\n'))); }
      catch (error) { console.error('Task parsing failed:', error.name); return send(res, 502, { error: 'AI解析失败，请重试或补充描述；本次未生成任务' }); }
    }
    if (path === '/api/account/me' && req.method === 'GET') return send(res, 200, { user });
    if (path === '/api/account/logout' && req.method === 'POST') {
      const token = /(?:^|;\s*)mm_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
      cookie(res, '', 0); return send(res, 200, { ok: true });
    }
    if (path === '/api/account/snapshot' && req.method === 'GET') {
      const row = db.prepare('SELECT revision,data FROM snapshots WHERE owner_id=?').get(user.id);
      return send(res, 200, { revision: row?.revision || 0, snapshot: row ? JSON.parse(row.data) : null });
    }
    if (path === '/api/account/snapshot' && req.method === 'PUT') {
      const { revision, snapshot } = await bodyOf(req);
      if (!Number.isSafeInteger(revision) || revision < 0 || !validSnapshot(snapshot)) return send(res, 400, { error: '任务数据格式不正确' });
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT revision FROM snapshots WHERE owner_id=?').get(user.id);
        if ((row?.revision || 0) !== revision) { db.exec('ROLLBACK'); return send(res, 409, { error: '其他设备已更新数据，本机改动已保留，请处理同步冲突' }); }
        db.prepare("INSERT INTO snapshots(owner_id,scope,revision,data) VALUES(?,'personal',?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,data=excluded.data").run(user.id, revision + 1, JSON.stringify(snapshot));
        db.exec('COMMIT'); return send(res, 200, { revision: revision + 1 });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // ---- 用户偏好（跨设备「用户习惯」）----
    // 与 snapshot 的关键差别：**不做乐观锁**。偏好是「最后改的人说了算」，
    // 冲突代价只是某一项被覆盖，而 revision 冲突会逼用户做一次无意义的选择。
    // 所以 PUT 直接覆盖，updatedAt 由**服务端**打（用客户端时钟会在设备时区/时钟不准时乱序）。
    if (path === '/api/account/preferences' && req.method === 'GET') {
      const row = db.prepare('SELECT updated_at,data FROM preferences WHERE owner_id=?').get(user.id);
      return send(res, 200, { updatedAt: row?.updated_at || 0, preferences: row ? JSON.parse(row.data) : null });
    }
    if (path === '/api/account/preferences' && req.method === 'PUT') {
      const { preferences } = await bodyOf(req);
      if (!validPreferences(preferences)) return send(res, 400, { error: '提醒设置格式不正确' });
      const updatedAt = Date.now();
      db.prepare('INSERT INTO preferences(owner_id,updated_at,data) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data')
        .run(user.id, updatedAt, JSON.stringify(preferences));
      return send(res, 200, { updatedAt });
    }
    send(res, 404, { error: '接口不存在' });
  } catch (error) { console.error('Account request failed:', error.name); send(res, 400, { error: '请求处理失败，请重试' }); }
}).listen(Number(process.env.ACCOUNT_PORT || 8788), '127.0.0.1', () => console.log('Account service listening on localhost'));
