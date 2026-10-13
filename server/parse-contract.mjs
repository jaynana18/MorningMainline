export const PARSER_VERSION = 'itinerary-ai-v1:cosmo-mind-coder';
export const itineraryPrompt = `你是任务拆解器。把原句拆成准备任务和按顺序访问的地点，只返回 JSON。
不要添加用户没说的任务或地点，任务名沿用原话。只把真实出行地点放入 stops，去厕所等家内动作放入普通任务。
每个地点的 activities 只包含到达这个地点后、去下一个地点前的活动。准备任务放入 preparation。
所有 durationMinutes 都换成分钟：1小时20分钟=80，一小时二十分钟=80，一个半小时=90，半小时=30。小时和分钟必须相加，不能漏掉尾部分钟。
用户没有给某项活动时长时填5；不要估算交通耗时，不要生成通勤任务，路线服务负责计算。
模糊地点或指代词保留原词，交给用户从地图候选中选择。不要编造地址、坐标。
截止时刻使用24小时制，仅存小时和分钟，不输出日期。没有截止时刻时两者都为null；只说18点结束则填18和0。
格式：{"preparation":[{"title":"刷牙","durationMinutes":3}],"stops":[{"destination":"凯德","activities":[{"title":"逛","durationMinutes":80}]},{"destination":"宜家","activities":[{"title":"待","durationMinutes":60}]}],"deadlineHour":18,"deadlineMinute":0}`;

export function validatePlan(value) {
  const error = () => { throw new Error('AI返回的任务结构不完整，请重试或补充描述'); };
  if (!value || !Array.isArray(value.preparation) || !Array.isArray(value.stops) || value.stops.length > 20) error();
  let count = 0;
  const tasks = items => {
    if (!Array.isArray(items)) error();
    return items.map(item => {
      if (++count > 100 || !item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200
        || typeof item.durationMinutes !== 'number' || !Number.isFinite(item.durationMinutes) || item.durationMinutes <= 0 || item.durationMinutes > 10080) error();
      return { title: item.title.trim(), durationMinutes: item.durationMinutes };
    });
  };
  const preparation = tasks(value.preparation);
  const stops = value.stops.map(stop => {
    if (!stop || typeof stop.destination !== 'string' || !stop.destination.trim() || stop.destination.length > 200) error();
    return { destination: stop.destination.trim(), activities: tasks(stop.activities) };
  });
  const { deadlineHour: hour, deadlineMinute: minute } = value;
  if (!((hour === null && minute === null) || (Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59))) error();
  if (!preparation.length && !stops.length) error();
  return { preparation, stops, deadlineHour: hour, deadlineMinute: minute };
}

export function decodePlan(content) {
  if (typeof content !== 'string') throw new Error('AI未返回任务，请重试');
  // 仅移除 JSON 代码块包装，不用正则提取任务、地点或时长。
  return validatePlan(JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
}
