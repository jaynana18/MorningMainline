import { createStep, type RoutineStep } from './types';

export interface AIPlan {
  preparation: RoutineStep[];
  stops: { query: string; steps: RoutineStep[] }[];
  deadline: Date | null;
  cached: boolean;
}

/** 只校验服务结果并换算单位；不从原句提取任务、地点或时长。 */
export function readAIPlan(raw: unknown, now = new Date()): AIPlan {
  const invalid = (): never => { throw new Error('AI返回的任务不完整，请重试或补充描述。'); };
  if (!raw || typeof raw !== 'object') return invalid();
  const response = raw as Record<string, unknown>;
  if (!response.plan || typeof response.plan !== 'object') return invalid();
  const plan = response.plan as Record<string, unknown>;
  let count = 0;
  const tasks = (value: unknown): RoutineStep[] => {
    if (!Array.isArray(value)) return invalid();
    return value.map(task => {
      if (++count > 100 || !task || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 200
        || typeof task.durationMinutes !== 'number' || !Number.isFinite(task.durationMinutes) || task.durationMinutes <= 0 || task.durationMinutes > 10080) return invalid();
      return createStep({ title: task.title.trim(), duration: task.durationMinutes * 60 });
    });
  };
  const preparation = tasks(plan.preparation);
  if (!Array.isArray(plan.stops) || plan.stops.length > 20) return invalid();
  const stops = plan.stops.map(stop => {
    if (!stop || typeof stop.destination !== 'string' || !stop.destination.trim() || stop.destination.length > 200) return invalid();
    return { query: stop.destination.trim(), steps: tasks(stop.activities) };
  });
  if (!preparation.length && !stops.length) return invalid();
  const hour = plan.deadlineHour, minute = plan.deadlineMinute;
  let deadline: Date | null = null;
  if (hour !== null || minute !== null) {
    if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23
      || typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) return invalid();
    deadline = new Date(now);
    deadline.setHours(hour, minute, 0, 0);
  }
  return { preparation, stops, deadline, cached: response.cached === true };
}
