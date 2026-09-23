# 双宿主 Vue 网页版架构方案

> 决策：iOS/iPad 端 UI 迁移为 Vue 网页版；同一份 Vue 代码库同时支持两种宿主（App 内 WebView / 浏览器）。
> Apple Watch 端保持原生 Swift **完全不改**；提醒形态为**应用内弹窗 + 系统通知**双通道。
>
> 依据：[LOGIC_PORT_SPEC.md](LOGIC_PORT_SPEC.md)（类型/函数/状态机/序列化契约）、[CROSS_PLATFORM_TEST_SPEC.md](CROSS_PLATFORM_TEST_SPEC.md)（44 用例 / 28 必守断言 M1–M28 / 16 盲区 G1–G16 / 时区约束 W1–W6）。

---

## 1. 宿主能力矩阵（架构的第一性事实）

同一份 Vue 代码，在两宿主下能力不同。**差异必须由 `PlatformBridge` 集中收口，core 层与视图层禁止感知宿主。**

| 能力 | WebView 宿主（App 内） | 浏览器宿主 |
| --- | --- | --- |
| 数据持久化 | 原生 `UserDefaults`（经桥） | `IndexedDB` |
| Apple Watch 同步 | ✅ 复用原生 `WCSession` | ❌ **物理边界**，无 Web 替代 |
| 后台/锁屏系统通知 | ✅ 复用 `UNUserNotification`，含 `timeSensitive` 与自定义音 | ⚠️ 仅 Web Push（需后端 + Service Worker + 用户装 PWA）；否则降级为**仅前台** |
| 应用内弹窗 | ✅ | ✅ |
| 主屏小组件 / 表盘 | ✅ 复用 App Group | ❌ |
| 云端语义解析 | ✅ 原生代发，**Key 不出设备** | ⚠️ 直连会暴露 Key → 走后端代理；无代理则降级纯规则 |
| 与 iPhone 原生的数据互通 | ✅ 桥接直读直写 | ❌ 需自建后端 |

**结论**：浏览器宿主是「只读/离线友好」的子集；要达到「跨端逻辑一致」，WebView 宿主才是主战场。两宿主共享的是 **core 层（100% 同代码）**，分叉的只有 `platform/` 与部分视图降级提示。

---

## 2. 目录结构

```
MorningMainline/
├── Shared/                          # 不动
├── Watch/                           # 不动
├── iOS/
│   ├── ContentView.swift            # 1385 行 → 替换为 WebHostView
│   └── WebHost.swift                # 新增：WKWebView 容器 + 桥
├── iOSWidget/  WatchWidget/         # 不动
├── web/                             # 新增
│   ├── index.html
│   ├── vite.config.ts
│   ├── vitest.config.ts             # 必须 TZ=Asia/Shanghai（约束 W1）
│   └── src/
│       ├── core/                    # 纯逻辑，零 DOM / 零平台 API
│       │   ├── types.ts
│       │   ├── serialization.ts     # Apple 参考日期换算（最大坑）
│       │   ├── parser.ts            # QuickRoutineParser 等价
│       │   ├── pipeline.ts          # 规则优先 + 模型补位
│       │   ├── remote.ts            # 云端宽松解析 + 降级重试
│       │   ├── session.ts           # RoutineSession 计算属性
│       │   ├── store.ts             # RoutineStore 状态机
│       │   ├── conflict.ts          # §4 裁决器
│       │   └── widget.ts            # makeWidgetSnapshot 等价
│       ├── platform/
│       │   ├── bridge.ts            # 接口 + 能力探测
│       │   ├── webview.ts
│       │   ├── browser.ts
│       │   └── mock.ts              # 单测用
│       ├── stores/                  # Pinia
│       ├── views/                   # 13 个 SwiftUI View 的对应组件
│       └── main.ts
└── docs/web-migration/
```

---

## 3. 桥接协议（WebView 宿主的唯一原生入口）

**消息格式**（JS → Swift，经 `WKScriptMessageHandler`）：

```jsonc
{ "id": "uuid", "method": "snapshot.read", "params": {} }
```

