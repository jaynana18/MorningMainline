# 跨端一致性测试规格（CROSS_PLATFORM_TEST_SPEC）

> 目的：把现有 Swift 单元测试与排程/解析代码提炼为**跨端一致性规格**，供将来的 TS / Web 版逐条对照，确保 Web 版重写的业务逻辑（排程算法、状态机、解析规则）与 Swift 版行为完全一致。
>
> 来源（只读提取，未修改任何文件）：
> - 测试：`Tests/RoutineModelsTests.swift`（656 行，**44 个测试函数**）
> - 被测实现：`Shared/Models/RoutineModels.swift`、`Shared/Services/RoutineParsingService.swift`、`Shared/Services/RemoteRoutineParsingService.swift`、`Shared/Store/RoutineStore.swift`
>
> 说明：测试文件本身只覆盖 `RoutineModels` 与解析两层；`RoutineStore` 的状态机、缓冲语义、revision 冲突裁决在测试文件中**没有直接用例**，但在代码里是明确的产品不变式。本规格第 3 节把这些不变式也列为「必守断言」（Web 必须复现），其未覆盖部分在第 4 节「覆盖盲区」中给出建议用例。

---

## 1. 测试用例总表

| # | 函数名 | 覆盖的行为点 | 输入（原文照抄 / session 构造） | 期望输出（精确值） | 分类标签 |
|---|--------|--------------|--------------------------------|--------------------|----------|
| 1 | `testMorningRoutineHasAnActualDepartureDeadline` | 默认「上班早晨」模板存在真实出门截止节点；缓冲为固定值 | `RoutineTemplate.morning`（deadlineHour=8, deadlineMinute=35, buffer=600s, recurrence=.daily, 6 步，末步 `出门` role=deadline） | `deadlineStep.title == "出门"`；`deadlineStep.importance == .hardDeadline`；`buffer == 600` | 边界 |
| 2 | `testBackwardRoutineCalculatesStartFromDeadlineAndBuffer` | 倒推：计划开始 = 截止 − 总任务时长 − 固定缓冲 | 锚点 `2026-08-13 07:00`（gregorian, 本地时区）+ `RoutineTemplate.morning` | deadline 时刻 = 当日 `08:35`（hour=8, minute=35）；`start − deadline == −2100s`（= −35min = 25min 任务 + 10min 缓冲） | 排程倒推 |
| 3 | `testPassedDeadlineRollsOnlyDailyTemplateToTomorrow` | 截止时刻已过时，仅「每天」模板顺延到明天，「单次」保留当日 | 锚点 `2026-08-14 12:00`；`morning`（daily）与 `morning` 改 `recurrence=.once` | daily.deadline 的 `day == 15`；once.deadline 的 `day == 14` | 边界 |
| 4 | `testQuickParserOnlyBuildsTaskSteps` | 规则解析只产出任务步骤，截止表达式被剥离 | `"博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分"` | titles `["博兴任务","去厕所","App安装"]`；durations `[1200,300,300]`；全部 `role == .task` | 规则解析 |
| 5 | `testOldTemplateWithoutRecurrenceDefaultsToOnce` | 旧快照缺 `recurrence` 字段的 Codable 兼容 | `morning.homework` 编码后删除 `recurrence` 再解码 | `decoded.effectiveRecurrence == .once` | 边界 |
| 6 | `testQuickTemplateUsesExplicitDeadlineAndRecurrence` | 显式截止 + 重复方式组装模板 | `"博兴任务20分钟 去厕所5分钟 App安装5分钟"`，deadline=`2026-08-13 18:10`，recurrence=.daily | `deadlineHour==18`；`deadlineMinute==10`；`effectiveRecurrence==.daily`；`taskSteps.count==3`；`deadlineStep?.title=="完成"` | 规则解析 |
| 7 | `testQuickTemplateWithoutDeadlineUsesForwardTiming` | 无截止 → 顺排模式，无截止节点 | `"语文2小时 英语1小时 数学30分钟"`，deadline=nil，recurrence=.once | `mode==.forward`；`deadlineHour==nil`；`deadlineMinute==nil`；`deadlineStep==nil`；titles `["语文","英语","数学"]` | 规则解析 |
| 8 | `testOverdueSessionKeepsDeadlineLastAndEstimatesCompletion` | 已逾期会话：预计时间按 now 重新顺排、deadline 恒在末位 | `now=epoch 10000`；`target=now−600`；3 个未完成项：first(5min,dueAt=target)、second(5min,dueAt=target+300)、deadline(0min,role=deadline,dueAt=target+300)；`activeProgressID=nil` | `estimates[first]==now+300`；`estimates[second]==now+600`；`estimatedCompletion==now+600`；`isLate==true` | 状态机迁移 |
| 9 | `testOldProgressWithoutNewTimingFieldsStillDecodes` | 旧 `StepProgress` 缺新字段的兼容与默认值 | `StepProgress(step:"旧任务",5min,dueAt=epoch 20000)` 编码后删 `plannedDueAt`/`remainingDuration`/`startedAt` 再解码 | `originalDueAt==epoch 20000`；`remainingWork==300`；`state==.pending` | 边界 |
| 10 | `testRuleOutcomeIsCompleteWhenEveryDurationIsConsumed` | leftover 为空即规则读全 | `"博兴任务20分钟  去厕所5分钟"` | titles `["博兴任务","去厕所"]`；`leftover==""`；`isComplete==true` | 规则解析 |
| 11 | `testRuleOutcomeReportsLeftoverWhenSomethingIsNotUnderstood` | 未读懂片段进入 leftover | `"去厕所5分钟 别忘了倒垃圾"` | titles `["去厕所"]`；`leftover=="别忘了倒垃圾"`；`isComplete==false` | 规则解析 |
| 12 | `testDeadlineExpressionIsNotCountedAsLeftover` | 截止表达式不被算作未读懂 | `"去厕所5分钟 截止时间18点10分"` | titles `["去厕所"]`；`leftover==""`；`deadline != nil` | 规则解析 |
| 13 | `testTimeAnchorWordsAreNotCountedAsLeftover` | 时间在前的锚点词不污染 leftover，且能读出 | 锚点 `2026-08-13 06:00`；`"去厕所5分钟 8点出门"` | titles `["去厕所"]`；`leftover==""`；deadline hour=8, minute=0 | 截止时间推断 |
| 14 | `testRuleReadsTrailingDeadlineFromCanonicalExample` | 规范示例端到端：3 任务 + 时间在前的截止 | 锚点 `2026-08-13 12:00`；`"18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟"` | titles `["去厕所","刷杯子","买水果"]`；`isComplete==true`；deadline hour=18, minute=30 | 截止时间推断 |
| 15 | `testPipelineResolvesCanonicalDeadlineWithoutEnhancedPath` | 纯规则管线（无增强）必须直接拿到截止 | 锚点 `2026-08-13 12:00`；`RoutineParsingPipeline().parse("18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟")` | `deadline` hour=18, minute=30；`steps.count==3` | 截止时间推断 |
| 16 | `testInferredDeadlineUnderstandsHalfHour` | 「半点」归一化：四种语序均得 :30 | 锚点 `2026-08-13 12:00`；`assertDeadline`：`"出门10点半"`、`"结束8点半"`、`"8点半出门"`、`"18点半结束"` | `10:30`、`8:30`、`8:30`、`18:30` | 截止时间推断 |
| 17 | `testInferredDeadlineRegressionCoversBothWordOrders` | 锚点在前 / 时间在前两种语序回归 | 锚点 `2026-08-13 12:00`；11 条：`"结束18:10"`,`"结束 18:10"`,`"截止8:35"`,`"结束18点10分"`,`"出门10点"`,`"去厕所5分钟 结束8:35"`,`"18点30结束，去厕所5分钟"`,`"8点出门"`,`"18:30结束"`,`"18点30分结束"`,`"18点结束"` | `18:10`,`18:10`,`8:35`,`18:10`,`10:00`,`8:35`,`18:30`,`8:00`,`18:30`,`18:30`,`18:00` | 截止时间推断 |
| 18 | `testInferredDeadlineIgnoresPlainTaskDurations` | 普通任务时长不得被误判为截止 | 锚点 `2026-08-13 12:00`；`"买水果10分钟"`,`"去厕所5分钟 刷杯子2分钟"`,`"7点起床，洗脸5分钟"` | `nil`,`nil`,`nil` | 截止时间推断 |
| 19 | `testPipelineSkipsEnhancedServiceWhenRuleIsComplete` | 规则读全则不调用增强（零成本短路） | `parse("去厕所5分钟")`，enhanced=RecordingParsingService | `result.source==.rule`；`recorder.callCount==0` | 冲突裁决 |
| 20 | `testPipelineFallsBackToRuleWhenEnhancedThrows` | 增强抛错 → 回退规则 | `parse("去厕所5分钟 别忘了倒垃圾")`，enhanced=Stub(shouldThrow:true) | `source==.rule`；titles `["去厕所"]` | 冲突裁决 |
| 21 | `testPipelineAdoptsEnhancedResultWhenItFindsMoreSteps` | 增强任务数严格更多 → 整体采用 | 输入同 20；enhanced 返回 2 步 `[去厕所5min, 倒垃圾2min]` | `source==.enhanced`；titles `["去厕所","倒垃圾"]` | 冲突裁决 |
| 22 | `testPipelineKeepsRuleResultWhenEnhancedFindsNoMoreSteps` | 任务数持平（模型更少）→ 保留规则步骤 | 输入同 20；enhanced 返回 1 步 `[别的60s]` | `source==.rule`；titles `["去厕所"]` | 冲突裁决 |
| 23 | `testPipelineAbsorbsEnhancedDeadlineWhenStepCountTies` | 任务数持平但规则无 deadline → 吸收增强 deadline | 锚点 `2026-08-13 18:30`；输入 `"去厕所5分钟 别忘了倒垃圾"`；enhanced 返回 1 步 + deadline=`2026-08-13 18:30` | `source==.enhanced`；titles `["去厕所"]`（保留规则步骤）；`deadline==2026-08-13 18:30` | 冲突裁决 |
| 24 | `testRemotePayloadDecodesPlainJSON` | 云端宽松解析：标准字段 | `{"steps":[{"title":"去厕所","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}` | titles `["去厕所"]`；first.minutes==5；deadlineHour==8；deadlineMinute==35 | 规则解析 |
| 25 | `testRemotePayloadSurvivesMarkdownFenceAndExtraPreamble` | 剥 markdown 围栏 + 容忍前后废话 | `"好的，这是解析结果：\n```json\n{\"steps\":[{\"title\":\"刷牙\",\"durationMinutes\":3}],\"deadlineHour\":null,\"deadlineMinute\":null}\n```\n需要我调整吗？"` | titles `["刷牙"]`；`deadlineHour==nil` | 规则解析 |
| 26 | `testRemotePayloadAcceptsDurationAsString` | 时长写成数字字符串 | `{"steps":[{"title":"洗脸","durationMinutes":"5"}]}` | first.minutes==5 | 规则解析 |
| 27 | `testRemotePayloadAcceptsInventedFieldNamesFromRealResponse` | 实测自创字段名（tasks/name/duration_minutes/time） | `{"tasks":[{"name":"去厕所","duration_minutes":5},{"name":"刷杯子","duration_minutes":2},{"name":"出门","time":"08:30"}]}` | titles `["去厕所","刷杯子"]`；minutes `[5,2]`；deadlineHour==8；deadlineMinute==30；`steps.count==2`（末项只有时刻→截止节点） | 规则解析 |
| 28 | `testRemotePayloadAcceptsBareArrayRoot` | 根是裸数组 | `[{"title":"刷牙","durationMinutes":3}]` | titles `["刷牙"]` | 规则解析 |
| 29 | `testRemotePayloadTreatsTrailingClockOnlyItemAsDeadline` | 末项只有时刻无时长 → 当作 deadline，不生成任务 | `{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}` | titles `["洗脸"]`；deadlineHour==8；deadlineMinute==30（「半」补 30） | 截止时间推断 |
| 30 | `testRemoteDeadlineAcceptsMergedClockFieldOnRoot` | 顶层合成字段 `deadline:"08:30"` | `{"steps":[{"title":"洗脸","durationMinutes":5}],"deadline":"08:30"}` | deadlineHour==8；deadlineMinute==30 | 截止时间推断 |
| 31 | `testRemotePayloadWithoutAnyTaskFallsBackToRules` | 只有截止时刻、无任何任务 → 返回 nil | `{"steps":[{"title":"出门","time":"8点半"}]}` | `decodePayload(...) == nil` | 规则解析 |
| 32 | `testRemotePayloadKeepsMidListTaskThatCarriesAClock` | 夹在中间的时刻只是描述，任务须保留 | `{"steps":[{"title":"7点起床","time":"7:00"},{"title":"洗脸","durationMinutes":5}]}` | titles `["7点起床","洗脸"]` | 规则解析 |
| 33 | `testRemotePayloadKeepsTaskWithoutDurationUsingFallback` | 缺时长 → fallbackMinutes=5 | `{"steps":[{"title":"倒垃圾"},{"title":"洗脸","durationMinutes":5}]}` | titles `["倒垃圾","洗脸"]`；first.minutes==`RemoteRoutineParsingService.fallbackMinutes`(=5) | 规则解析 |
| 34 | `testRemotePayloadRejectsEmptyStepList` | 空步骤列表 → nil | `{"steps":[]}` | `decodePayload(...) == nil` | 边界 |
| 35 | `testRemotePayloadRejectsGarbage` | 非 JSON / 空串 → nil | `"我不知道该怎么拆"`、`""` | 均 `nil` | 边界 |
| 36 | `testDurationStringUnitsAreHonoured` | 时长字符串单位换算 | `"5分钟"`,`"2小时"`,`"90秒"`,`"30min"`,`"没写"` | `5`,`120`,`1.5`,`30`,`nil` | 规则解析 |
| 37 | `testRemoteDeadlineIgnoresOutOfRangeValues` | 云端 deadline 越界拒绝 / minute 缺省补 0 | `now=Date()`；`makeDeadline(25,0)`、`(8,70)`、`(nil,30)`、`(8,nil)` | `nil`、`nil`、`nil`、非 `nil` | 截止时间推断 |
| 38 | `testChatCompletionsURLNormalizesBaseURL` | base URL 归一化 | `"https://gpt.cosmoplat.com/v1"`、`".../v1/"`、`".../v1/chat/completions"` | 均归一为 `"https://gpt.cosmoplat.com/v1/chat/completions"`（去尾斜杠、不重复拼接） | 边界 |
| 39 | `testCosmoMindConfigurationTargetsInternalGateway` | cosmoMind 默认配置 | `Configuration.cosmoMind(apiKey:"sk-test")` | endpoint `"https://gpt.cosmoplat.com/v1/chat/completions"`；model `"cosmo-mind-coder"`；`usesJSONMode==true`；`retriesWithoutOptionalFields==true`；`thinkingDisable==.none` | 边界 |
| 40 | `testThinkingDisableStylesProduceDistinctFields` | 思考关闭样式枚举完备 | `ThinkingDisableStyle.allCases` | 含 `.enableThinking`、`.chatTemplateKwargs`、`.thinkingTypeDisabled`；`.none.bodyEntries` 为空 | 边界 |
| 41 | `testOnlyRequestShapeErrorsTriggerDegradedRetry` | 仅请求形状错误触发降级重试 | `isRejectedRequest(400/422/401/429/500)` | `true`,`true`,`false`,`false`,`false` | 边界 |
| 42 | `testBodyVariantsShrinkFromFullestToSimplest` | 请求体变体由全到简排列 | `Configuration(..., usesJSONMode:true, thinkingDisable:.chatTemplateKwargs)` | 4 个变体依次：`(json:true,chatTemplateKwargs)`, `(json:true,none)`, `(json:false,chatTemplateKwargs)`, `(json:false,none)` | 边界 |
| 43 | `testBodyVariantsSkipThinkingWhenNotEnabled` | thinking=.none 时不产生多余变体 | `Configuration(..., usesJSONMode:true, thinkingDisable:.none)` | 2 个变体：`(json:true,none)`, `(json:false,none)` | 边界 |
| 44 | `testBodyVariantsAlwaysIncludeMinimalFallback` | 两个开关都关 → 单一最简变体，无重复 | `Configuration(..., usesJSONMode:false, thinkingDisable:.none)` | `[.init(json:false, thinkingDisable:.none)]` | 边界 |

> 分类计数：规则解析 15 · 截止时间推断 9 · 排程倒推 1 · 状态机迁移 1 · 冲突裁决 6 · 边界 12（合计 44）。

---

## 2. 时间基准与时区规格

### 2.1 断言锚点的构造方式（全部来自测试与实现）

| 锚点类型 | 构造代码 | 出现位置 | 时区语义 |
|----------|----------|----------|----------|
| 本地日历日 + 具体时刻 | `Calendar(identifier: .gregorian)` + `calendar.date(from: DateComponents(year:2026, month:8, day:13, hour:H, minute:M))` | 测试 2/3/6/13/14/15/16/17/18/23 | **未显式指定 timeZone** → 取 `TimeZone.current`（运行机器时区）。2026-08-13 是固定日期。 |
| 常用锚点时刻 | `2026-08-13 06:00 / 07:00 / 12:00`；滚动测试用 `2026-08-14 12:00`；`assertDeadline` 统一用 `2026-08-13 12:00` | 同上 | 同上 |
| 绝对 epoch（秒） | `Date(timeIntervalSince1970: 10_000)` / `20_000` | 测试 8/9 | 与本地时区无关的绝对量 |
| 相对偏移 | `now.addingTimeInterval(±seconds)` | 测试 2/8/23 | 纯秒数运算，时区无关 |
| 截止时刻求解 | `calendar.date(bySettingHour:minute:second:of:)`（默认参数 `.nextTime` / `.first` / `.forward`） | `RoutineTemplate.deadline(on:)`、`QuickRoutineParser.inferredDeadline`、`RemoteRoutineParsingService.makeDeadline` | **同一日历日内设定时分，不跨日滚动**（见 §2.2 关键点） |
| 读回断言 | `calendar.component(.hour/.minute/.day, from:)` | 测试 2/3/13/14/15/16/17 | 用同一个 calendar 读回，内部自洽 |

### 2.2 JS `Date` 复现时的漂移点与 Web 端等价实现约束

**漂移点 1 —— 时区未钉死（最高风险）。**
`Calendar(identifier: .gregorian)` 不指定 `timeZone`，实际使用运行机器的 `TimeZone.current`。所有「读回 `.hour/.minute/.day`」的断言都依赖这个本地时区。JS 里 `new Date(2026, 7, 13, 12, 0)` 用的是**浏览器本地时区**；若 Web 测试环境时区与 Swift 基准机器不同，则所有含本地日构造 + 读回 component 的断言会整体偏移，且偏移不固定（跨日边界还会改 `.day`）。

- **Web 约束 W1**：一致性测试必须钉死时区，与 Swift 基准一致。建议统一用 `Asia/Shanghai`（UTC+8）。Node 侧在 `jest.config`/`vitest` 里设 `process.env.TZ = 'Asia/Shanghai'`，或所有时间工具函数强制注入固定 IANA 时区；浏览器 E2E 用 Playwright/`--tz` 固定。**禁止**任何排程/解析测试依赖宿主默认时区。

**漂移点 2 —— `date(bySettingHour:)` 语义 ≠「找下一个该时刻」。**
由测试 3 可反推：`now = 2026-08-14 12:00`，`deadline(on:)` 先算当日 `08:35`（早于 now），随后 `guard today < date` 判断——若它跨日滚动到 08-15，则 `.once` 分支也会得到 day=15，但测试断言 `.once → day===14`。**故 `date(bySettingHour:)` 返回的是「同一日历日的该时分」，不跨日。** 之后再由 `effectiveRecurrence` 决定是否 `+1 day`。

- **Web 约束 W2**：等价实现必须是「在同一天上设定时分」，即 `d.setHours(h, m, 0, 0)`（保留年/月/日），**不得**自行实现「搜索 >= 给定时刻的下一个 h:m」的算法，否则测试 3 的 `.once` 语义（过期不滚动）会被破坏。滚动到次日只能由 `recurrence === 'daily'` 分支显式 `+1 day` 完成。

**漂移点 3 —— 夏令时（DST）边界。**
`date(bySettingHour:)` 默认 `matchingPolicy=.nextTime`、`repeatedTimePolicy=.first`、`direction=.forward`：目标时刻落在 DST 春季跳变的**不存在区间**时向前归一（如 02:30 → 03:00）；落在秋季回拨的**重复区间**时取第一次出现。JS `setHours` 对不存在的本地时刻也会向前归一，对重复时刻多数引擎取第一次，语义**大体一致但边界不保证逐秒相同**。

- **Web 约束 W3**：基准时区选无 DST 的 `Asia/Shanghai`（1991 年后无 DST），2026 年范围内可完全规避该问题。若未来支持有 DST 的时区，必须为「不存在时刻」与「重复时刻」各自固定策略并单独加测试；生产逻辑统一用「本地日历日 + setHours」并在 DST 缺口处显式声明归一方向。

**漂移点 4 —— 默认参数注入的 `Calendar.current`。**
`RoutineTemplate.deadline(on:)`、`QuickRoutineParser.inferredDeadline/analyze/makeTemplate`、`RemoteRoutineParsingService.makeDeadline` 的 `calendar` 均默认 `.current`。测试因显式传入 `Calendar(identifier: .gregorian)` 而绕开了默认值，但生产路径用了默认值。

- **Web 约束 W4**：时间相关函数必须**显式接受注入的时区/日历参数**（生产可默认本地，测试必须注入固定时区），不得在函数体内隐式读取全局 `new Date()` 的本地时区。

**漂移点 5 —— epoch 与毫秒。**
测试 8/9 用 `Date(timeIntervalSince1970: 10_000 / 20_000)`（秒）。JS `Date.getTime()` 单位是毫秒。

- **Web 约束 W5**：Swift `timeIntervalSince1970`（秒）↔ JS `getTime()/1000`（毫秒）需在边界统一换算；断言用同一基准比较，避免 1000 倍误差。

**漂移点 6 —— 数值/文本的 locale 无关性。**
测试全部用 gregorian 且不依赖 locale 文本；`Int(text)`、`firstNumber`、`normalize(key:)` 均按 Unicode 字母/数字处理。

- **Web 约束 W6**：「点半」归一化、`[零〇一二三四五六七八九十两]` 中文数字、时长单位解析都必须是纯字符串/整数运算，**不得**走 `Intl.NumberFormat` 等会受 locale 影响的路径。注意「点30」替换后字符串变长，取值必须统一用归一后的串（Swift 注释已警示混用会导致 Range 错位）。

### 2.3 逐条断言的时刻取值（供 Web 直接抄成期望值）

- 倒推基准：`morning` 总任务时长 = 3+5+10+2+5 = **25min（1500s）**；buffer = **10min（600s）**；`start = deadline − 2100s`。以 08:35 为截止 ⇒ 开始 **08:00**。
- `2026-08-13 07:00` 起点 ⇒ morning deadline = **2026-08-13 08:35**。
- `2026-08-14 12:00`（已过 08:35）⇒ daily deadline = **2026-08-15 08:35**；once deadline = **2026-08-14 08:35**。
- `assertDeadline` 全部锚在 `2026-08-13 12:00`（本地时区），仅比对时分（`%d:%02d`），不比日期，因此对时区偏移不敏感于日期、但敏感于时区本身。
- epoch 用例：`now=10000` ⇒ 预计完成 `10600`（now+600s）；`isLate=true`（`targetDeadline=9400 < 10600`）。

---

## 3. 跨端一致性必守断言清单

> 编号 M1–M28。每条都是 Web 版**必须逐条复现**的行为；标注「已覆盖」的来自 44 个测试，「代码不变式」来自 `RoutineStore` 等实现（测试文件中无直接用例，Web 仍必须一致）。

### A. 排程倒推公式与缓冲语义

- **M1（排程倒推｜已覆盖，测试 2）** 倒推计划开始 = `Deadline − totalTaskDuration − buffer`。morning：`08:35 − 25min − 10min = 08:00`，即 `start − deadline === −2100s`。
- **M2（排程倒推｜代码不变式，`RoutineTemplate.totalTaskDuration`）** `totalTaskDuration` 只累加 `role === .task` 的时长；`role === .deadline` 节点（duration=0）不计入。
- **M3（排程倒推｜代码不变式，`RoutineStore.start` / `consumeDelay`）** **缓冲不可被延误挪用**：`remainingBuffer` 初始化为 `selectedBuffer`（`max(0, override ?? template.buffer)`），`consumeDelay` 只平移未完成项的 `dueAt`，**永不修改 `remainingBuffer`**，也不从缓冲里扣任何秒数。
- **M4（排程倒推｜代码不变式，`RoutineStore.consumeDelay`）** 延误是整条时间线后移：对 `index ≥ 起点` 且未完成的项 `dueAt += seconds`，**绝不前移**。

### B. 截止时间识别（规则层 `inferredDeadline`）

- **M5（截止时间推断｜已覆盖，测试 17）** **时间在前语序**逐条相等：`18点30结束→18:30`、`8点出门→8:00`、`18:30结束→18:30`、`18点30分结束→18:30`、`18点结束→18:00`。
- **M6（截止时间推断｜已覆盖，测试 17）** **锚点在前语序**逐条相等：`结束18:10→18:10`、`结束 18:10→18:10`、`截止8:35→8:35`、`结束18点10分→18:10`、`出门10点→10:00`、`去厕所5分钟 结束8:35→8:35`。
- **M7（截止时间推断｜已覆盖，测试 16）** **「半点」归一化**：仅把固定组合「点半」替换为「点30」（任务名里的其他「半」不受影响）。`出门10点半→10:30`、`结束8点半→8:30`、`8点半出门→8:30`、`18点半结束→18:30`。
- **M8（截止时间推断｜已覆盖，测试 17）** 分钟缺省补 0：`8点出门→08:00`、`出门10点→10:00`、`18点结束→18:00`。
- **M9（截止时间推断｜已覆盖，测试 18）** 普通任务时长不得误判为截止：`买水果10分钟→nil`、`去厕所5分钟 刷杯子2分钟→nil`、`7点起床，洗脸5分钟→nil`。（区分点：时间在前写法要求小时后必须跟「点/: /：」。）
- **M10（截止时间推断｜已覆盖，测试 14/15）** 截止表达式不进入 `leftover`，规范输入 `18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟` 的 `isComplete === true`，且 `steps.count === 3`（不吞任务也不多任务）。
- **M11（截止时间推断｜代码不变式）** 越界拒绝：`hour ∉ 0…23` 或 `minute ∉ 0…59` ⇒ 返回 `nil`（`inferredDeadline` 与 `makeDeadline` 同规则）。

### C. 解析规则与模板组装

- **M12（规则解析｜已覆盖，测试 4/6/7）** 任务正则 `([^|\d]+?)\s*(\d+(?:\.5)?)\s*(小时|h|H|分钟|分)`：小时 ×3600、分钟 ×60；标题剔除 `然后/再/先` 并去空白与 `|`；`duration > 0 && !title.isEmpty` 才产出。
- **M13（规则解析｜已覆盖，测试 6/7）** 有 deadline ⇒ `mode = backward` 且追加一个 `title="完成", duration=0, importance=hardDeadline, role=deadline` 节点，`deadlineHour/Minute` 取自该 deadline 的时分；无 deadline ⇒ `mode = forward` 且不追加节点。
- **M14（规则解析｜代码不变式，`makeTemplate`）** 命名规则：单步用其标题；多步用「`首步标题`等 `N` 项」。
- **M15（边界｜已覆盖，测试 5/9）** 旧数据兼容：模板缺 `recurrence` ⇒ `effectiveRecurrence === .once`；`StepProgress` 缺 `plannedDueAt`/`remainingDuration`/`startedAt` ⇒ `originalDueAt = dueAt`、`remainingWork = step.duration`、`state = .pending`。
- **M16（边界｜已覆盖，测试 3）** 截止时刻已过：`daily → +1 天同刻`；`once → 保留当日`（过期不自动改明天）。

### D. 状态机与预计时间（`RoutineSession` / `RoutineStore`）

- **M17（状态机迁移｜已覆盖，测试 8）** `estimatedDueDates`：只对未完成 `role === .task` 计算；若存在 `activeProgressID` 则 active 项排在最前；无 active 时 `cursor = now` 顺排 `remainingWork`；`active` 项 `estimated = max(dueAt, now)`；**deadline 项 `estimated = max(cursor, now)`（随实际推进变化，不被原计划卡住）**。
- **M18（状态机迁移｜已覆盖，测试 8）** `estimatedCompletion` = 未完成 `deadline` 节点的估计；无 deadline 节点时为最后一个未完成 `.task` 的估计。
- **M19（状态机迁移｜已覆盖，测试 8）** `isLate = estimatedCompletion > targetDeadline`；无 `targetDeadline` 或无法估计 ⇒ `false`。
- **M20（状态机迁移｜代码不变式，`RoutineStore.complete`）** **末尾 Deadline 节点在排程里自动完成**：当最后一项 `role === .task` 完成、且剩余未完成项只有 `deadline` 节点时，把所有未完成 `deadline` 置为 `.completed`（`completedAt=now`, `remainingDuration=0`），`session.state = .completed`，**不再要求用户二次点击**。
- **M21（状态机迁移｜代码不变式，`RoutineStore.start/activate/suspend/resume`）** 进入任务线**不等于**开始计时：只有 `start(progress:)` 后才有 `activeProgressID`；开始新任务会挂起当前任务（`remainingDuration = dueAt − now` 入栈），完成后按栈恢复最近挂起任务，无挂起才顺延下一项。

### E. 跨端冲突裁决

- **M22（冲突裁决｜代码不变式，`RoutineStore.apply`）** **revision 冲突裁决**：仅当 `incoming.originID !== 本机 deviceID` **且**（`incomingRevision > currentRevision` **或** `incoming.updatedAt > snapshot.updatedAt`）时才接受远端快照；否则丢弃。`originID === 本机` 直接忽略（忽略自己发出的回声）。
- **M23（冲突裁决｜已覆盖，测试 19）** 规则读全（`isComplete === true`）⇒ 直接返回 `source === .rule`，**不调用 enhanced**（`callCount === 0`，零模型调用/零成本）。
- **M24（冲突裁决｜已覆盖，测试 20）** enhanced 抛错 / 超时 / 未接入 ⇒ 回退规则结果（`source === .rule`）。
- **M25（冲突裁决｜已覆盖，测试 21/22）** `enhanced.steps.count > rule.steps.count` ⇒ 整体采用 enhanced（`source === .enhanced`）；数量**不严格多于** ⇒ 保留规则步骤（`source === .rule`）。
- **M26（冲突裁决｜已覆盖，测试 23）** 任务数持平且 `rule.deadline === nil` 且 `enhanced.deadline !== nil` ⇒ 保留规则步骤、**吸收 enhanced 的 deadline**，`source === .enhanced`。

### F. 云端宽松解析与降级重试

- **M27（冲突裁决｜已覆盖，测试 24–37）** 云端宽松解析全规则：字段名归一（`normalize(key)` 忽略大小写与下划线，snake_case ≡ camelCase）；容器/任务名/时长/时刻各走候选键；**末项只有时刻无时长 ⇒ 该时刻当作 deadline、不生成任务**；夹在中间的时刻只是描述、任务保留；顶层 `{deadlineHour, deadlineMinute}` 或合成 `{deadline:"08:30"}` 优先于末项时刻；缺时长 ⇒ `fallbackMinutes = 5`；时长字符串单位（`5分钟→5`、`2小时→120`、`90秒→1.5`、`30min→30`）；无任务/空列表/垃圾输入 ⇒ `nil`；`clock` 识别 `08:30`/`8点30`/`8点半`/数字 `830`/`{hour,minute}`（「半」补 30）；越界拒绝。
- **M28（冲突裁决 + 边界｜已覆盖，测试 38–44）** 降级重试与配置：**仅 400/422 触发去掉额外字段重试**，401/429/5xx **不重试**直接回退；`bodyVariants` 由「最全 → 最简」排列、最简档必须在最后、去重（两开关都关时仅 1 个变体）；base URL 归一（去尾斜杠、补 `/chat/completions`、已含不重复）；`cosmoMind` 默认（endpoint `https://gpt.cosmoplat.com/v1/chat/completions`、model `cosmo-mind-coder`、`usesJSONMode=true`、`thinkingDisable=.none`、`retriesWithoutOptionalFields=true`）。

**必守断言条数：28 条**（A 排程倒推 4 · B 截止识别 7 · C 规则/模板/兼容 5 · D 状态机 5 · E 冲突裁决 5 · F 云端解析与降级重试 2 = 28）。

---

## 4. 覆盖盲区清单

> 下列为 Web 版会**新增或改变**的交互，现有 Swift 测试**没有覆盖**。每条给出建议新增用例（输入 + 期望）。Web 版一致性验收应先补齐这些，否则跨端行为漂移无从拦截。

- **G1 手动改截止时间后重算。** 现象：iOS 创建页改为「生成后带出截止时间并可手改」。
  - 输入：解析 `18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟` 生成模板后，用户把截止改为 `19:00`。
  - 期望：`mode` 保持 `backward`；`deadlineHour/Minute = 19/00`；**已解析步骤不清空**（titles 仍为三项）；倒推开始 = `19:00 − 12min(=720s) − buffer`；预测预览即时刷新。
- **G2 无截止时间时的排程行为。** 现象：`makeTemplate` 无 deadline 走 forward，但执行期/预计完成的组合行为无测试。
  - 输入：模板 `"语文2小时 英语1小时 数学30分钟"`（无 deadline），`start` 于 `2026-08-13 12:00`。
  - 期望：`mode=forward`；`deadlineStep=nil`；`targetDeadline=nil`；起始 `cursor=now`；三项 `dueAt` 依次 `14:00 / 15:00 / 15:30`；`estimatedCompletion` = 最后未完成 task 的估计；`isLate=false`（无 targetDeadline）。
- **G3 生成后重新生成。** 现象：用户改输入后再次生成。
  - 输入：先 `"去厕所5分钟"` 生成一次，再 `"去厕所5分钟 刷杯子2分钟 截止18点30"` 生成一次。
  - 期望：第二次**整体替换**上一次结果，步骤数 2、deadline 18:30；不残留上一次的 deadline 节点或步骤；旧模板 UUID 不覆盖内置默认模板 UUID。
- **G4 云端解析失败回退到纯规则。** 现象：`decodePayload` 返回 nil 时管线回退。
  - 输入：enhanced 返回不可解析内容（如 `"我不知道该怎么拆"`）→ `decodePayload === nil`；管线输入 `"去厕所5分钟 别忘了倒垃圾"`。
  - 期望：`RemoteRoutineParsingService.parse` 返回 `nil`；管线 `source === .rule`、titles `["去厕所"]`、`leftover !== ""`；UI 不出现空模板、不报错。
- **G5 网络超时。** 现象：`Configuration.timeout` 默认 8s。
  - 输入：enhanced 请求耗时 > 8s（模拟 `URLSession` 超时抛错）。
  - 期望：抛错被管线吞掉 → 回退规则结果；创建流程不卡住；有可观测日志（`RemoteRoutineParsingService.log`）；总响应时间约等于规则耗时。
- **G6 跨端 revision 冲突裁决（M22 无直接测试）。**
  - 输入：本机 `snapshot.updatedAt = T2`，收到 `originID≠本机` 的 `incoming.updatedAt = T1 < T2` 且 `revision` 持平。
  - 期望：丢弃 incoming，本机快照不变。反向（`revision+1` 或 `updatedAt` 更新）⇒ 接受 incoming。`originID === 本机` ⇒ 忽略。
- **G7 缓冲不可被延误挪用（M3/M4 无直接测试）。**
  - 输入：backward 模板（deadline 08:35、buffer 10min），先 `snoozeCurrent()`（+120s），再插入 `addTemporaryTask(minutes:5, .afterCurrent)`。
  - 期望：`remainingBuffer` 恒为 600s（不被扣减）；被影响项 `dueAt` 分别精确 `+120s` / `+300s`；预计完成整体后移，绝不前移。
- **G8 末尾 Deadline 自动完成（M20 无直接测试）。**
  - 输入：3 项任务 + 1 个 deadline 节点的会话，逐项 `complete`，完成最后一项实际任务。
  - 期望：所有未完成 deadline 节点变 `.completed`；`session.state = .completed`；无需再点「完成」。
- **G9 提前完成后的重新顺排。**
  - 输入：任务 A 预计 12:00 完成，用户在 11:50 提前完成。
  - 期望：后续未完成项从**真实完成时刻**起顺排（`cursor=now`），而非被原 `plannedDueAt` 卡住；`estimatedCompletion` 相应提前；`targetDeadline` 不变（仅作对比）。
- **G10 临时任务插入两种 placement。**
  - 输入：`addTemporaryTask(title:"接电话",minutes:5,placement:.now)` 与 `.afterCurrent` 各一次。
  - 期望：`.now` ⇒ 挂起当前任务、临时项置顶且 `state=.active`、其后未完成项整体 +300s；`.afterCurrent` ⇒ 插在当前任务之后、当前任务不受打断、其后项 +300s；`isTemporary=true`。
- **G11 挂起/恢复栈。**
  - 输入：任务 A active → 开始任务 B（A 挂起）→ 完成任务 B。
  - 期望：A 恢复到 `.active`，`remainingDuration = 原剩余`；完成后若栈空才顺延下一项；`suspendedProgressIDs` 顺序正确。
- **G12 重排未完成项 `reorderPendingTasks(ids:)`。**
  - 输入：三个待办 id 乱序传入，且集合与可重排集合完全一致。
  - 期望：重排后 `dueAt` 按新顺序重算；集合不一致（含 active 或缺失项）⇒ 整体拒绝、快照不变。
- **G13 会话内删除任务 `deleteFromCurrentSession`。**
  - 输入：删除当前 active 项 / 删除普通 pending 项。
  - 期望：只改本次会话不改模板；删除 active 项后恢复挂起任务或顺延下一项；`dueAt` 重算；全部完成 ⇒ `state=.completed`。
- **G14 时区/夏令时钉死（§2 约束 W1–W3）。**
  - 输入：同一组「本地日 + 读回时分」断言，在 `TZ=Asia/Shanghai` 与 `TZ=UTC` 下各跑一次。
  - 期望：只有钉死时区的那次全绿；据此证明 Web 测试必须固定时区，且 `date(bySettingHour:)` 必须实现为「同日 setHours」而非「下一个时刻」。
- **G15 云端 deadline 的 minute 缺省与「半」。**
  - 输入：`makeDeadline(hour:8, minute:nil, on:now)`；以及末项 `{"title":"出门","time":"8点半"}`。
  - 期望：`minute` 缺省补 0，得 `08:00`；`8点半` ⇒ `08:30`（不得被截成 08:00）。
- **G16 中文数字时长（规则层无测试）。**
  - 输入：`"去厕所五分钟 刷杯子两分钟"`，以及 `"半个西瓜20分钟"`（「半」在任务名里）。
  - 期望：时长分别为 `5min`/`2min`；任务名里的「半」不参与归一化、标题保留原样；`"一个半"` 按提示词语义应为 90（若规则层支持则须对齐）。

**覆盖盲区条目数：16 条**（其中 G1–G5 为任务要求必含项，G6–G16 为代码不变式与跨端高风险的补充项）。

---

## 5. 验收结论摘要

- 测试函数总数：**44**。
- 必守断言：**28** 条（编号 M1–M28）。
- 覆盖盲区：**16** 条（编号 G1–G16）。
- 跨端高危项（Web 必须优先实现）：M1–M4（倒推与缓冲）、M5–M11（截止识别两语序 + 半点）、M20（末尾 Deadline 自动完成）、M22（revision 冲突裁决）、W1–W6（时区/`date(bySettingHour:)`/epoch 毫秒/中文数字 locale 无关）。
