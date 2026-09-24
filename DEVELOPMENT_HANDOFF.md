# MorningMainline（不跑偏）开发交接

## 项目定位

面向容易被临时事项打断的用户的任务线 App。用户先选定一条主线，再按步骤执行；App 持续给出当前任务、预计结束时间、Deadline 对比和提醒。支持 iPhone、iPad、Apple Watch，以及 iOS 主屏和 Watch 表盘小组件。

> 本文以当前代码为准。`README.md` 中“延误优先消耗缓冲”的旧描述已经不适用。

## 工程与 Target

项目由 [project.yml](project.yml) 管理，可使用 XcodeGen 重新生成工程；当前 `MorningMainline.xcodeproj` 也已提交。

| Target | 目录 | 用途 |
| --- | --- | --- |
| `MorningMainline` | `iOS/` + `Shared/` | iPhone / iPad 主 App，最低 iOS 17 |
| `MorningMainlineWatch` | `Watch/` + `Shared/` | Apple Watch App，最低 watchOS 10 |
| `MainlineiOSWidget` | `iOSWidget/` + `Shared/Widget/` | iOS 主屏 Widget |
| `MainlineWatchWidget` | `WatchWidget/` + `Shared/Widget/` | Watch complication |
| `MorningMainlineTests` | `Tests/` | 模型与时间规则单测 |

入口文件：

- iPhone/iPad：[iOS/MorningMainlineApp.swift](iOS/MorningMainlineApp.swift)
- Watch：[Watch/MorningMainlineWatchApp.swift](Watch/MorningMainlineWatchApp.swift)
- iPhone/iPad UI：[iOS/ContentView.swift](iOS/ContentView.swift)
- Watch UI：[Watch/WatchRoutineView.swift](Watch/WatchRoutineView.swift)

## 核心数据与状态流

模型均在 [Shared/Models/RoutineModels.swift](Shared/Models/RoutineModels.swift)。

- `RoutineTemplate`：可复用任务线；包含模式、默认 Deadline、固定预留缓冲和步骤。
- `RoutineStep`：单个步骤。`role == .task` 为实际任务，`role == .deadline` 为最终计划锚点。
- `StepProgress`：一次执行中的步骤状态、原计划时间（`plannedDueAt`）、当前预计时间（`dueAt`）、剩余时长等。
- `RoutineSession`：一次任务线执行。`targetDeadline` 是原 Deadline 对比基准；`estimatedCompletion(at:)` 是随实际执行更新的预计结束时间。
- `RoutineSnapshot`：模板与当前会话的可同步快照。

业务状态集中在 [Shared/Store/RoutineStore.swift](Shared/Store/RoutineStore.swift)。UI 不直接修改模型，应调用 `RoutineStore` 的公开方法：

- `start(_:deadlineOverride:bufferOverride:)`：启动一条任务线。
- `start(_ progress:)`：明确开始某个任务；进入任务线本身不自动开计时。
- `complete(_:)`：完成当前任务。
- `snoozeCurrent()`：延后两分钟。
- `addTemporaryTask(...)`：插入临时任务。
- `reorderPendingTasks(ids:)`、`deleteFromCurrentSession(_:)`、`cancel()`。

## 当前时间规则（重要）

1. 倒推任务线按“最终 Deadline - 固定预留缓冲 - 全部任务时长”生成计划开始时间。
2. 预留缓冲是固定机动时间，不会被延后或临时加事扣减，也不应在执行页高调展示。
3. 每次延后或插入临时任务，后续任务和预计结束时间整体后移。
4. 提前完成任务后，后续步骤的预计时间会基于真实完成时刻重新顺排；不会被原计划时间卡住。
5. `targetDeadline` 永远保留作“提前 / 延误”对比基准；`dueAt` / `estimatedCompletion` 表示当前预计。
6. 当最后一个实际任务完成时，最后的 `deadline` 节点会自动完成，不再要求用户额外点击“完成”。

改动排程时，请同时检查：

- `RoutineStore.consumeDelay(in:startingAt:seconds:)`
- `RoutineStore.recalculateExpectedSchedule(in:now:)`
- `RoutineSession.estimatedDueDates(at:)`
- `RoutineSession.estimatedCompletion(at:)`

## 一句话创建

解析入口分两层：`RoutineParsingPipeline`（调度）与 `QuickRoutineParser`（本机规则）。

### 调度层（Shared/Services/RoutineParsingService.swift）

