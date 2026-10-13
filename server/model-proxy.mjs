import http from 'node:http';
import { itineraryPrompt, decodePlan } from './parse-contract.mjs';

// 仅监听本机，由 Nginx/Vite 提供同源入口。Key 不进入前端构建。
const key = process.env.COSMO_MIND_API_KEY?.trim();
if (!key) throw new Error('请在服务器设置 COSMO_MIND_API_KEY');
const endpoint = 'https://gpt.cosmoplat.com/v1/chat/completions';
const systemPrompt = `你是任务拆解器。把用户口述的日程拆成按顺序排列的任务列表，并以 JSON 返回。

规则：
- 只提取用户明确说出的任务。不要补充、不要推测、不要替用户安排他没提的任务。
- 任务名沿用用户的原始说法，不要改写、不要加书名号、不要补全动词。
- 时长统一换算成分钟。用户说“半小时”就是 30，“一小时”就是 60，“一个半”就是 90。
- 用户没给某个任务的时长时，填 5。
- 用户提到截止、结束、出门、到期时间时，把小时填进 deadlineHour、分钟填进 deadlineMinute（24 小时制）。
  只给了“8点”这种小时没给分钟的，分钟填 0。
- 没有提到任何截止时间时，deadlineHour 与 deadlineMinute 都填 null。

返回的 JSON 结构：
{"steps":[{"title":"任务名","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}`;
const allowedOrigins = new Set((process.env.MODEL_ALLOWED_ORIGINS ||
  'https://47.104.95.146,http://localhost:5174,http://127.0.0.1:5174').split(',').map(s => s.trim()));
const buckets = new Map();
let active = 0;
let hourStart = Date.now();
let hourlyRequests = 0;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  if (req.url !== '/api/model/chat/completions') return send(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
    return send(res, 403, { error: 'Origin not allowed' });
  }
  if (!req.headers['content-type']?.startsWith('application/json')) {
    return send(res, 415, { error: 'JSON required' });
  }
  const now = Date.now();
  for (const [ip, bucket] of buckets) if (now - bucket.start >= 60_000) buckets.delete(ip);
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const bucket = buckets.get(ip) || { start: now, count: 0 };
  if (now - hourStart >= 3_600_000) { hourStart = now; hourlyRequests = 0; }
  if (bucket.count >= 5 || hourlyRequests >= 60 || active >= 2) {
    return send(res, 429, { error: '请求过多，请稍后再试' });
  }
  bucket.count++;
  buckets.set(ip, bucket);
  active++;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > 16_384) return send(res, 413, { error: '输入过长' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length !== 2 ||
        messages[0]?.role !== 'system' || messages[1]?.role !== 'user' ||
        typeof messages[0].content !== 'string' || typeof messages[1].content !== 'string' ||
        !messages[0].content.startsWith('你是任务拆解器。') ||
        !messages[1].content.trim() || messages[1].content.length > 2000) {
      return send(res, 400, { error: 'Invalid task parsing request' });
    }
    hourlyRequests++;
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'cosmo-mind-coder',
        messages: [{ role: 'system', content: body.task_format === 'itinerary-ai-v1' ? itineraryPrompt : systemPrompt }, { role: 'user', content: messages[1].content }],
        temperature: 0,
        max_tokens: 4096,
        ...(body.response_format?.type === 'json_object'
          ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!upstream.ok) {
      console.error('Model upstream status:', upstream.status);
      return send(res, upstream.status, { error: '模型接口请求失败' });
    }
    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (body.task_format === 'itinerary-ai-v1') decodePlan(content);
    // 不向浏览器回传网关内部信息或思考链。
    send(res, 200, { choices: [{ message: { content } }] });
  } catch (error) {
    console.error('Model proxy failed:', error.name);
    send(res, 502, { error: 'AI解析暂时不可用，请重试或补充描述' });
  } finally {
    active--;
  }
}).listen(Number(process.env.MODEL_PROXY_PORT || 8787), '127.0.0.1', () => {
  console.log('MorningMainline model proxy ready');
});
