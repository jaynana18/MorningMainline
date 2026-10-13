import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

process.umask(0o077);
const filename = resolve(process.env.ACCOUNT_DB || './data/accounts.sqlite');
mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(filename);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(owner_id TEXT PRIMARY KEY REFERENCES users(id), scope TEXT NOT NULL DEFAULT 'personal', revision INTEGER NOT NULL, data TEXT NOT NULL);`);
const secure = process.env.COOKIE_SECURE === 'true';
const origins = new Set((process.env.ACCOUNT_ALLOWED_ORIGINS || 'http://localhost:5174,http://127.0.0.1:5174,https://47.104.95.146').split(','));
const digest = value => createHash('sha256').update(value).digest('hex');
const attempts = new Map();
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
http.createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
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
    send(res, 404, { error: '接口不存在' });
  } catch (error) { console.error('Account request failed:', error.name); send(res, 400, { error: '请求处理失败，请重试' }); }
}).listen(Number(process.env.ACCOUNT_PORT || 8788), '127.0.0.1', () => console.log('Account service listening on localhost'));