界面只依赖 `RoutineParsingService` 协议，不直接调用具体实现。接入大模型时只改 `RoutineParsing.current.enhanced` 一处，iPhone / iPad / Watch 一起生效。

- `RuleRoutineParsingService`：本机正则，毫秒级、零成本、离线可用。是所有输入的第一道，也是大模型不可用时的最后一道兜底。
- `RoutineParsingPipeline.parse`：规则完整吃下输入就直接返回，**不发请求、不花钱**；只有 `leftover` 非空（规则只读懂一部分）才交给 `enhanced`。任务数以「严格多于」为准择优：`enhanced` 找到的任务**严格多于**规则才整体采用；数量持平说明模型没多读出东西，保留规则那份更快、更确定的答案。**数量持平且规则没读出截止时间时，额外吸收模型解析出的 `deadline`**——两个来源互补：规则锚点词正则读不出「18点30结束」这类时间在前的写法，模型能；但模型一旦多读出任务就整体采用它，不再走这条互补分支。
- `enhanced` 未接入、抛错或超时：一律回退规则结果，绝不让创建流程卡住。

### 云端实现（Shared/Services/RemoteRoutineParsingService.swift）

已在 `MorningMainlineApp.configureRoutineParsing()` 中启用，接的是公司内网网关（`https://gpt.cosmoplat.com/v1`，模型 `cosmo-mind-coder`）。也支持阿里云百炼的 qwen 系列，用 `Configuration.dashScope` 替换即可。

```swift
RoutineParsing.current.enhanced = RemoteRoutineParsingService(
    configuration: .cosmoMind(apiKey: RemoteRoutineParsingService.Configuration.apiKeyFromEnvironment())
)
```

要点：

- 用的是兼容 OpenAI Chat Completions 字段格式的网关。这只是请求/响应字段的通用约定，不等于用 OpenAI 的模型。
- **该网关已实测可用**（`cosmo-mind-coder`，底层 `deepseek-flash`）：支持 `response_format: json_object`，返回纯 JSON 无 markdown 围栏；能正确把「八点半出门」解析成截止时间——注意这句没有「截止/结束」这类锚点词，**规则层识别不到、模型识别到了**，这正是增强路径存在的意义。
- **Key 不入库**：按「环境变量 `COSMO_MIND_API_KEY` → Info.plist 的 `CosmoMindAPIKey`」顺序读取。默认做法是配在 **Xcode scheme 的 Run → Arguments → Environment Variables** 里（`Product → Scheme → Edit Scheme…`，快捷键 ⌘<），零代码改动且不进版本库——`.gitignore` 已忽略 `*.xcscheme`。
  - ⚠️ **scheme 环境变量只在 Xcode Run 启动时注入**。手机上从主屏点图标启动读不到，表现为「模型没生效」。调试时必须 ⌘R 启动。`parse` 里对此加了提示日志。
  - 要在真机上脱离 Xcode 也能用，走 xcconfig：gitignore 的 `.xcconfig` 定义 Key → build setting → Info.plist 引用 `$(COSMO_MIND_API_KEY)`，需同步改 `project.yml` 并重跑 `xcodegen generate`。
  - 生产环境应让 `apiKey` 保持 nil，改由自建代理注入凭据。
- **网关默认开启思考链，且忽略 `enable_thinking: false`**。两次实测：一次 `completion_tokens` 386 其中 `reasoning_tokens` 347；另一次 **790 其中 751**——加了 `enable_thinking: false` 之后思考量反而更高，说明该字段**通过校验后被静默丢弃**，不报错也不生效。正确写法未知，所以做成 `ThinkingDisableStyle` 四个候选（`none` / `enable_thinking` / `chat_template_kwargs` / `thinking:{"type":"disabled"}`），默认 `.none` 保住已验证路径：
  ```swift
  configuration: .cosmoMind(apiKey: ..., thinkingDisable: .chatTemplateKwargs)
  ```
  改完在 Xcode 控制台看 `reasoningTokens` 是否归零，没归零就再换一个候选。
