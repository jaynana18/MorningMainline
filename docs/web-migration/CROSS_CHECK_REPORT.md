# 跨端一致性交叉验证报告（CROSS_CHECK_REPORT）

> 验证者：xcheck-qa（独立验证，只读实现，不修改任何 `.swift` / `web/src/core/` 代码）
> 日期锚点：2026-09-23
> 方法：用 **真实 Swift 运行产出的字节** 交叉验证 TS 实现。所有结论均由真跑得出，非静态阅读。
> 一键复现：`bash tools/cross-check/run.sh`（退出码 0 = 全部一致）。原始证据留档在 `tools/cross-check/fixtures/`。

---

## 0. 结论摘要

| # | 验证项 | Swift 侧 | TS 侧 | 判定 |
|---|--------|----------|-------|------|
| A | Swift→TS 全快照字段（绝对时刻/键名/enum/UUID） | `JSONEncoder` 真跑 | `decodeSnapshot` | **一致**（0 处差异） |
| B | Optional nil 编码行为 + 双向兼容 | 真跑打印字节 | `encodeSnapshot`/`decodeSnapshot` | **一致**（且发现文档陈述有误，见 §3） |
| C | TS→Swift 反向互通 | `JSONDecoder` 真跑 | `encodeSnapshot` | **一致**（0 处差异） |
| D | `RoutineStore.start` 排程算法 | 真跑（含 RoutineStore/SwiftUI 依赖） | `RoutineStore.start` | **一致**（0 处差异） |
| E | `RoutineSession` 计算属性（M17/M18/M19） | 真跑 `estimatedDueDates/Completion/isLate` | `session.ts` | **一致**（0 处差异） |
| F | Widget 延误公式（核验 900） | 真跑 | `widget.ts` | **一致**（Swift=900） |
| G | 截止时间推断（18 锚点，M5–M9） | 真跑 | `parser.ts` | **一致**（0 处差异） |
| H | `makeSteps`（4 锚点，M12） | 真跑 | `parser.ts` | **一致** |
| I | `analyze`/leftover（4 锚点，M10/M11） | 真跑 | `parser.ts` | **一致** |
| J | 云端宽松解析（13 锚点，M27） | 真跑 | `remote.ts` | **一致** |

**独立复核工程方自报：「114 个测试全绿」→ 属实（本机复跑 114 passed）；「tsc 零错误」→ 属实（`tsc --noEmit` 退出 0）。**

**未发现功能性缺陷。** 发现 2 处「文档/常量保真度」问题（§3、§4），均不影响互通正确性。

---

## 1. 任务 1：Swift → TS 方向数据互通 —— 一致

### 方法
- `tools/cross-check/SwiftHarness/main.swift` 与 **`Shared/Models/RoutineModels.swift` 原文件一起编译**（不复制粘贴模型代码）。
- 构造固定快照：3 个模板（含 deadlineHour/Minute 为 nil、recurrence 显式置 nil 的用例）+ 1 个含 5 个 `StepProgress`（active/pending/suspended/completed/deadline 五种 state）的 `RoutineSession`；所有 UUID、时刻均为固定值。
- Swift 用**默认配置的 `JSONEncoder()`** 编码并打印；Node 侧用 `decodeSnapshot` 解码，逐字段与 Swift 导出的「绝对时刻(unix ms)真值表」比对。

### 证据（Swift 实际输出 ↔ TS 实际解读）

| 字段 | Swift 编码出的字节 | Swift 绝对时刻 | TS `decodeSnapshot` 得到的绝对时刻 | 一致 |
|------|-------------------|----------------|-----------------------------------|------|
| `snapshot.updatedAt` | `721692790` | 1699999990000 ms | 1699999990000 ms | ✅ |
| `session.startedAt` | `721692800` | 1700000000000 ms | 1700000000000 ms | ✅ |
| `session.targetDeadline` | `721694000` | 1700001200000 ms | 1700001200000 ms | ✅ |
| `progress[0].dueAt` | `721693400` | 1700000600000 ms | 1700000600000 ms | ✅ |
| `progress[0].startedAt` | `721692900` | 1700000100000 ms | 1700000100000 ms | ✅ |
| `snapshot.originID` | `"AAAAAAAA-BBBB-CCCC-DDDD-000000000001"`（大写） | — | 原样大写 | ✅ |
| `step.importance` / `role` | `"hardDeadline"` / `"deadline"` | — | 一致 | ✅ |