**回执**（Swift → JS，经 `evaluateJavaScript` 回调同一 `id`）：

```jsonc
{ "id": "uuid", "ok": true, "result": { } }
{ "id": "uuid", "ok": false, "error": "message" }
```

**方法表**：

| method | params | result | 底层实现 |
| --- | --- | --- | --- |
| `device.info` | — | `{ id, role }` | `UserDefaults["morning-mainline.device-id"]` + `UIDevice.userInterfaceIdiom` |
| `snapshot.read` | — | `RoutineSnapshot \| null` | `UserDefaults["morning-mainline.local-snapshot.v2"]` |
| `snapshot.write` | `{ snapshot }` | `{ revision }` | 写 UserDefaults + `connectivity.publish` + `AppGroupSharedStore.write` + `rescheduleIfNeeded` |
| `notifications.requestAuthorization` | — | `{ granted }` | `UNUserNotificationCenter.requestAuthorization` |
| `notifications.replace` | `{ session \| null }` | — | `ReminderScheduler.replaceNotifications` |
| `notifications.present` | `{ title, body, level }` | — | 前台即时通知（应用内弹窗由 Vue 自绘，此接口用于降级/兜底） |
| `parse.withModel` | `{ input }` | `ParseResult \| null` | 原生 `RemoteRoutineParsingService` 代发，**Key 不进程外** |

**事件**（Swift → JS 主动推送）：

| event | payload | 触发时机 |
| --- | --- | --- |
| `snapshot.changed` | `{ snapshot, origin }` | 收到 Watch 快照 / 原生侧变更 |
| `notification.opened` | `{ progressID?, sessionID?, minuteOffset? }` | 用户点击通知 |

**能力探测**：`window.webkit?.messageHandlers?.mainline` 存在 ⇒ WebView 宿主；否则浏览器宿主。所有 `bridge.method` 在浏览器宿主下走对应降级实现（见第 1 节矩阵）。

---

## 4. core 层导出契约（并行开发的接口锁定）

钉死文件名与导出名，使「逻辑移植」与「测试编写」可并行。

| 文件 | 必须导出 |
| --- | --- |
| `core/types.ts` | `RoutineStep` `RoutineTemplate` `RoutineSession` `StepProgress` `RoutineSnapshot` `DeviceRole` `StepRole` `StepImportance` `StepState` `RoutineMode` `Recurrence` `TemporaryTaskPlacement` `ParseResult` `ParseSource` |
| `core/serialization.ts` | `APPLE_REFERENCE_EPOCH_OFFSET = 978307200` `refSecondsToMs(n): number` `msToRefSeconds(n): number` `encodeSnapshot(s): string` `decodeSnapshot(json): RoutineSnapshot \| null` `normalizeUUID(s): string` |
| `core/parser.ts` | `normalizedSource(input)` `leftoverText(input, deadline)` `inferredDeadline(input, now, tz)` `makeSteps(input)` `makeTemplate(steps, deadline, recurrence, now, tz)` `analyze(input, now, tz)` |
| `core/pipeline.ts` | `class RoutineParsingPipeline { parse(input, now): Promise<ParseResult> }` `setEnhanced(impl \| null)` |
| `core/remote.ts` | `class RemoteRoutineParsingService` `decodePayload(raw): ParseResult \| null` `makeDeadline(hour, minute, now, tz)` `isRejectedRequest(status): boolean` `buildBodyVariants(config): BodyVariant[]` |
| `core/session.ts` | `totalTaskDuration(t)` `estimatedDueDates(s, now)` `estimatedCompletion(s, now)` `isLate(s, now)` `remainingWork(p)` `originalDueAt(p)` |
| `core/store.ts` | `class RoutineStore { start, startProgress, complete, snoozeCurrent, addTemporaryTask, reorderPendingTasks, deleteFromCurrentSession, cancel, finish }` |
| `core/conflict.ts` | `shouldAdopt(incoming, current, selfDeviceID): boolean` `applyIncoming(incoming, current, selfDeviceID)` |
| `core/widget.ts` | `makeWidgetSnapshot(snapshot, at)` `widgetEntry(snapshot, at)` |