- **模型会自创字段名**。实测返回过 `{"tasks":[{"name":...,"duration_minutes":...,"time":"08:30"}]}`，而不是提示词里写的 `{"steps":[{"title":...,"durationMinutes":...}]}`。严格按 schema 解码会直接失败 → 解析返回 nil → 管线静默回退规则，用户只看到「模型没生效」、没有任何报错。所以 `decodePayload` 不认死字段名：容器名、任务名、时长、时间都走候选列表，且键名比较忽略大小写与下划线（`duration_minutes` ≡ `durationMinutes`）。
- **额外字段一律逐级降级**。请求体按「最全 → 最简」排列若干变体（`bodyVariants`），服务端返回 400/422 就去掉一层再试，最后一定能落到「只有提示词约束」这一档。这样不需要事先确认网关支持哪些字段。
- 401 / 429 / 5xx **不会**触发降级重试——去掉字段也解决不了鉴权、限流和服务端故障，直接回退规则更快。
- 提示词里必须出现 “JSON” 字样。这是 OpenAI 系 json_object 模式的硬性要求，百炼同样如此。**本网关已实测会拦**：消息里没有该字样时返回 `400 invalid_request_error: Prompt must contain the word 'json' in some form`。所以 `systemPrompt` 第一行的「并以 JSON 返回」不能删。万一误删，400 会触发降级去掉 `response_format` 重试，不会彻底失效，但会白绕一轮。
- 返回内容做了宽松解析：能剥 markdown 围栏、能容忍 JSON 前后的多余话、能接受裸数组根、能接受时长写成字符串或带单位的中文串。解析失败即抛错回退规则。
- **末项「只有时刻没有时长」当作截止节点**（「八点半出门」→ deadline 8:30，不生成一项 5 分钟的「出门」）；夹在中间的时刻只是任务描述，任务照常保留。
- DEBUG 下会把 token 用量打到控制台（`logUsage`），这是确认思考链到底关掉没有的唯一窗口。
- 思考内容走 `reasoning_content` 字段，与 `content` 分开，不影响解析。
- `temperature` 固定为 0，让同一段输入稳定出同一份结果。
- 超时（默认 8 秒）即回退规则。创建流程绝不能因为网络卡住。
- 没给出时长的任务按 5 分钟兜底，宁可留一项待用户改，也不要丢掉这个任务。

后续接大模型（云端或端侧）的约束：

- 模型输出只能用来产出 `[RoutineStep]` + `deadline`，**模板形状（截止节点、倒推模式、命名）统一由 `QuickRoutineParser.makeTemplate(steps:deadline:recurrence:)` 组装**，不要在别处重复实现。
- **不要把 API Key 写进 App**，`strings` 就能扒出来。上线应指向自建反向代理（把 `apiKey` 设为 `nil`，由代理注入真实 Key 并做限流），代理必须 HTTPS，否则 iOS ATS 会拒绝。
- Apple Watch 无法使用端侧模型（Foundation Models 不支持 watchOS）。Watch 端目前仍走纯本机规则，未接入云端；如需接入，可考虑在 Watch 入口做同样的配置，但要留意手表网络请求的耗电。

### 本机规则层（QuickRoutineParser）

- 支持阿拉伯数字与中文数字时长，例如：`去厕所五分钟，刷杯子两分钟`。
- 中英文逗号、顿号、句号、分号或无分隔连续输入均可识别任务时长。
- `结束 18:10`、`结束18点10分`、`出门 10点`、`截止 8:35`，以及**时间在前的** `18点30结束`、`8点出门` 等都会由 `inferredDeadline(from:)` 识别为最终 Deadline（两种语序都认；时间在前时分钟可缺省，按 0 分计）。`点半` 会归一成 `点30`，所以 `出门10点半`、`18点半结束` 也识别为 10:30 / 18:30（归一化只针对「点半」组合，不影响任务名里的「半」）。
- Watch 创建页仍监听文本输入，识别到上述表达后会自动打开并更新截止时间控件（常驻选择器）。
- iPhone/iPad 创建页不再常驻截止时间选择器：先解析生成任务线，识别到截止时间时在生成后带出并打开开关、由用户手改，没识别到则保持关闭。
- `analyze(from:)` 一次返回任务、Deadline 和 `leftover`（没被读懂的部分）；`leftover` 既用于判断要不要交给大模型，也便于排查规则盲区。

目前仅支持常见的“任务名 + 时长”规则解析；不要把任务名称里的普通数字直接当作时长或 Deadline。

## 平台 UI 约定

### iPhone / iPad

`ContentView.swift` 是同一套页面代码。iPad 宽屏的执行中页面会左右分栏，iPhone 使用纵向堆叠。