> 关键点：`721692800` 是 **Apple 参考秒**（2001-01-01 基准），不是 Unix 秒。`(721692800 + 978307200) * 1000 = 1700000000000`。若 TS 误当 Unix 秒，会整体偏移约 31 年——本项 0 差异证明换算正确。

- 覆盖范围证明：比对器**逐字段**递归（对象/数组/primitive），且「TS 投影比 Swift 真值多出的键」也会报差异。A 组 0 差异 ⇒ 键名集合双向一致、无多余/缺失键。
- **比对器自检（第 0 组）**：故意把 truth 的 `updatedAt` +1000ms、`state` 改值、模板 `id` 改小写，**3 处全部被检出** ⇒ 证明比对器对日期/enum/UUID 确实敏感，不是空跑。

---

## 2. 任务 2：TS → Swift 方向数据互通 —— 一致

### 方法
用 TS `encodeSnapshot` 产出一个含 `targetDeadline`、`activeProgressID`、`suspendedProgressIDs`、以及部分 nil 可选字段的 `RoutineSnapshot` JSON，管道喂给 Swift harness 的 `JSONDecoder().decode(RoutineSnapshot.self, ...)`。

### 证据
- Swift 输出 `DECODE_OK`（解码成功）。
- 解码后 re-encode 的真值表与 TS 原始值**逐字段一致**（0 差异）：`startedAt/plannedStartAt/targetDeadline/... ` 全部相等。

> **严重度说明**：这一方向失败意味着 Web 写回的快照会弄坏 iPhone/Watch 原生 App。本项通过 = 该风险排除。
> TS 侧写的是**显式 `null`**（如 `"targetDeadline":null`），Swift `decodeIfPresent` 接受 null 与缺键两种形态，故互通成立。

---

## 3. 任务 3：钉死 Optional nil 的真实编码行为 —— **文档陈述有误**

### 结论（Swift 真跑字节判定）
**Swift 自动合成的 `Codable` 对 Optional 属性使用 `encodeIfPresent`：nil 时「省略键」，不是「写成 null」。**

### 证据（`harness nilcheck` 原始 JSON 字节）

用例一（`activeSession = nil`；模板 `recurrence = nil`、`deadlineHour/Minute = nil`）：
```json
{"updatedAt":721692800,"originID":"AAAAAAAA-BBBB-CCCC-DDDD-000000000001","templates":[{"mode":"forward","buffer":0,"id":"5E43ED14-458A-49CF-8673-A96DCA196002","symbol":"x","steps":[{"id":"10000000-0000-0000-0000-000000000001","duration":60,"importance":"normal","title":"任务","prompt":"现在只做：任务","role":"task"}],"name":"全 nil"}]}
```
- **无 `activeSession` 键**（值为 nil → 整个键消失）。
- 模板对象**无 `recurrence`、无 `deadlineHour`、无 `deadlineMinute` 键**。

用例二（session 内 `targetDeadline/activeProgressID/suspendedProgressIDs` 及 progress 的 `completedAt/plannedDueAt/remainingDuration/startedAt` 均为 nil）：
```json
{"templates":[],"activeSession":{"plannedStartAt":721692800,"templateName":"裸会话","startedAt":721692800,"progress":[{"id":"...002","step":{...},"snoozeCount":0,"state":"pending","dueAt":721692860,"isTemporary":false}],"state":"running","id":"...001","remainingBuffer":0,"revision":1,"primaryDevice":"watch","templateID":"...002","templateSymbol":"x","updatedAt":721692800},"updatedAt":721692800,"originID":"..."}
```
- session 对象**无 `targetDeadline`、无 `activeProgressID`、无 `suspendedProgressIDs`**。
- progress 项**无 `completedAt`、无 `plannedDueAt`、无 `remainingDuration`、无 `startedAt`**。

（emit 用例里，非 nil 的 optional 正常出现：completed 进度含 `completedAt/plannedDueAt/remainingDuration/startedAt`；deadline 进度因三者为 nil 而**缺键**。）

### 与文档的冲突（需更正）

`docs/web-migration/LOGIC_PORT_SPEC.md` §0 现有表述与实测冲突：

> | **Optional 缺省** | 键**存在但值为 `null`**（编码时 optional 若为 nil 会写成 null；若用 `encodeIfPresent` 则缺键） |
> | **数组可选** | `suspendedProgressIDs: [UUID]?` 为 nil 时序列化为 `null` |

