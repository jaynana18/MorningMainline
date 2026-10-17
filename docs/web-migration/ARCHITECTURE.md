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

## 1b. 全屏适配分工（2026-10-15 定）

**一句话：原生把整个屏幕交还给网页，避让全权由 CSS 的 `env(safe-area-inset-*)` 负责。**

不这么做就会出「上下不满屏、有黑边」（2026-10-15 实修 bug）。**三处缺一不可**：

| # | 位置 | 改动 | 缺了会怎样 |
| --- | --- | --- | --- |
| 1 | `iOS/MorningMainlineApp.swift` | `WebHost(store:).ignoresSafeArea()` | SwiftUI 会把整个 `UIViewControllerRepresentable` 内缩到安全区 —— **此时 `view` 本身就是内缩后的框**，只改约束无效 |
| 2 | `iOS/WebHost.swift` | 约束绑 `view.leadingAnchor/topAnchor/...`（**不是** `safeAreaLayoutGuide`）+ `scrollView.contentInsetAdjustmentBehavior = .never` | 边缘露出黑底；或 WKWebView 再自动避让一次 → **双重避让** |
| 3 | `web/index.html` | viewport 加 `viewport-fit=cover` | **`env(safe-area-inset-*)` 恒为 0**，CSS 避让全部失效 |

**连带约束**：既然避让归 CSS，**每个贴边的容器都要自己吃 `env()`**（`.mm-toolbar` 吃 top、底部抽屉不吃 top 但要吃 bottom、加载态提示同理）。新增全屏布局时别忘了这条。

**验证要点**：黑边在**浅色模式下几乎看不出**（正是此前漏掉的原因），**必须在深色模式验**。判据用「顶/底最外 8 行最暗像素亮度 > 60」。多机型覆盖：刘海全面屏 / 非全面屏（SE）/ iPad 各一台。

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
| `notifications.foregroundReady` | `{ ready }` | — | Vue 页内提醒通道 ready 时抑制前台系统横幅；未就绪/加载失败时保留横幅兜底 |
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

## 4b. P1 接口冻结（平台层 / 视图层并行开发的契约）

平台层（`platform/` + `stores/`）与视图层（`views/`）**按此契约并行开发**，互不改对方文件。

### 4b.1 `PlatformBridge` 接口（`web/src/platform/bridge.ts`）

```ts
export interface DeviceInfo { id: string; role: DeviceRole }

export interface BridgeCapabilities {
  watchSync: boolean;              // WebView=true, browser=false
  backgroundNotification: boolean; // WebView=true, browser=仅前台
  modelParsing: boolean;           // 是否有可用代理/原生代发
  widget: boolean;                 // WebView=true, browser=false
}

/** 跨设备共用设置（2026-10-13 新增；2026-10-15 去掉 amapKey）。 */
export interface SharedSettings { travelMode: string; speechEnabled: boolean; overduePolicy: OverduePolicy }
export const EMPTY_SHARED_SETTINGS: SharedSettings;

export interface PlatformBridge {
  readonly host: 'webview' | 'browser';
  readonly capabilities: BridgeCapabilities;

  deviceInfo(): Promise<DeviceInfo>;
  readSnapshot(): Promise<RoutineSnapshot | null>;
  writeSnapshot(snapshot: RoutineSnapshot): Promise<void>;

  /** 读取跨设备共用设置（出行方式 / 播报 / 超时策略）。无能力时返回 EMPTY_SHARED_SETTINGS。 */
  readSettings(): Promise<SharedSettings>;
  /** 写入并广播给配对设备（手表靠这一步拿到三项偏好）。无能力时静默 no-op。 */
  writeSettings(settings: SharedSettings): Promise<void>;

  requestNotificationAuthorization(): Promise<boolean>;
  replaceNotifications(session: RoutineSession | null): Promise<void>;
  presentNotification(payload: { title: string; body: string; level?: 'normal' | 'timeSensitive' }): Promise<void>;
  /** 告知原生前台页内提醒通道是否已就绪；未就绪时原生保留系统横幅兜底。 */
  setForegroundReminderReady(ready: boolean): Promise<void>;

  /** 云端语义解析。宿主无能力时 resolve(null)，调用方静默回退纯规则。 */
  parseWithModel(input: string): Promise<ParseResult | null>;

  /** 返回取消订阅函数。 */
  onSnapshotChanged(cb: (snapshot: RoutineSnapshot) => void): () => void;
  onNotificationOpened(cb: (payload: { progressID?: string; sessionID?: string; minuteOffset?: number }) => void): () => void;
  /** App/页面前后台状态变化（线格式事件名 `app.state`，载荷 `{visible: Bool}`）。
   *  返回取消订阅函数；订阅时**立即回调当前态**。 */
  onAppStateChanged(cb: (visible: boolean) => void): () => void;
}

/** 自动探测宿主并返回对应实现（webview / browser）。 */
export function createBridge(): PlatformBridge;
```