- 当前视觉：奶油底、天蓝主卡、圆润字体、粗实线漫画描边。
- 执行中的“计划影响”突出 **预计结束**，同时显示原 Deadline 供对比。
- 预留缓冲收在默认关闭的“计划详情”中，不作为可拖延额度展示。
- 未开始任何任务时右上角是“返回”，直接取消本次任务线；已开始后才显示“结束”并二次确认。
- 一句话创建页：截止时间不再常驻。表单顺序为「输入文案 → 重复方式 → 生成任务线」，生成成功后下方才出现「截止时间」区（默认关闭；解析出截止时间则打开并填入）和「预览」区。改截止时间或重复方式会即时重算模板，**不会清空已解析的步骤**（预览里也不再重复展示截止时间）。
- 自动完成任务线后出现完成结果悬浮卡，展示提前/延误、原计划与完成时间。
- 倒推计划预览可选“本次计划”（可改 Deadline 和固定缓冲）或“按原计划进入”；原计划即使已过期也允许进入，并正常计算延误。

### Apple Watch

- Watch 端以紧凑执行页为主，保留实时倒计时、开始/完成、延后两分钟、临时加事和任务列表。
- Watch 选中任务线后直接按模板默认 Deadline 与缓冲启动，等价于 iPhone 的“按原计划进入”；目前没有“本次计划”参数调整页面。
- 未开始任务时显示“返回”并直接退出；完成后显示精简结果悬浮卡。
- 执行页不直接展示预留缓冲。

## 同步、通知与 Widget

### iPhone ↔ Watch 同步

[Shared/Services/ConnectivityService.swift](Shared/Services/ConnectivityService.swift) 使用 `WatchConnectivity` 发送完整 `RoutineSnapshot`：

- 优先 `updateApplicationContext` 保持最新快照。
- 可达时同时 `sendMessage`；不可达或失败时用 `transferUserInfo` 兜底。
- `RoutineStore` 用 `revision` 与 `updatedAt` 决定是否接受远端快照。

当前没有启用 iCloud 跨 iPhone/iPad 最终同步；两台 iOS 设备可分别使用本地数据。

### 本地通知

[Shared/Services/ReminderScheduler.swift](Shared/Services/ReminderScheduler.swift)：

- 为未完成普通任务按 `dueAt` 注册一次提醒。
- 为最终 `targetDeadline` 注册 -10/-5/-3/-1/0/+2/+4/+6 分钟的时效提醒。
- Watch 使用系统通知声音/触感；iPhone 逾期提醒使用 `iOS/Resources/deadline-overdue.aiff`。
- 通知会在每次 `RoutineStore.commit()` 后重新替换。

### Widget

[Shared/Services/AppGroupSharedStore.swift](Shared/Services/AppGroupSharedStore.swift) 将精简的 `MainlineWidgetSnapshot` 写到 App Group `group.com.jaynana.MorningMainline`；Widget 从中读取当前任务、预计完成、延误等展示数据。不要让 Widget Target 依赖完整 `RoutineSnapshot`。

## 本地持久化与兼容性

- 主快照通过 `UserDefaults` 保存，key：`morning-mainline.local-snapshot.v2`。
- 模型中新增字段应尽量做成可选或带默认值，以兼容旧本地快照的 `Codable` 解码。
- 不要清理用户本地数据，也不要随意修改默认任务线固定 UUID。

## 开发注意事项

1. 共享模型、`RoutineStore` 的改动通常会同时影响 iPhone、iPad、Watch 和 Widget 数据；先确认是否应为跨端规则。
2. 平台特定 API 必须用 `#if os(watchOS)` / `#if os(iOS)` 隔离，Shared 目录会被多个 Target 编译。
3. 不要把“预留缓冲”重新实现成可消耗余额；这是当前产品语义的关键。
4. 不要把最后的 `deadline` 步骤重新做成必须手动完成的按钮。
5. iPhone/iPad 视觉调整集中在 `ContentView.swift`；Watch 保持信息紧凑，避免为了对齐视觉而破坏倒计时和任务列表路径。
6. 如需重新生成工程，执行 `xcodegen generate` 后再打开 `MorningMainline.xcodeproj`；不必为了普通 UI/逻辑修改每次都重新生成。

## 建议的接手顺序

1. 先阅读 `RoutineModels.swift` 和 `RoutineStore.swift`，理解计划与预计时间。
2. 再查看 `ContentView.swift` / `WatchRoutineView.swift` 的平台差异。
3. 涉及同步、通知或小组件时再进入对应 `Shared/Services`、`Shared/Widget` 文件。
4. 修改时间规则时补充 `Tests/RoutineModelsTests.swift`，覆盖提前完成、延后、临时加事和最终 Deadline 场景。