**更正后的表述应为：**

> | **Optional 缺省** | Swift 自动合成 `Codable` 对 Optional **使用 `encodeIfPresent`**：**为 nil 时省略整个键**（不是写 `null`）。解码端必须把「键缺失」与「显式 `null`」都当作 `nil`。 |
> | **数组可选** | `suspendedProgressIDs: [UUID]?` 为 nil 时**省略该键**（非 `null`）。读时用 `?? []`。 |
> | **方向不对称（实现事实）** | TS `encodeSnapshot` 对 nil 写**显式 `null`**，而 Swift 对 nil **省略键**。二者均能被对方解码（Swift `decodeIfPresent` 接受 null 与缺键；TS 把缺键与 null 都当 undefined），故互通无碍；但两端字节形态不一致，若未来做字节级 diff/签名需注意。 |

### TS 兼容性判定（双向实测）
- **TS 能解 Swift 省略键**：✅（含 `activeSession` 整键缺失）
- **Swift 能解 TS 显式 null**：✅（`DECODE_OK`）

**影响面**：仅文档准确性。TS 实现**无功能缺陷**（`optionalRefDate/optionalNumber/optionalStringArray`、`decodeTemplate.recurrence`、`decodeSnapshot.activeSession` 都已把「缺键」当 undefined/null 处理）。故严重度：**低**（文档级）。

---

## 4. 任务 4：排程算法交叉验证 —— 一致（且 `RoutineStore` 成功用 Swift 真跑）

### 编译可行性（超出预期）
`RoutineStore.swift`（`import SwiftUI`）连同全部依赖（`ConnectivityService` / `AppGroupSharedStore` / `ReminderScheduler` / `MainlineWidgetShared`）**在本机 `xcrun swiftc` 下编译并运行成功**（macOS 上 `canImport(WatchConnectivity)` 走空实现分支；WidgetKit/UserNotifications 可用）。因此**无需降级到「仅 RoutineSession 计算属性」**——`store.start` 也真跑了。

### D. `RoutineStore.start(RoutineTemplate.morning, now = 2026-08-13 07:00 +08)` 逐项比对

| 项 | Swift 真跑 | TS 真跑 | 一致 |
|----|-----------|---------|------|
| `now` | 1786575600000 | 1786575600000 | ✅ |
| `targetDeadline`（08:35 +08） | 1786581300000 | 1786581300000 | ✅ |
| `plannedStartAt`（= deadline − 1500 − 600 = 08:00） | 1786579200000 | 1786579200000 | ✅ |
| `remainingBuffer` | 600 | 600 | ✅ |
| `revision` | 1 | 1 | ✅ |
| `activeProgressID` / `suspendedProgressIDs` | nil / nil | null / null | ✅ |
| 刷牙 dueAt（08:03） | 1786579380000 | 1786579380000 | ✅ |
| 洗脸 dueAt（08:08） | 1786579680000 | 1786579680000 | ✅ |
| 弄头发 dueAt（08:18） | 1786580280000 | 1786580280000 | ✅ |
| 装午饭 dueAt（08:20） | 1786580400000 | 1786580400000 | ✅ |
| 下楼 dueAt（08:25） | 1786580700000 | 1786580700000 | ✅ |
| **出门（deadline 节点）dueAt（08:35）** | 1786581300000 | 1786581300000 | ✅ |

- **倒推公式**（`deadline − 固定缓冲 − 总时长`）验证：plannedStart = 08:00 = 08:35 − 25min − 10min ✅
- **缓冲不被延误扣减**：`remainingBuffer` 初始 = 600，与 deadline 一致 ✅（后续延误场景见盲区）
- **末尾 deadline 节点**：`dueAt` 直接落 deadline（未按 cursor 累加），`remainingDuration` 为 nil ✅

### E. `RoutineSession` 计算属性（测试 8 锚点：now=10000s，target=now−600s）
| 项 | Swift | TS | 一致 |
|----|-------|----|------|
| `estimatedDueDates[first]` | 10300000 ms | 10300000 ms | ✅ |
| `estimatedDueDates[second]` | 10600000 ms | 10600000 ms | ✅ |
| `estimatedDueDates[deadline]` | 10600000 ms | 10600000 ms | ✅ |
| `estimatedCompletion` | 10600000 ms | 10600000 ms | ✅ |
| `isLate` | true | true | ✅ |
| `originalDueAt(first)` / `remainingWork(first)` | 9400000 / 300 | 9400000 / 300 | ✅ |

