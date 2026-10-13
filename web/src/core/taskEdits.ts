import type { RoutineStep } from './types';
import { makeSteps, replacingChineseDurationNumerals } from './parser';

/** 先生成修改预览，命中不唯一时拒绝修改，避免误改同名任务。 */
export function editTasks(steps: RoutineStep[], instruction: string): RoutineStep[] {
  const text = replacingChineseDurationNumerals(instruction.trim());
  const duration = text.match(/^(.+?)\s*(?:增加|加长|再加)\s*(\d+(?:\.5)?)\s*(分钟|分|小时)$/);
  if (duration) {
    const title = duration[1].replace(/^把/, '').replace(/(?:的时间|时间|时长)$/, '').trim();
    const target = uniqueTask(steps, title);
    const seconds = Number(duration[2]) * (duration[3] === '小时' ? 3600 : 60);
    if (!(seconds > 0)) throw new Error('增加的时间需要大于 0。');
    return steps.map((step) => step.id === target.id ? { ...step, duration: step.duration + seconds } : step);
  }
  const insertion = text.match(/^在\s*(.+?)\s*(?:之前|前)\s*(?:增加|添加|加上)\s*(.+)$/);
  if (insertion) {
    const target = uniqueTask(steps, insertion[1].trim());
    const added = makeSteps(insertion[2]);
    if (added.length === 0) throw new Error('请写明新增任务和时长，例如「在刷牙前增加喝水 2 分钟」。');
    const index = steps.findIndex((step) => step.id === target.id);
    return [...steps.slice(0, index), ...added, ...steps.slice(index)];
  }
  throw new Error('支持「在刷牙前增加喝水 2 分钟」或「刷牙增加 1 分钟」。');
}

function uniqueTask(steps: RoutineStep[], title: string): RoutineStep {
  const matches = steps.filter((step) => step.role === 'task' && step.title === title);
  if (matches.length !== 1) throw new Error(matches.length ? '有多个同名任务，请先区分任务名称。' : `没有找到「${title}」，请使用预览中的完整任务名。`);
  return matches[0];
}
