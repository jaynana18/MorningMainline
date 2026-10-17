import type { CommuteInfo } from '../core/types';
import { nativeRequest } from './webview';
export type TravelMode = 'driving' | 'walking' | 'transit';
export type CommuteRoute = CommuteInfo;
export class OriginRequired extends Error {}

/**
 * 高德请求的唯一出口：**服务端代理**。
 *
 * 🔴 为什么必须是代理而不是「构建期注入 Key」：`VITE_` 前缀的值会被原样打进
 * `dist/assets/index-*.js`，线上任何人 `curl` 一下产物就能拿到 Key 去盗刷配额
 * （本项目已实测复现，见 `server/account-server.mjs` 的代理段注释）。
 * 现在 Key 只存在服务端进程环境变量里，浏览器 / 原生 / 手表都只访问同源的代理地址。
 *
 * 两条宿主通道共用同一个 URL 语义（`/api/commute/rest?path=...`）：
 * - **WebView 宿主**：页面是 `file://`，同源 fetch 无处可去（`file://` 下 `/api/...`
 *   会解析到文件系统根）→ 必须交原生代发，走 `commute.rest` 桥方法。
 * - **浏览器宿主**：直接同源 `fetch`，由 Vite dev proxy / Nginx 转发到账号服务。
 *
 * 两条路径的**降级行为一致**：不可用时抛出带用户可读文案的 `Error`，
 * 由调用方决定是提示还是跳过（不假装算出了结果）。
 */
