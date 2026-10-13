import { accountRequest } from './account';
import { readAIPlan, type AIPlan } from '../core/aiPlan';

export async function parseTaskPlan(input: string): Promise<AIPlan> {
  if (!input.trim()) throw new Error('请先写下要做的事。');
  const result = await accountRequest('/parse', 'POST', { input });
  return readAIPlan(result);
}