**时区**：所有时间函数**必须显式接收 `tz`/`now` 参数**（约束 W4），禁止函数体内隐式读全局时区。

---

## 5. 三条不可协商的语义（违反即跨端漂移）

1. **Date 编码是 Apple 参考日期秒，不是 Unix 秒。**
   `JSONEncoder` 默认 `.deferredToDate` → `Double`，单位秒，基准 `2001-01-01T00:00:00Z`。
   `epochMs = (refSeconds + 978307200) * 1000`；反向 `refSeconds = epochMs/1000 - 978307200`。
   直接当 Unix 秒处理会**静默偏移约 31 年**（仍是合法 Double，最难发现）。

2. **冲突裁决用严格 `>`，且 revision / updatedAt 是 OR。**
   `originID === 自身` 最先短路拒收（防同步自激）；`incomingRevision > currentRevision` **或** `incoming.updatedAt > current.updatedAt` 任一成立才采纳；相等即拒绝。**禁止改 `>=`。**

3. **缓冲不可被延误挪用。**
   `remainingBuffer` 初始化后**永不被修改**；`consumeDelay` 只对 `index ≥ 起点 且未完成` 的项 `dueAt += seconds`，**绝不前移**。末尾 `deadline` 节点在最后一项实际任务完成时**自动完成**，不需二次点击。

---

## 6. 提醒双通道设计

| 通道 | 实现者 | 覆盖场景 |
| --- | --- | --- |
| 应用内弹窗 | Vue（`views/` 内的 Overlay 组件） | App/页面在前台、任务切换、deadline 里程碑到点 |
| 系统通知 | WebView 宿主 → 原生 `ReminderScheduler`；浏览器宿主 → Notification API / Web Push | App 在后台或锁屏 |

文案与排期**必须逐字复刻** `ReminderScheduler`：每个未完成 task 在其 `dueAt > now` 时排一条；`targetDeadline` 的 8 个里程碑 −10/−5/−3/−1/0/+2/+4/+6 分钟；`0` 及正偏移用自定义音 `deadline-overdue.aiff`（watchOS 用系统音）。应用内弹窗与系统通知共用同一套文案生成函数，避免两处漂移。

---

## 7. 安全边界

- **API Key 绝不进入浏览器**。浏览器宿主下 `parse.withModel` 必须走后端代理；无代理时降级为纯规则解析（`source === 'rule'`），并在 UI 明示。
- WebView 宿主下 Key 只存在于原生进程（scheme 环境变量 / Info.plist），经 `parse.withModel` 代理调用，JS 侧永远拿不到。
- `*.xcscheme` 已在 `.gitignore`（内含调试环境变量）。

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **P0** | 脚手架（Vite + Vue 3 + TS + Vitest，`TZ=Asia/Shanghai`）+ `core/` 全部纯逻辑移植 | **44 个等价用例 + 28 条 M 断言全绿**；`core/` 零平台 API 依赖 |
| **P1** | `platform/bridge.ts` + `browser.ts` + Pinia stores + 视图（创建页、任务线、执行中）| 浏览器内跑通「一句话创建 → 拆分 → 执行 → 完成」全流程 |
| **P2** | `iOS/WebHost.swift`（WKWebView + 桥）+ `platform/webview.ts`，替换 `ContentView` | App 内可用；通知、Watch 同步、小组件接回 |
| **P3** | 应用内弹窗（对齐 8 里程碑文案）+ 通知点击回跳 | 双通道一致 |
| **P4** | 一致性回归 G1–G16 + 真机验收 | 跨端行为无漂移 |

**P0 是最高价值且可独立验收** —— 逻辑一致性的风险 90% 集中在这一层。

---

## 9. 明确不做（本方案边界）

- 不修改 `Shared/`（除必要时新增桥接专用类型）、`Watch/`、两个 Widget target。
- 不为浏览器宿主新建后端服务（留待后续独立评估；当前以「降级 + UI 明示」处理）。
- 不追求浏览器宿主具备 Watch 同步能力（物理不可达）。