async function amapRest(path: string, params: Record<string, string>): Promise<Record<string, any>> {
  const query = new URLSearchParams({ path, ...params });
  let body: any;
  if (isNativeHost()) {
    // 原生代发：不经 JS 的 fetch，绕开 `file://` 的同源限制。
    body = await nativeRequest('commute.rest', { query: query.toString() }, 20000) as Record<string, any>;
  } else {
    const response = await fetch(`${commuteBaseURL()}/rest?${query}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      // 429/503 是代理自己的话术（限流 / 未配置 Key），比「路线服务不可用」更准确。
      const detail = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(detail?.error ?? '路线服务暂时不可用，请稍后重试。');
    }
    body = await response.json();
  }
  if (body?.status !== '1') {
    const stage = path.startsWith('place/') ? '目的地搜索' : path.startsWith('direction/') ? '路线查询' : path === 'geocode/regeo' ? '当前位置解析' : '坐标转换';
    throw new Error(`高德${stage}失败：${body?.info ?? '请稍后重试'}（${body?.infocode ?? '未知错误码'}）`);
  }
  return body;
}

/** 代理根地址（不含端点）。浏览器宿主下与页面同源，由 dev proxy / Nginx 转发。 */
function commuteBaseURL(): string {
  return import.meta.env.VITE_COMMUTE_API_URL || '/api/commute';
}

/**
 * 静态地图的代理 URL。
 *
 * ⚠️ 静态地图只能交给 `<img src>`，没法走桥（`<img>` 不认 Promise），所以这里
 * **不能**像 `amapRest` 那样在 WebView 宿主下借原生代发。而打包版页面是 `file://`，
 * 相对路径 `/api/commute/...` 会解析到文件系统根 → 图片必然加载失败。
 * 因此在 WebView 宿主下直接拼**固定 HTTPS 域名**（与 `WebHost.swift` 里
 * `account.request` / `commute.rest` 用的是同一个，不是秘密）。
 *
 * 这条请求**不需要任何凭据**：Key 在服务端，静态地图代理端点对任何人都只回一张图。
 */
const COMMUTE_ORIGIN = 'https://47.104.95.146/api/commute';

function isNativeHost(): boolean {
  return typeof window !== 'undefined' && !!window.webkit?.messageHandlers?.mainline;
}

function staticMapURL(params: URLSearchParams): string {
  // 浏览器宿主：同源相对路径（Vite dev proxy / Nginx 反代成品都能用）。
  return isNativeHost() ? `${COMMUTE_ORIGIN}/staticmap?${params}` : `/api/commute/staticmap?${params}`;
}

/** 静态地图统一尺寸。两处调用方（目的地预览 / 路线缩略图）保持一致，避免代理端出现多种缓存键。 */
const MAP_SIZE = '480*240';

export function destinationMapURL(location: string): string {
  // 坐标为空的调用方不该拼一个必然失败的 URL —— 直接返回空串让 `MapPreview` 不渲染图片。
  if (!location.trim()) return '';
  return staticMapURL(new URLSearchParams({
    location, zoom: '15', size: MAP_SIZE, markers: `mid,0xe5484d,A:${location}`,
  }));
}
export interface CommuteDestination {
  id: string;
  name: string;
  address: string;
  location: string;
  citycode: string;
  distanceMeters?: number;
}
export class DestinationSelectionRequired extends Error {
  constructor(public readonly candidates: CommuteDestination[], message = '请选择具体目的地后查询通勤。') {
    super(message);
  }
}
/**
 * 构建路线缩略图的代理 URL。
 *
 * 路线数据（起终点 + 折线）本来就是用户自己的行程，但**拼 URL 这件事不再需要 Key**
 * ——这也是方案 B 顺带的好处：静态地图 URL 从此可以安全地出现在任何地方。
 */
export function commuteMapURL(route: CommuteInfo): string {
  const params = new URLSearchParams({
    size: MAP_SIZE,
    markers: `mid,0x22a06b,起:${route.origin}|mid,0xe5484d,终:${route.location}`,
    ...(route.polyline ? { paths: `5,0x367bf5,1,,:${route.polyline}` } : {}),
  });
  return staticMapURL(params);
}

export function commuteNavigationURL(route: CommuteInfo): string {
  return `https://uri.amap.com/navigation?${new URLSearchParams({
    from: `${route.origin},出发地`, to: `${route.location},${route.address}`,
    mode: { driving: 'car', walking: 'walk', transit: 'bus' }[route.mode],
    src: '不跑偏', callnative: '1',
  })}`;
}

/** 出发地 60 秒缓存。定位是昂贵操作，同一分钟内多次算路复用同一次结果。 */
let cachedOrigin: { location: string; time: number } | null = null;

/** 用户主动点击查询后才申请定位并将起终点交给服务端代理转发给高德。 */
export async function queryCommute(address: string, mode: TravelMode, selectedDestination?: CommuteDestination, originLocation?: string): Promise<CommuteRoute> {
  if (!address.trim()) throw new Error('请填写目的地。');
  const request = amapRest;
  let origin = originLocation ?? '';
  if (!origin && cachedOrigin && Date.now() - cachedOrigin.time < 60000) origin = cachedOrigin.location;
  if (!origin) {
    try {
    const isNative = isNativeHost();
    if (!isNative && (typeof window === 'undefined' || !window.isSecureContext || !navigator.geolocation)) throw new OriginRequired('无法自动定位，请按名称选择出发地。');
    const coords = isNative ? await nativeRequest('location.current') as { longitude: number; latitude: number } : (await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, () => reject(new OriginRequired('没有获取到当前位置，请按名称选择出发地。')), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    })).coords;
    const gps = `${coords.longitude.toFixed(6)},${coords.latitude.toFixed(6)}`;
    const converted = await request('assistant/coordinate/convert', { locations: gps, coordsys: 'gps' });
    origin = converted.locations as string;
    cachedOrigin = { location: origin, time: Date.now() };
    } catch (error) {
      // 搜地点可在定位失败后继续；真正算路程仍必须有出发地。
      if (selectedDestination) throw error instanceof OriginRequired ? error : new OriginRequired('无法获取当前位置，请按名称选择出发地。');
    }
  }
  const start = origin ? await request('geocode/regeo', { location: origin }).catch(() => null) : null;
  const city = String(start?.regeocode?.addressComponent?.citycode ?? '');
  if (!selectedDestination) {
    // 地标、商场简称走 POI 搜索，不当作结构化门牌地址；不擅自选择首个结果。
    let result = origin ? await request('place/around', {
      keywords: address.trim(), location: origin, radius: '10000', sortrule: 'distance', offset: '20', page: '1', extensions: 'base',
    }) : null;
    if (!result?.pois?.length) result = await request('place/text', { keywords: address.trim(), city, offset: '20', page: '1', extensions: 'base' });
    const nearbyFallback = !result.pois?.length;
    if (nearbyFallback && origin) {
      result = await request('place/around', { location: origin, radius: '3000', sortrule: 'distance', offset: '20', page: '1', extensions: 'base' });
    }
    const candidates: CommuteDestination[] = (result.pois ?? [])
      .filter((poi: { location?: unknown }) => typeof poi.location === 'string' && /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(poi.location))
      .map((poi: Record<string, unknown>) => ({
        id: String(poi.id), name: String(poi.name), location: String(poi.location),
        address: [poi.pname, poi.cityname, poi.adname, typeof poi.address === 'string' ? poi.address : ''].filter(value => typeof value === 'string' && value).join(''),
        citycode: typeof poi.citycode === 'string' ? poi.citycode : city,
      }));
    if (origin) {
      const [lon, lat] = origin.split(',').map(Number);
      const rad = Math.PI / 180;
      for (const candidate of candidates) {
        const [toLon, toLat] = candidate.location.split(',').map(Number);
        const a = Math.sin((toLat - lat) * rad / 2) ** 2
          + Math.cos(lat * rad) * Math.cos(toLat * rad) * Math.sin((toLon - lon) * rad / 2) ** 2;
        candidate.distanceMeters = Math.round(6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))));
      }
      candidates.sort((a, b) => a.distanceMeters! - b.distanceMeters!);
    }
    if (!candidates.length) throw new Error('没有找到可选择的地点。请返回修改原句，补充城市或门店名称后再生成。');
    throw new DestinationSelectionRequired(candidates, nearbyFallback && origin
      ? `没有找到「${address.trim()}」的准确匹配，以下是出发地附近的地点，请确认是否有你要去的位置；没有的话请返回修改原句。`
      : origin ? '已按距出发地的远近排序，请选择具体地点（距离为直线距离）。'
        : '未获取到当前位置，已按名称搜索。请选择具体地点。');
  }
  const destination = selectedDestination;
  const route = await request(mode === 'transit' ? 'direction/transit/integrated' : `direction/${mode}`, {
    origin, destination: destination.location,
    ...(mode === 'transit' ? { city, cityd: String(destination.citycode ?? city) } : {}),
  });
  const paths = mode === 'transit' ? route.route?.transits : route.route?.paths;
  const available = (paths ?? []).filter((path: { duration: string }) => Number.isFinite(Number(path.duration)) && Number(path.duration) > 0);
  available.sort((a: { duration: string }, b: { duration: string }) => Number(a.duration) - Number(b.duration));
  if (!available.length) throw new Error('没有找到可用路线，请检查目的地或切换交通方式。');
  const selected = available[0];
  // 公交方案包含步行、公交和铁路段；只画服务返回的真实折线，不用直线冒充路线。
  const lines: string[] = [];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (name === 'polyline' && typeof child === 'string') lines.push(child);
      else if (name === 'buslines' && Array.isArray(child)) collect(child[0]);
      else if (typeof child === 'object') collect(child);
    }
  };
  collect(mode === 'transit' ? selected.segments : selected.steps);
  const points = lines.flatMap((line) => line.split(';')).filter((point) => /^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(point));
  // 缩略图抽样，控制静态地图请求 URL 长度，保留路线首尾。
  const sampled = points.filter((_, index) => index % Math.max(1, Math.ceil(points.length / 60)) === 0 || index === points.length - 1);
  return { address: destination.name, location: destination.location, origin, mode,
    seconds: Math.ceil(Number(selected.duration) / 60) * 60, polyline: sampled.join(';') };
}