**硬性要求**：
- `platform/mock.ts` 必须提供纯内存实现，供单测与浏览器无持久化场景使用。
- 浏览器宿主的 `writeSnapshot` 落 `IndexedDB`；`deviceInfo().id` 必须**持久化且稳定**（否则 `originID` 过滤失效 → 同步自激）。
- 浏览器宿主 `parseWithModel` 在**无后端代理时返回 `null`**，绝不可把 API Key 打进前端产物。
- 🔴 **高德 Key 只存在服务端，任何客户端都不持有它**（2026-10-15 第二次修订，B 方案／BFF）。
  - 事实起点：Key 曾由构建期 `VITE_AMAP_WEB_SERVICE_KEY` 注入 → **实证泄露到线上 JS 产物**（`VITE_` 前缀即等于公开）。把 Key 挪进任何客户端形态（localStorage / App Group / Watch settings）都只是换个地方公开，因为客户端产物一定可被下载反查。
  - 现方案：Key 只活在账号服务进程的环境变量 `AMAP_WEB_SERVICE_KEY`（`server/.env.account`）。对外暴露同源代理：
    - `GET /api/commute/rest?path=<高德接口>&<业务参数…>` → JSON
    - `GET /api/commute/staticmap?<静态地图参数…>` → PNG
  - **三道防线**（`server/account-server.mjs` 的 `handleCommute`）：① Key 本体不外泄，攻击者绕不开本服务直连高德；② **精确字符串 path 白名单**（`AMAP_PATHS`，不做前缀匹配）防 SSRF，本服务不得沦为任意 URL 转发器；③ 按 IP 限流（60/分、2000/天，`AMAP_DAILY_LIMIT` 可调）把盗刷压在免费额度内。
  - **参数白名单透传**（`AMAP_PARAMS`）：`key` **不在表内**，客户端自带 `key` 一律被丢弃、无法覆盖服务端那把。用白名单而非黑名单 —— 高德未来新增「写」类参数默认拒绝。
  - **代理刻意不引入第二把客户端凭据**：任何内嵌在 JS 里的 token 与 Key 同等可被 curl 走，等于白加一层。
  - 三端都只访问代理，**客户端零凭据**：
    - WebView 宿主（`file://`）：原生 `commute.rest` 桥（`iOS/WebHost.swift` 硬编码 `https://47.104.95.146/api/commute/rest`）。
    - 浏览器宿主：同源 `fetch('/api/commute/rest')`（dev 由 `web/vite.config.ts` 代理到 ECS）。
    - Watch：`Shared/Services/CommuteService.swift` 直连同一代理。
  - ⚠️ **静态地图无法走桥**：`<img src>` 不接受 Promise，且 `file://` 下相对路径 `/api/commute/…` 会解析到文件系统根。故 WebView 宿主必须拼**固定 HTTPS 域名**（`platform/commute.ts` 的 `COMMUTE_ORIGIN`）；该端点无需凭据，可安全直连。
  - 📌 **不要回退成「把 Key 塞进设置」**：`SharedSettings` 已无 `amapKey`，`developerAmapKey()` 已删除，`web/.env.local` 已删除。`ProfileView` 上也不应有 Key 输入框。
  - 因此 `settings.write` 不再需要「只有传了 `amapKey` 才改」的特判 —— 那个坑随字段消失而消失。
- 🔴 **「用户习惯」三项（出行方式 / 语音播报 / 超时提醒间隔）跟账号走**：走 `platform/account.ts` 的 `withAccountSync` 代理 → `GET/PUT /api/account/preferences`。**LWW 而非乐观锁**（偏好冲突代价只是覆盖某一项），`updatedAt` 由服务端打。
  - 🔴 `pullPreferences` **绝不能整体替换**本机设置对象 —— 必须显式只合并服务端白名单三项（`pickPreferences`）。历史上这里还额外保护过 `amapKey`，该字段已不存在，但「只并白名单、不整体覆盖」的纪律必须保留（否则未来任何本机独有字段都会静默被清）。守卫测试：`web/tests/account-preferences.test.ts` 的「🔴 推送内容只含白名单三项」。
- **`travelMode` 等三项偏好的跨设备共享**：WebView 宿主写 App Group 并经 WCSession 广播给手表；浏览器宿主只能落 `localStorage`（仅本页有效，无手表）。这一点必须如实向用户呈现，不可假装同步成功。
- 桥的调用必须带超时与失败降级：任何原生方法抛错/超时（建议 5s）都不得让 UI 卡死，须回落到 `browser` 语义或返回 `null`。

### 4b.2 Pinia store 契约（`web/src/stores/routine.ts`）

单一 store：`useRoutineStore()`，内部持有 `core/store.ts` 的 `RoutineStore` 实例（core 层**不做响应式改造**，由 Pinia 包一层）。

