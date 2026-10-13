import type { CommuteInfo } from '../core/types';
import { nativeRequest } from './webview';
export type TravelMode = 'driving' | 'walking' | 'transit';
export type CommuteRoute = CommuteInfo;
export class OriginRequired extends Error {}
export function destinationMapURL(key: string, location: string): string {
  return `https://restapi.amap.com/v3/staticmap?${new URLSearchParams({ key: key.trim(), location, zoom: '15', size: '480*240', markers: `mid,0xe5484d,A:${location}` })}`;
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
let currentKey = import.meta.env.VITE_AMAP_WEB_SERVICE_KEY || '';
let cachedOrigin: { location: string; time: number } | null = null;

export function commuteMapURL(route: CommuteInfo): string {
  if (!currentKey) return '';
  const params = new URLSearchParams({
    key: currentKey, size: '480*240',
    markers: `mid,0x22a06b,起:${route.origin}|mid,0xe5484d,终:${route.location}`,
    ...(route.polyline ? { paths: `5,0x367bf5,1,,:${route.polyline}` } : {}),
  });
  return `https://restapi.amap.com/v3/staticmap?${params}`;
}

export function commuteNavigationURL(route: CommuteInfo): string {
  return `https://uri.amap.com/navigation?${new URLSearchParams({
    from: `${route.origin},出发地`, to: `${route.location},${route.address}`,
    mode: { driving: 'car', walking: 'walk', transit: 'bus' }[route.mode],
    src: '不跑偏', callnative: '1',
  })}`;
}

/** 用户主动点击查询后才申请定位并将起终点发送给高德。 */
export async function queryCommute(key: string, address: string, mode: TravelMode, selectedDestination?: CommuteDestination, originLocation?: string): Promise<CommuteRoute> {
  if (!key.trim()) throw new Error('请在通勤设置里填写高德 Web 服务 Key。');
  currentKey = key.trim();
  if (!address.trim()) throw new Error('请填写目的地。');
  const request = async (path: string, params: Record<string, string>) => {
    const response = await fetch(`https://restapi.amap.com/v3/${path}?${new URLSearchParams({ key: key.trim(), ...params })}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('路线服务暂时不可用，请稍后重试。');
    const body = await response.json();
    if (body.status !== '1') {
      const stage = path.startsWith('place/') ? '目的地搜索' : path.startsWith('direction/') ? '路线查询' : path === 'geocode/regeo' ? '当前位置解析' : '坐标转换';
      throw new Error(`高德${stage}失败：${body.info ?? '请检查 Key 和服务权限'}（${body.infocode ?? '未知错误码'}）`);
    }
    return body;
  };
  let origin = originLocation ?? '';
  if (!origin && cachedOrigin && Date.now() - cachedOrigin.time < 60000) origin = cachedOrigin.location;
  if (!origin) {
    try {
    const isNative = !!window.webkit?.messageHandlers?.mainline;
    if (!isNative && (!window.isSecureContext || !navigator.geolocation)) throw new OriginRequired('无法自动定位，请按名称选择出发地。');
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