> 过程中曾出现 8 处差异，**经排查是我 harness 自己的 bug**（JS `new Date(10000)` 是毫秒，Swift `Date(timeIntervalSince1970:10000)` 是秒，混用），修正后一致。这正是「报不一致前先证伪自己的脚本」的实例。

### F. Widget 延误公式（核验工程方自报「期望值修正为 900」）
- Swift 真跑同一场景：`estimatedCompletion = now+300s`，`targetDeadline = now−600s` ⇒ `delayDuration = max(0, (now+300)−(now−600)) = 900`。
- **判定：900 是数学正确的值，不是「放松断言」**。`widget.test.ts` 用的是严格相等 `expect(widget.delayDuration).toBe(900)`（非 `toBeGreaterThan(0)` 之类的弱断言）。Swift 独立复现 = 900，断言正确。

---

## 5. 对工程方两处自报改动的独立核实

### 5.1 widget 测试「期望值修正为 900」
- **事实**：`web/tests/widget.test.ts` 中 `expect(widget.delayDuration).toBe(900)`（严格相等）。
- **核实**：见 §4-F，Swift 真跑同场景 = 900。**不是放松断言，是正确值。**
- 附注：`git log` 显示 `widget.test.ts` 仅存在于 P0 提交（`6da1d41`），仓库内**无更早版本可比对**，故无法看到「修正前」的值；但以「当前断言是否正确」为准，判定正确。

### 5.2 `remote.ts` 新增 logger
- **事实**：`RemoteRoutineParsingService` 构造注入 `logger`，默认 `() => {}`（no-op）；调用点为 4 处 `this.logger(...)`（`remote.ts:632/638/672/678`）。
- **控制流核查**：4 处均是在**既有分支内**追加的纯副作用语句——
  - `632`：`if (!apiKey)` 分支内（既有）；
  - `638`：`if (!payload) { log; return null }`——`return null` 是既有逻辑，logger 在其前，不改变返回值；
  - `672`：`if (isHttpStatusError && isRejectedRequest)` 分支内（既有降级逻辑）；
  - `678`：`else`（非形状错误）分支内，其后 `throw error`（既有）。
  - **无新增 `return`/`throw`/分支条件，控制流与 `LOGIC_PORT_SPEC` §2.6 一致。**
- **测试核查**：`pipeline.test.ts:117 G5` 注入 `logger: (m)=>logs.push(m)` 并断言 `logs.length > 0`——这只**依赖**日志被调用，未改变解析/降级行为（同测试仍断言 `source==='rule'`）。
- **判定：不影响控制流，属可观测性增强，安全。**

---

## 6. 发现的问题（按严重度排序）

### D1（低·文档）`LOGIC_PORT_SPEC.md` §0 关于 Optional nil 的陈述错误
- **现象**：文档称 optional 为 nil 时序列化为 `null`；实测 Swift 合成 Codable **省略键**。
- **影响面**：文档准确性。TS 实现已同时兼容「缺键」与「null」，**无功能缺陷**。
- **复现**：`tools/cross-check/SwiftHarness/harness nilcheck`，观察 JSON 中键的缺席。
- **建议**：按 §3 的「更正后表述」修订文档。

### D2（低·保真度）TS `DISTANT_PAST` 与 Swift `Date.distantPast` 不相等
- **现象**：Swift `Date.distantPast` 编码 = **-62135769600000 ms**（参考秒 -63114076800）；TS `types.ts` 的 `DISTANT_PAST = new Date(-62135596800000)`（参考秒 -63113904000）。**漂移 172800 秒（2 天）**。
- **影响面**：仅影响「空快照/哨兵」时间戳的字节值；二者都≈year 1，任何真实时间戳都远大于它们，**对冲突裁决的排序无实际影响**。`types.ts` 注释已用「约」/「≈」承认近似，`LOGIC_PORT_SPEC.md` §1.2 也写「约」。
- **复现**：`tools/cross-check/SwiftHarness/harness constants` 对比 `web/src/core/types.ts:546`。
- **建议**（可选）：若要字节级完全一致，把 TS 常量改为 `new Date(-62135769600000)`（参考秒 -63114076800）。**不是必须**。

> 未发现高/中严重度功能缺陷。上述两项都不破坏互通。

