import { replacingChineseDurationNumerals } from './parser';

export interface ItineraryStop { query: string; activities: string }

/** 保留地点后的活动片段，停留时长不能跨到下一个地点。模糊地点也交给选点确认。 */
export function splitItinerary(input: string): { preparation: string; stops: ItineraryStop[] } {
  const text = replacingChineseDurationNumerals(input)
    .replace(/半(?:个)?小时/g, '30分钟');
  const marker = /(?:到达|前往|赶往|去往|去|到(?!\s*\d)|在)/g;
  const matches = [...text.matchAll(marker)].filter(match => {
    if (match[0] === '在' && /[现正]$/.test(text.slice(0, match.index))) return false;
    const rest = text.slice(match.index! + match[0].length);
    return !/^(?:时候|时|现在|几点|最后|期|手|做|完成|结束)/.test(rest.trim());
  });
  const stops: ItineraryStop[] = [];
  let first = -1;
  matches.forEach((match, index) => {
    const end = matches[index + 1]?.index ?? text.length;
    const fragment = text.slice(match.index! + match[0].length, end).trim();
    const boundary = fragment.search(/[,，。；;\n]|然后|接着|之后|再去|再到|停留|待(?:上|够)?|呆|逛|购物|买|吃|喝|玩|办事|取|接人|工作|开会|\s*\d+(?:\.\d+)?\s*(?:分钟|小时|点|[:：])/);
    const query = (boundary < 0 ? fragment : fragment.slice(0, boundary)).trim();
    if (!query) return;
    if (first < 0) first = match.index!;
    const activities = boundary < 0 ? '' : fragment.slice(boundary)
      .replace(/(?:然后|接着|之后|再|最后|先)\s*$/, '').replace(/^[,，。；;\s]+|[,，。；;\s]+$/g, '');
    stops.push({ query, activities: /^\d+(?:\.\d+)?\s*(?:分钟|小时)/.test(activities) ? `停留${activities}` : activities });
  });
  return { preparation: first < 0 ? text : text.slice(0, first), stops };
}