```ts
// state（只读对外）
snapshot: RoutineSnapshot
ready: boolean                 // init 完成
parsing: boolean               // 正在解析
lastParse: ParseResult | null  // 最近一次「一句话创建」的解析产物
notice: string | null          // 降级/失败提示（如「已回退本机规则」）

// getters
session: RoutineSession | null
currentProgress: StepProgress | null
nextProgress: StepProgress[]
templates: RoutineTemplate[]

// actions
init(): Promise<void>                       // 读快照 + 请求通知授权 + 订阅 onSnapshotChanged
parse(input: string): Promise<ParseResult>  // 走 RoutineParsingPipeline；浏览器宿主经 bridge.parseWithModel
createTemplate(input: string, opts: { deadline: Date | null; recurrence: Recurrence }): RoutineTemplate
addTemplate(t: RoutineTemplate): void
start(t: RoutineTemplate, opts?: { deadlineOverride?: Date | null; bufferOverride?: number | null }): void
startProgress(p: StepProgress): void
complete(p: StepProgress): void
snoozeCurrent(seconds?: number): void
addTemporaryTask(title: string, minutes: number, placement: TemporaryTaskPlacement): void
reorderPendingTasks(ids: string[]): void
applyCommuteRoutes(updates: { progressID: string; commute: CommuteInfo; duration?: number }[]): void  // web 扩展，见 LOGIC_PORT_SPEC §3.8b
deleteFromCurrentSession(p: StepProgress): void
cancel(): void
finish(): void
applyIncoming(s: RoutineSnapshot): boolean
```

**每次变更后必须**：`writeSnapshot()` → `replaceNotifications(session)`。这两步收口在 store 的一个私有 `commit()` 里，视图层不得各自调用。

### 4b.3 视图层要复刻的交互（源：`iOS/ContentView.swift`，1385 行 / 13 个 View）

| Vue 组件 | 源 SwiftUI | 必须保留的交互 |
| --- | --- | --- |
| `views/QuickCreateView.vue` | `QuickCreateView`（1222 行起） | 输入 → **生成按钮** → 生成后**才**出现截止时间控件与预览；无截止时间时开关**默认关闭**；手改截止时间/重复方式**即时重算且不清空已解析步骤**；footer 提示「截止时间可以直接写进去，比如『18点30结束』；生成后也能手动调整。」 |
| `views/HomeView.vue` | `ContentView` 主体 + `TaskLinesHero` + `TaskLineCard` | 任务线列表、启动、进入预览 |
| `views/TemplatePreviewView.vue` | `TaskLinePreviewView` | 倒推计划展示（`BackwardPlanSummary`）、步骤编辑 |
| `views/SessionView.vue` | `ActiveFocusCard` + `TimelineCard` + `PendingTaskReorderView` + `TemporaryTaskView` + `CompletionResultOverlay` | 当前任务焦点卡、时间线、未完成项重排（拖拽）、临时任务插入（两种 placement）、完成结果浮层、snooze |
| `views/PlanImpactCard.vue` | `PlanImpactCard` | 延误影响提示 |

**已偏离 Swift 的两处（2026-10-13）**：
1. **排序不弹窗、不整卡拖**：`PendingTaskReorderView.vue`（弹窗式重排）在 web 端已无引用，
   连同 `TimelineCard` 的整卡 `pointerdown` 拖动一起，被**内嵌排序面板**取代 ——
   卡头「调整顺序」主动进入。拖动分两级：
   - **整组**（组头行最右的 ≡）：拖动单位是按目的地折叠的**目的地组**
     （`views/session/destinationGroups.ts`），组内恒为「通勤 → 活动」；
   - **组内先后**（活动行最右的 ≡）：调同一地点内多件事的次序，范围不出本组。
   两个手柄右对齐成一列，靠尺寸（28 / 22）与样式（虚线框 / 无框淡色）区分层级。
   松手后先展示影响再点「完成」保存，保存后可「撤销」。
2. **保存会重算路线**：顺序一变，每段通勤的出发地按新前驱重写（`applyCommuteRoutes`），
   时长随之更新；Swift 侧无此行为。故 `applyCommuteRoutes` 不进跨端等价性检查。

**组内重排为什么不用改 core**：`DestinationGroupPlan.moveIDs` 恒为 `[通勤, 活动…]` 拼接，
组内 `activities` 换序即自动反映到提交的 ids；且组的出发地与目的地都没变，
`replanCommutes` 判定 `changed = false` → 纯本地、零网络请求。

**视图层禁止**：直接 import `core/`（一律经 Pinia store）；直接触碰 `platform/`（一律经 store）。

### 4b.4 提醒文案单一来源

应用内弹窗与系统通知必须共用同一文案生成函数（放 `core/`），逐字复刻 `ReminderScheduler` 的 8 个里程碑（−10/−5/−3/−1/0/+2/+4/+6 分钟）与每任务一条的措辞。禁止在视图与 platform 各写一份。

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

WebView 前台只有在 Vue 提醒引擎通过 `notifications.foregroundReady` 明确声明 ready 后才抑制系统横幅；冷启动 attach 前、页面加载失败、导航重载或 Web 内容进程终止时必须恢复系统横幅兜底，避免页内通道不可用时静默漏提醒。

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