---

## 7. 遗留验证盲区（无法覆盖的部分及原因）

1. **`RoutineStore` 多步状态迁移未用 Swift 真跑**（**最大盲区**）。本次真跑了 `start`（D）与 `RoutineSession` 计算属性（E），但 `complete` / `snoozeCurrent` / `addTemporaryTask` / `reorderPendingTasks` / `deleteFromCurrentSession` / `activate` / `suspend` / `resume` 的**组合序列**未交叉验证。原因：这些方法内部用 `Date()` 取当前时刻（构造参数不可注入，如 `complete(_:)` 开头 `let now = Date()`），无法构造确定性输入；`addTemporaryTask` 亦然。因此 M20（末尾 deadline 自动完成）/ M21（挂起-恢复栈）/ M3-M4（延误与缓冲）的**动态行为**仅靠 TS 单测 + 源码静态对照，非 Swift 真跑。
2. **原生同步/通知/持久化未覆盖**：`ConnectivityService` 的 `WCSession` 分支在 macOS 编译时走空实现（`canImport(WatchConnectivity)` 为假），**iOS↔Watch 实机同步路径未验证**；`ReminderScheduler` 的 `replaceNotifications` 在 macOS 上被真调用（未崩溃），但**生成的通知数量/文案/8 个 milestone 未断言**；`CloudSnapshotStore`（iCloud KV）未编译验证。
3. **网络层未覆盖**：`remote.ts` 只验证了纯函数（`decodePayload` 及解析规则）；真实 `URLSession`/`fetch` 请求、`ChatCompletion` 的 snake_case 传输结构、降级重试的网络时序未用 Swift 真跑。
4. **时区仅覆盖 Asia/Shanghai**：所有「本地日历日 + 读回」断言只在 UTC+8（无 DST）下比对；有 DST 的时区（漂移点 3）未验证。
5. **旧数据兼容的字节级形态**：TS 写的 `null` vs Swift 省略键的**不对称**已确认为可互通（§3），但未穷举所有历史快照形态。

---

## 8. 产出文件与可复现命令

### 新增文件（均在 `tools/cross-check/`）
| 文件 | 说明 |
|------|------|
| `SwiftHarness/main.swift` | 模型/序列化/会话计算属性 harness（**编入 `Shared/Models/RoutineModels.swift`**） |
| `StoreHarness/StoreHarness.swift` | `RoutineStore.start` harness（编入 Store + 4 个依赖原文件） |
| `ParserHarness/ParserHarness.swift` | 解析层 harness（编入两个解析服务原文件） |
| `compare.ts` | 比对脚本（vite-node 运行，`import web/src/core/*`） |
| `run.sh` | 一键复现（编译 3 harness + 跑比对） |
| `README.md` | 编译/运行说明 |
| `fixtures/` | 原始证据留档：`swift_emit.json`、`swift_truth.json`、`swift_nilcheck.txt`、`store_start.json`、`parser.json`、`compare_output.txt` |

### 复现命令
```bash
# 一键（推荐），退出码 0 = 全部一致
bash tools/cross-check/run.sh

# 关键单项
tools/cross-check/SwiftHarness/harness nilcheck        # 任务 3：optional nil 真实字节
TZ=Asia/Shanghai tools/cross-check/StoreHarness/store_harness    # 任务 4：排程
TZ=Asia/Shanghai web/node_modules/.bin/vite-node tools/cross-check/compare.ts
```

### 独立复核结果
- `cd web && TZ=Asia/Shanghai npx vitest run` → **Test Files 10 passed, Tests 114 passed**。
- `cd web && npx tsc --noEmit` → **退出 0（零错误）**。

---

## 9. 最终判定

- **跨端一致性核心命题成立**：Swift 真跑 ↔ TS 双向数据互通、排程算法、会话计算属性、Widget 公式、解析层——**A–J 全部一致，0 字段差异**，且比对器经注入错误自检证明有效。
- **未发现功能缺陷**；2 处低severity问题（§0 文档陈述、`DISTANT_PAST` 常量）不影响互通。
- **路由决定：NoOne（无需 Engineer 返工）**；建议仅做文档更正（§3 的措辞、§6-D1）。
- **最大盲区**：`RoutineStore` 的多步状态迁移因时钟不可注入而无法确定性真跑（§7-1），建议 P1 阶段为这些方法补「可注入时钟」后再纳入本交叉验证脚本。
