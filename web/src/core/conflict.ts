/**
 * core/conflict.ts — 跨端冲突裁决（LOGIC_PORT_SPEC §4，必守断言 M22 / G6）。
 *
 * 三条不可协商的语义（§5.2）：
 *   1. `originID` 等于本机 deviceID → **最先短路拒收**（防同步自激）；
 *   2. `incomingRevision > currentRevision` **或** `incoming.updatedAt > current.updatedAt`
 *      （OR 关系，不得写成 AND）；
 *   3. 相等即拒绝（严格 `>`，**禁止改 `>=`**）。
 *
 * 采纳后是**整体替换** snapshot（不是字段合并）。
 */

import type { RoutineSnapshot } from './types';
import { cloneSnapshot } from './types';
import { normalizeUUID } from './serialization';

/** 是否采纳远端快照。 */
export function shouldAdopt(
  incoming: RoutineSnapshot,
  current: RoutineSnapshot,
  selfDeviceID: string,
): boolean {
  // 条件 1：来源过滤（最高优先级，最先判）。
  if (normalizeUUID(incoming.originID) === normalizeUUID(selfDeviceID)) {
    return false;
  }

  // 条件 2 / 3：版本与时间戳，二者为「或」关系。
  const incomingRevision = incoming.activeSession?.revision ?? 0;
  const currentRevision = current.activeSession?.revision ?? 0;

  if (incomingRevision > currentRevision) {
    return true;
  }
  if (incoming.updatedAt.getTime() > current.updatedAt.getTime()) {
    return true;
  }
  return false;
}

/**
 * 采纳则整体替换（返回 incoming 的深拷贝），否则原样返回 current。
 * 注意：reject 分支不产生任何副作用（saveLocally/reschedule 由调用方在采纳后执行）。
 */
export function applyIncoming(
  incoming: RoutineSnapshot,
  current: RoutineSnapshot,
  selfDeviceID: string,
): RoutineSnapshot {
  if (!shouldAdopt(incoming, current, selfDeviceID)) {
    return current;
  }
  return cloneSnapshot(incoming);
}
