# LOGIC_PORT_SPEC.md — 业务逻辑 Swift → TypeScript 移植规格

> 目的：把 iOS/iPad 端的**纯业务逻辑**（模型、解析、状态机、同步裁决）翻译成可直接施工的 TypeScript 规格。
> Apple Watch 端保留原生 Swift，不动。Web 端与原生端必须能互相读懂对方的快照，因此**序列化契约是硬约束**。
>
> 本文档只读代码、只写规格：**不修改任何 .swift 文件，也不写 TS 实现代码**，只给「签名 + 语义 + 锚点用例」。
>
> 权威来源（按优先级）：
> 1. `Tests/RoutineModelsTests.swift`（44 个测试函数）— 行为规格的最终仲裁者。
> 2. `Shared/Models/RoutineModels.swift`、`Shared/Store/RoutineStore.swift`。
> 3. `Shared/Services/RoutineParsingService.swift`、`Shared/Services/RemoteRoutineParsingService.swift`。
>
> 「锚点用例」= 从 Tests 里摘出的具体输入/期望值，移植后必须逐条复现。

---

## 0. 序列化契约（跨端互通前提，务必先读）

Web 与原生通过 JSON 快照互通（WCSession / iCloud KV / 未来 HTTP）。Swift 的 `Codable` 默认行为与本规格强绑定，移植时**必须逐条对齐**，否则两端解码会静默失败或数值错位。

| 规则 | Swift 默认行为 | TS 侧必须做的处理 |
| --- | --- | --- |
| **Key 命名** | 属性名原样（camelCase），无 `CodingKeys` 时 = 属性名 | 除 `ChatCompletion` 传输结构外，**一律用属性名的 camelCase 原名**：`primaryDevice`、`plannedDueAt`、`activeProgressID`、`suspendedProgressIDs`、`deadlineHour`… |
| **Date 编码** | `JSONEncoder` 默认 `.deferredToDate` → **`Double`，单位=秒，基准=2001-01-01T00:00:00Z**（Apple 参考日期，**不是 Unix epoch**） | 直接 `new Date(sec * 1000)` 会差约 978307200 秒（≈31 年）。必须 `epochMs = (refSeconds + 978307200) * 1000`；反向 `refSeconds = epochMs/1000 - 978307200`。**这是本移植最大的坑。** |
| **UUID** | 字符串，**大写**带连字符（`5E43ED14-458A-49CF-8673-A96DCA196001`） | 比较时统一大小写（建议全部 `toLowerCase()` 或全 `toUpperCase()`），不要假定小写。 |
| **TimeInterval** | `Double`，单位=秒 | 直接当秒数 number，不要当毫秒。 |
| **enum** | `String` rawValue（如 `"backward"`、`"hardDeadline"`、`"afterCurrent"`） | 用 string union，值见第 1 节枚举表。 |
| **Optional 缺省** | Swift 自动合成的 `Codable` 对 Optional **使用 `encodeIfPresent`：为 nil 时「省略整个键」，不是写成 `null`**。 | 解码时把「键缺失」与显式 `null` **都当 undefined** 处理（见 `effectiveRecurrence` 等兼容旧数据逻辑）。 |
| **数组可选** | `suspendedProgressIDs: [UUID]?` 为 nil 时**省略该键**（非 `null`） | 视作 `undefined`，读时用 `?? []`。 |
| **方向不对称（实测事实）** | TS `encodeSnapshot` 对 nil 写**显式 `null`**，Swift 对 nil **省略键** | 二者均可被对方解码（Swift `decodeIfPresent` 接受 null 与缺键；TS 把缺键与 null 都当 undefined），故互通无碍；但两端字节形态不一致，将来若做字节级 diff / 签名需注意。 |
| **`.distantPast` 哨兵值** | `Date.distantPast` = Apple 参考秒 −63114076800 → Unix 毫秒 **−62135769600000**（**不等于** 0001-01-01T00:00:00Z 的 −62135596800000，差 2 天） | TS 常量必须用 −62135769600000。该值参与冲突裁决的 `updatedAt` 比较。 |

**旧数据兼容要求**（Tests 已经有专门用例，移植后必须复现）：
- `RoutineTemplate.recurrence` 可能整键缺失 → `effectiveRecurrence` 必须回落到 `"once"`。
- `StepProgress.plannedDueAt / remainingDuration / startedAt` 可能整键缺失 → `originalDueAt` 回落 `dueAt`、`remainingWork` 回落 `step.duration`、`state` 回落 `"pending"`。

---

## 1. 可移植类型清单

命名约定：TS 类型名尽量与 Swift 同名（PascalCase）。标注：`?` = optional（JSON 可能为 null）；`默认=` = 构造时给默认值。

### 1.1 枚举

#### `DeviceRole : string` — JSON key 为字段名 `primaryDevice` 时取此值
| Swift case | TS 字面量 |
| --- | --- |
| phone | `"phone"` |
| pad | `"pad"` |
| watch | `"watch"` |

#### `StepImportance : string`
| Swift case | TS 字面量 |
| --- | --- |
| normal | `"normal"` |
| hardDeadline | `"hardDeadline"` |

#### `StepRole : string`
| Swift case | TS 字面量 |
| --- | --- |
| task | `"task"` |
| deadline | `"deadline"` |

#### `ScheduleMode : string`
| Swift case | TS 字面量 | 语义 |
| --- | --- | --- |
| forward | `"forward"` | 从 now 顺排 |
| backward | `"backward"` | 从截止时间倒排 |

#### `RoutineRecurrence : string`（CaseIterable）
| Swift case | TS 字面量 | title |
| --- | --- | --- |
| once | `"once"` | `"单次"` |
| daily | `"daily"` | `"每天"` |

#### `TemporaryTaskPlacement : string`（CaseIterable, Identifiable；**注意：非 Codable，不落盘**，仅 UI/入参用途）
| Swift case | TS 字面量 | title | detail |
| --- | --- | --- | --- |
| now | `"now"` | `"立即做"` | `"先暂停当前任务，做完马上回到主线。"` |
| afterCurrent | `"afterCurrent"` | `"当前任务后"` | `"先完成正在做的事，再执行这项临时任务。"` |

#### `StepState : string`
| Swift case | TS 字面量 | isIncomplete |
| --- | --- | --- |
| pending | `"pending"` | true |
| active | `"active"` | true |
| suspended | `"suspended"` | true |
| completed | `"completed"` | false |
| skipped | `"skipped"` | false |

#### `SessionState : string`
| Swift case | TS 字面量 |
| --- | --- |
| running | `"running"` |
| completed | `"completed"` |
| cancelled | `"cancelled"` |

#### `RoutineParseSource : string`（**非 Codable**，仅内存态）
| Swift case | TS 字面量 | title |
| --- | --- | --- |
| rule | `"rule"` | `"本机识别"` |
| enhanced | `"enhanced"` | `"智能识别"` |

#### `ThinkingDisableStyle : string`（CaseIterable，见 §2 远程解析）
| Swift case | TS 字面量 |
| --- | --- |
| none | `"none"` |
| enableThinking | `"enableThinking"` |
| chatTemplateKwargs | `"chatTemplateKwargs"` |
| thinkingTypeDisabled | `"thinkingTypeDisabled"` |

---

### 1.2 模型结构体

#### `RoutineStep` — JSON key = 属性名
| 字段 | TS 类型 | JSON key | optional | 默认/说明 |
| --- | --- | --- | --- | --- |
| id | `string`(UUID) | `id` | 否 | 默认 `crypto.randomUUID()` |
| title | `string` | `title` | 否 | |
| prompt | `string` | `prompt` | 否（**编码后非空**） | 构造时 `prompt ?? "现在只做：\(title)"` |
| duration | `number`(秒) | `duration` | 否 | |
| importance | `StepImportance` | `importance` | 否 | 默认 `"normal"` |
| role | `StepRole` | `role` | 否 | 默认 `"task"` |

> 锚点：`RoutineStep(title:"洗脸", duration:5*60).prompt == "现在只做：洗脸"`。

#### `RoutineTemplate` — JSON key = 属性名
| 字段 | TS 类型 | JSON key | optional | 默认/说明 |
| --- | --- | --- | --- | --- |
| id | `string`(UUID) | `id` | 否 | |
| name | `string` | `name` | 否 | |
| symbol | `string` | `symbol` | 否 | SF Symbol 名 |
| mode | `ScheduleMode` | `mode` | 否 | |
| deadlineHour | `number` | `deadlineHour` | **是** | nil |
| deadlineMinute | `number` | `deadlineMinute` | **是** | nil |
| buffer | `number`(秒) | `buffer` | 否 | 默认 0 |
| recurrence | `RoutineRecurrence` | `recurrence` | **是** | 默认 `.once`；**旧数据可能缺键** |
| steps | `RoutineStep[]` | `steps` | 否 | |

内置模板（`RoutineTemplate.defaults = [morning, homework, ikea]`，id 为固定 UUID，可作移植自检）：

| 常量 | id | name | symbol | mode | deadline | buffer | recurrence | steps(标题/时长秒/importance/role) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `morning` | `5E43ED14-458A-49CF-8673-A96DCA196001` | 上班早晨 | `sun.max.fill` | backward | 8:35 | 600 | daily | 刷牙180 / 洗脸300 / 弄头发600 / 装午饭120 / 下楼300(hardDeadline) / 出门0(hardDeadline,deadline) |
| `homework` | `5E43ED14-458A-49CF-8673-A96DCA196002` | 写作业 | `book.closed.fill` | forward | nil | 0 | once | 语文7200 / 英语3600 / 数学1800 |
| `ikea` | `5E43ED14-458A-49CF-8673-A96DCA196003` | 去宜家 | `car.fill` | backward | 9:00 | 900 | once | 洗脸刷牙900 / 给安安喂早饭1200 / 安安穿衣服600 / 路上2400 / 到宜家0(hardDeadline,deadline) |

> 锚点：`morning.buffer == 600`；`morning.deadlineStep?.title == "出门"`；`morning.deadlineStep?.importance == .hardDeadline`；`morning.totalTaskDuration == 180+300+600+120+300 == 1500`。

#### `StepProgress` — JSON key = 属性名（**注意 `plannedDueAt`、`remainingDuration`、`startedAt`**）
| 字段 | TS 类型 | JSON key | optional | 默认/说明 |
| --- | --- | --- | --- | --- |
| id | `string`(UUID) | `id` | 否 | |
| step | `RoutineStep` | `step` | 否 | |
| dueAt | `Date`(ref秒) | `dueAt` | 否 | |
| state | `StepState` | `state` | 否 | 默认 `"pending"` |
| snoozeCount | `number` | `snoozeCount` | 否 | 默认 0 |
| completedAt | `Date?`(ref秒) | `completedAt` | **是** | nil |
| isTemporary | `boolean` | `isTemporary` | 否 | 默认 false |
| plannedDueAt | `Date?`(ref秒) | `plannedDueAt` | **是** | nil；「第一次生成计划时的完成时间，之后不随延误改写」 |
| remainingDuration | `number?`(秒) | `remainingDuration` | **是** | nil；为空时用 `step.duration` |
| startedAt | `Date?`(ref秒) | `startedAt` | **是** | nil |

> 兼容锚点（`testOldProgressWithoutNewTimingFieldsStillDecodes`）：删掉 `plannedDueAt/remainingDuration/startedAt` 后解码 → `originalDueAt == dueAt`、`remainingWork == 300`、`state == "pending"`。

#### `RoutineSession` — JSON key = 属性名（**注意 `primaryDevice`、`activeProgressID`、`suspendedProgressIDs`**）
| 字段 | TS 类型 | JSON key | optional | 默认/说明 |
| --- | --- | --- | --- | --- |
| id | `string`(UUID) | `id` | 否 | |
| templateID | `string`(UUID) | `templateID` | 否 | |
| templateName | `string` | `templateName` | 否 | |
| templateSymbol | `string` | `templateSymbol` | 否 | |
| startedAt | `Date`(ref秒) | `startedAt` | 否 | |
| plannedStartAt | `Date`(ref秒) | `plannedStartAt` | 否 | |
| targetDeadline | `Date?`(ref秒) | `targetDeadline` | **是** | |
| state | `SessionState` | `state` | 否 | |
| primaryDevice | `DeviceRole` | `primaryDevice` | 否 | |
| progress | `StepProgress[]` | `progress` | 否 | |
| remainingBuffer | `number`(秒) | `remainingBuffer` | 否 | |
| updatedAt | `Date`(ref秒) | `updatedAt` | 否 | |
| revision | `number` | `revision` | 否 | |
| activeProgressID | `string?`(UUID) | `activeProgressID` | **是** | 默认 nil；「只有点击某项开始后才会有当前任务」 |
| suspendedProgressIDs | `string[]?`(UUID) | `suspendedProgressIDs` | **是** | 默认 nil；**LIFO 栈**，记录需返回的挂起任务 |

#### `RoutineSnapshot` — JSON key = 属性名（**注意 `originID`**）
| 字段 | TS 类型 | JSON key | optional | 默认/说明 |
| --- | --- | --- | --- | --- |
| templates | `RoutineTemplate[]` | `templates` | 否 | |
| activeSession | `RoutineSession?` | `activeSession` | **是** | |
| updatedAt | `Date`(ref秒) | `updatedAt` | 否 | |
| originID | `string`(UUID) | `originID` | 否 | 跨端仲裁用，见 §4 |

> `RoutineSnapshot.initial = { templates: defaults, activeSession: null, updatedAt: .distantPast, originID: <new UUID> }`。
> `.distantPast` 编码为负的极大值（约 `-63113904000`）——数值比较可用，但若要构造「空快照」建议在 TS 侧用一个极小值常量（`Number.NEGATIVE_INFINITY` 亦可，但序列化需转回 `-63113904000` 以兼容原生解码）。

#### `MainlineWidgetSnapshot` — JSON key = 属性名（App Group 共享精简快照，Web 端若要复刻 Widget 才需）
| 字段 | TS 类型 | JSON key | optional | 默认 |
| --- | --- | --- | --- | --- |
| capturedAt | `Date?` | `capturedAt` | 是 | null |
| currentTitle | `string?` | `currentTitle` | 是 | null |
| currentDueAt | `Date?` | `currentDueAt` | 是 | null |
| originalDueAt | `Date?` | `originalDueAt` | 是 | null |
| isHardDeadline | `boolean` | `isHardDeadline` | 否 | false |
| estimatedCompletion | `Date?` | `estimatedCompletion` | 是 | null |
| isLate | `boolean` | `isLate` | 否 | false |
| delayDuration | `number?`(秒) | `delayDuration` | 是 | 0 |
| hasActiveSession | `boolean` | `hasActiveSession` | 否 | false |
| sessionName | `string?` | `sessionName` | 是 | null |

---

### 1.3 解析相关类型（**非 Codable，仅内存/服务层**，但 Web 端要复刻行为）

#### `QuickRoutineParser.ParseOutcome`
```ts
interface ParseOutcome {
  steps: RoutineStep[];
  deadline: Date | null;
  leftover: string;        // 未读懂残余文本，空 = 规则完整吃下
  readonly hasSteps: boolean;    // steps.length > 0
  readonly isComplete: boolean;  // leftover === ""
}
```

#### `RoutineParseResult`
```ts
interface RoutineParseResult {
  steps: RoutineStep[];
  deadline: Date | null;
  source: RoutineParseSource;
  leftover: string;
  readonly hasSteps: boolean;    // steps.length > 0
  readonly isComplete: boolean;  // leftover === ""
}
```

#### `RoutineParsingService`（协议 → TS interface）
```ts
interface RoutineParsingService {
  readonly source: RoutineParseSource;
  parse(input: string, now: Date): Promise<RoutineParseResult | null>; // 可抛错
}
```

#### `RoutineParsingPipeline`
```ts
interface RoutineParsingPipeline {
  rule: RoutineParsingService;                 // 默认 RuleRoutineParsingService
  enhanced: RoutineParsingService | null;      // 默认 null（纯规则）
  readonly hasEnhancedPath: boolean;           // enhanced != null
  parse(input: string, now?: Date): Promise<RoutineParseResult | null>;
}
```

#### `RemoteParsingConfiguration`（对应 `RemoteRoutineParsingService.Configuration`）
```ts
interface RemoteParsingConfiguration {
  endpoint: string;                 // 完整 chat completions URL
  apiKey: string | null;            // null = 由反向代理注入
  model: string;
  timeout: number;                  // 秒，默认 8
  usesJSONMode: boolean;            // 默认 true
  thinkingDisable: ThinkingDisableStyle; // 默认 "none"
  retriesWithoutOptionalFields: boolean; // 默认 true
  readonly bodyVariants: BodyVariant[];
}
```
工厂/静态方法见 §2。

#### `BodyVariant`
```ts
interface BodyVariant { usesJSONMode: boolean; thinkingDisable: ThinkingDisableStyle; }
// 相等比较：两字段都相等（对应 Swift Equatable）
```

#### `ParsedRoutinePayload` / `ParsedRoutineItem`
```ts
interface ParsedRoutineItem { title: string; minutes: number; }
interface ParsedRoutinePayload {
  steps: ParsedRoutineItem[];
  deadlineHour: number | null;
  deadlineMinute: number | null;
}
```

#### `RemoteParsingError`（对应 Swift enum，带 `errorDescription`）
```ts
type RemoteParsingError =
  | { kind: "invalidResponse" }
  | { kind: "httpStatus"; code: number }
  | { kind: "emptyContent" };
// 文案：invalidResponse→"服务返回了无法识别的响应。"；httpStatus→`服务返回状态码 ${code}。`；emptyContent→"服务返回了空内容。"
```

#### `ChatCompletion`（**传输结构，唯一使用 snake_case CodingKeys 的地方**）
```ts
interface ChatCompletion {
  choices: { message: { content: string | null } }[];
  usage: {
    completion_tokens?: number | null;              // key 就是 snake_case
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  } | null;
}
```
> 只有 `usage.completionTokens → "completion_tokens"`、`usage.details → "completion_tokens_details"`、`details.reasoningTokens → "reasoning_tokens"` 三处是显式改名，其余依旧 camelCase。

---

## 2. 可移植纯函数清单

> 所有返回 `Date` 的函数，Web 端统一用 JS `Date`；序列化时按 §0 转参考日期秒。`calendar` 参数在 Swift 里用于本地时区/历法；Web 端约定使用**浏览器本地时区**语义，`bySettingHour(h,m,s=0,of:)` 对应「在给定日期上把时钟设为 h:m:00 本地时间」。

### 2.1 QuickRoutineParser

#### `inferredDeadline(from: string, relativeTo: Date, calendar?) => Date | null`（Swift 名 `inferredDeadline`，也常被写作 `inferredDeadline(from:relativeTo:calendar:)`）
语义（必须守恒）：
- 先归一「半」：把 `点半` 替换为 `点30`（**只替换「点半」固定组合**，不影响「买半个西瓜」）。归一后长度变化，**后续所有匹配与取值必须基于归一文本**。
- 两种语序都要认：锚点词在前（`结束 18:10` / `出门 10 点`）与时间在前（`18点30结束` / `8点出门`）。
- 时间在前的写法，小时后必须跟 `点/: /：` 才认（与任务时长如「2分钟」区分），分钟可缺省 → 0。
- 命中后取 h:m，非法（h∉0..23 或 m∉0..59）返回 null；无匹配返回 null。

锚点（`testInferredDeadlineUnderstandsHalfHour` / `...RegressionCoversBothWordOrders` / `...IgnoresPlainTaskDurations`）：
| 输入 | 期望 |
| --- | --- |
| `"出门10点半"` | 10:30 |
| `"结束8点半"` | 8:30 |
| `"8点半出门"` | 8:30 |
| `"18点半结束"` | 18:30 |
| `"结束18:10"` | 18:10 |
| `"结束 18:10"` | 18:10 |
| `"截止8:35"` | 8:35 |
| `"结束18点10分"` | 18:10 |
| `"出门10点"` | 10:00 |
| `"去厕所5分钟 结束8:35"` | 8:35 |
| `"18点30结束，去厕所5分钟"` | 18:30 |
| `"8点出门"` | 8:00 |
| `"18:30结束"` | 18:30 |
| `"18点30分结束"` | 18:30 |
| `"18点结束"` | 18:00 |
| `"买水果10分钟"` | null |
| `"去厕所5分钟 刷杯子2分钟"` | null |
| `"7点起床，洗脸5分钟"` | null |

#### `analyze(from: string, relativeTo: Date, calendar?) => ParseOutcome`
= `{ steps: makeSteps(input), deadline: inferredDeadline(input,...), leftover: leftoverText(input) }`。
锚点：
- `"博兴任务20分钟  去厕所5分钟"` → titles `["博兴任务","去厕所"]`，leftover `""`，isComplete true。
- `"去厕所5分钟 别忘了倒垃圾"` → titles `["去厕所"]`，leftover `"别忘了倒垃圾"`，isComplete false。
- `"去厕所5分钟 截止时间18点10分"` → titles `["去厕所"]`，leftover `""`，deadline 非空。
- `"去厕所5分钟 8点出门"` → titles `["去厕所"]`，leftover `""`，deadline = 8:00。
- `"18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟"` → titles `["去厕所","刷杯子","买水果"]`，isComplete true，deadline = 18:30。

#### `makeSteps(from: string) => RoutineStep[]`
语义：
- `compact = input.trim()`；空返回 `[]`。
- 在 `normalizedSource(compact)` 上跑 `stepPattern`：`([^|\d]+?)\s*(\d+(?:\.5)?)\s*(小时|h|H|分钟|分)`。
- 每个匹配：title = 捕获1 去掉 `然后`/`再`/`先` 并 trim（含去 `|`）；number 为捕获2；unit 为捕获3；`duration = (unit=="小时" || unit.toLowerCase()=="h") ? number*3600 : number*60`；`duration>0 && title非空` 才产出 `RoutineStep(title, duration)`（role 默认 task）。
锚点：
- `"博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分"` → titles `["博兴任务","去厕所","App安装"]`，durations `[1200,300,300]`，全部 `role=="task"`。
- `"语文2小时 英语1小时 数学30分钟"` → titles `["语文","英语","数学"]`。
- `"去厕所5分钟 别忘了倒垃圾"` → `["去厕所"]`。
- `"18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟"` → `["去厕所","刷杯子","买水果"]`。

#### `normalizedSource(from: string) => string`（Swift 内 `private`，但语义是 makeSteps/leftover 的地基）
语义：
1. `replacingChineseDurationNumerals`：把紧挨时长单位的中文数字转成阿拉伯数字，正则 `([零〇一二三四五六七八九十两]+)\s*(?:个)?\s*(小时|分钟|分)`，从后往前替换为 `值+单位`。
2. 把「（可选前缀 截止时间/截止/完成时间/到期时间）\d{1,2}\s*(点|:|：)\s*\d{0,2}\s*分?」整体替换为 `|`。
3. 把中文标点 `；，,。、` 全部替换为 `|`。
锚点（间接，经 makeSteps）：`"…截止时间18点10分"` 中的截止表达被切成 `|`，故不会进入任务。

#### `leftoverText(from: string) => string`（Swift 内 `private`）
语义：
1. 空输入 → `""`。
2. 在 `normalizedSource(compact)` 上把 `stepPattern` 匹配内容替换为空。
3. 删除所有 `|`。
4. 删除锚点词 `结束 / 出门 / 截止 / 完成 / 到期`（时间锚点不是任务，切碎后不算没读懂）。
5. 首尾 trim（含 `，,。；;、|`）。
锚点：
- `"博兴任务20分钟  去厕所5分钟"` → `""`。
- `"去厕所5分钟 别忘了倒垃圾"` → `"别忘了倒垃圾"`。
- `"去厕所5分钟 截止时间18点10分"` → `""`。
- `"去厕所5分钟 8点出门"` → `""`。

#### `makeTemplate(from: string, deadline: Date | null, recurrence: RoutineRecurrence, calendar?) => RoutineTemplate | null`
= 先用 `makeSteps`，`deadline ?? inferredDeadline(input)`，转调重载。

#### `makeTemplate(steps: RoutineStep[], deadline: Date | null, recurrence: RoutineRecurrence, calendar?) => RoutineTemplate | null`
语义（模板形状的唯一规范处）：
- `steps = rawSteps.filter(role=="task")`；空 → `null`。
- `name = steps.length==1 ? steps[0].title : \`${steps[0].title}等 ${steps.length} 项\``。
- `deadline == null` → `RoutineTemplate{ name, symbol:"list.bullet.clipboard.fill", mode:"forward", recurrence, steps }`（**deadlineHour/Minute 不设 → null，无 deadline step**）。
- 有 deadline → 追加 `deadlineStep = RoutineStep{ title:"完成", prompt:"按计划完成，不再临时开新任务", duration:0, importance:"hardDeadline", role:"deadline" }`，模板 `mode:"backward"`，`deadlineHour = hour(deadline)`，`deadlineMinute = minute(deadline)`，`steps = steps + [deadlineStep]`。
锚点：
- `makeTemplate(steps from "博兴任务20分钟 去厕所5分钟 App安装5分钟", deadline=2026-08-13 18:10, .daily)` → `deadlineHour==18`、`deadlineMinute==10`、`effectiveRecurrence=="daily"`、`taskSteps.length==3`、`deadlineStep?.title=="完成"`、mode backward。
- `makeTemplate(steps from "语文2小时 英语1小时 数学30分钟", deadline=null, .once)` → `mode=="forward"`、`deadlineHour==null`、`deadlineMinute==null`、`deadlineStep==null`、`taskSteps` titles `["语文","英语","数学"]`。

#### `replacing(pattern: string, in: string, with: string) => string`（私有工具；正则全局替换）
#### `replacingChineseDurationNumerals(in: string) => string`（私有工具；见上）
#### `chineseNumber(text: string) => number | null`
语义：字符映射 `零/〇=0 一=1 二/两=2 三..九`；遇 `十` → `total += max(1,current)*10; current=0`；遇到非映射非「十」字符 → null；返回 `total+current`。
锚点（语义自检）：`"十"`→10、`"十五"`→15、`"二十"`→20、`"三"`→3。

### 2.2 RoutineTemplate（计算属性/方法）

#### `get effectiveRecurrence(t): RoutineRecurrence` → `t.recurrence ?? "once"`
锚点：`homework` 去掉 `recurrence` 键解码后 `effectiveRecurrence == "once"`。

#### `get deadlineStep(t): RoutineStep | undefined` → 首个 `role=="deadline"`。
#### `get taskSteps(t): RoutineStep[]` → `steps.filter(role=="task")`。
#### `get totalTaskDuration(t): number` → `taskSteps.reduce(0, (a,s)=>a+s.duration)`。
锚点：`morning.totalTaskDuration == 1500`。

#### `deadline(t, date: Date, calendar?): Date | null`
语义：
- 若 `deadlineHour==null || deadlineMinute==null` → `null`。
- `today = 在 date 当日 设 h:m:00 的 Date`。
- `today >= date` → 返回 `today`。
- 否则（已过）：`effectiveRecurrence=="daily"` → `today + 1 天`；否则（once）→ 返回 `today`（保留过期，不悄悄改明天）。
锚点：
- `morning.deadline(on: 2026-08-13 07:00)` → 当日 08:35（hour 8, minute 35）。
- `morning.deadline(on: 2026-08-14 12:00)` → 次日 08:35（day 15，daily）。
- 同 now，`once` 版 → 当日 08:35（day 14）。
- 由 morning dsl 推导：`deadline - start == 35*60`（total 1500 + buffer 600 = 2100）。

### 2.3 StepState

#### `get isIncomplete(s): boolean` → `s ∈ {pending, active, suspended}`。

### 2.4 StepProgress

#### `get originalDueAt(p): Date` → `p.plannedDueAt ?? p.dueAt`。
#### `get remainingWork(p): number` → `Math.max(0, p.remainingDuration ?? p.step.duration)`。
锚点：删掉三个新字段解码后：`originalDueAt == dueAt`、`remainingWork == 300`。

### 2.5 RoutineSession（**核心计算属性，移植重点**）

#### `get deadlineProgress(s): StepProgress | undefined` → 首个 `step.role=="deadline"`。
#### `get expectedDeadline(s): Date | null` → `deadlineProgress?.dueAt ?? s.targetDeadline ?? null`。
#### `estimatedDueDates(s, at: Date): Map<string, Date>`（Swift `estimatedDueDates(at:)`）
语义：
```
cursor = at
for item of orderedIncompleteTasks(s):      // 见下，正序、active 提到最前
  if item.state == "active":
     estimated = max(item.dueAt, at)
  else:
     estimated = cursor + remainingWork(item)
  result[item.id] = estimated
  cursor = estimated
if let deadline = s.progress.first(where: isIncomplete && role=="deadline"):
  result[deadline.id] = max(cursor, at)     // Deadline 是基准，随推进变化
return result
```

#### `estimatedCompletion(s, at: Date): Date | null`
语义：
```
estimates = estimatedDueDates(s, at)
if let deadline = first incomplete role=="deadline": return estimates[deadline.id]
else: return 最后一项（原序）incomplete 且 role=="task" 的 estimates[id]
```

#### `isLate(s, at: Date): boolean` → `(s.targetDeadline != null) && (estimated = estimatedCompletion(at)) && estimated > targetDeadline`。
#### `get isLate(s)`（无参版）→ `isLate(s, new Date())`。

#### `orderedIncompleteTasks(s): StepProgress[]`（私有）
语义：`tasks = progress.filter(isIncomplete && role=="task")`；若无 active 或 active 不在 tasks → 返回 tasks 原序；否则返回 `[active, ...tasks except active]`（active 提前，保持其余相对顺序）。

**锚点（`testOverdueSessionKeepsDeadlineLastAndEstimatesCompletion`）**：
- `now = Date(timeIntervalSince1970: 10000)`；`target = now - 600`。
- progress = [ first(task,300s,pending,dueAt=target), second(task,300s,pending,dueAt=target+300), deadline(role=deadline,0s,dueAt=target+300) ]；targetDeadline=target。
- 期望：`estimates[first]==now+300`、`estimates[second]==now+600`、`estimatedCompletion==now+600`、`isLate(now)==true`。

### 2.6 远程解析（`RemoteRoutineParsingService` 静态/实例函数）

#### `decodePayload(content: string) => ParsedRoutinePayload | null`
= `extractJSONObject(content)` → `JSON.parse` → `payload(obj)`；任一步失败 → null。
锚点：
- 纯 JSON `{"steps":[{"title":"去厕所","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}` → steps `["去厕所"]`/5、`deadlineHour==8`、`deadlineMinute==35`。
- markdown 围栏 + 前后白话 → 仍解出 `["刷牙"]`，`deadlineHour==null`。
- `durationMinutes:"5"`（字符串） → minutes 5。
- 自创字段名 `{"tasks":[{"name":"去厕所","duration_minutes":5},{"name":"刷杯子","duration_minutes":2},{"name":"出门","time":"08:30"}]}` → titles `["去厕所","刷杯子"]`、minutes `[5,2]`、`deadlineHour==8`、`deadlineMinute==30`、steps.length==2。
- 裸数组根 `[{"title":"刷牙","durationMinutes":3}]` → `["刷牙"]`。
- `{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}` → steps `["洗脸"]`、deadline 8:30。
- 顶层合并时刻 `{"steps":[{"title":"洗脸","durationMinutes":5}],"deadline":"08:30"}` → 8:30。
- 只有截止无任务 `{"steps":[{"title":"出门","time":"8点半"}]}` → **null**。
- 中间项带时刻 `{"steps":[{"title":"7点起床","time":"7:00"},{"title":"洗脸","durationMinutes":5}]}` → titles `["7点起床","洗脸"]`。
- 缺时长 `{"steps":[{"title":"倒垃圾"},{"title":"洗脸","durationMinutes":5}]}` → `["倒垃圾","洗脸"]`，首项 minutes == `fallbackMinutes`（5）。
- `{"steps":[]}` → null；`"我不知道该怎么拆"` → null；`""` → null。

#### `payload(object: unknown) => ParsedRoutinePayload | null`
语义（宽松解析核心）：
- `items = itemDictionaries(object)`；空 → null。
- 遍历 items（带 index）：取 title（`titleKeys` 归一匹配，trim，空则跳过）；`minutes = durationMinutes(item)`；`isLast = index==items.length-1`。
- **仅末项**若有时刻（`clockComponents`）：`deadlineFromItems = clock`；若 `minutes==null` → `continue`（末项只给时刻=截止节点，不产任务）。
- 若 `minutes==null` 且非「末项带时刻」→ 用 `fallbackMinutes`(5) 兜底。
- 汇总 deadline：顶层显式时刻（`clockComponents(root)`）优先 → `integer(root, hourKeys/minuteOfClockKeys)` → `deadlineFromItems`。
- `resolved` 空 → null。
- 候选键名集合（比较前经 `normalize` 去大小写/下划线/连字符）：
  - containerKeys: `steps,tasks,items,tasklist,list,routine,plan,计划,任务列表,任务`
  - titleKeys: `title,name,task,action,label,activity,content,任务,任务名,名称,描述`
  - minuteKeys: `durationminutes,durationmin,minutes,minute,mins,min,duration,时长`
  - secondKeys: `durationseconds,durationsec,seconds,second,sec,秒数`
  - clockKeys: `time,at,deadline,deadlinetime,starttime,clock,时间,时刻`
  - hourKeys: `deadlinehour,hour,deadlineh,时,小时`
  - minuteOfClockKeys: `deadlineminute,minute,deadlinemin,分,分钟数`

#### `normalize(key: string) => string` → `key.toLowerCase().filter(c => isLetter||isNumber)`。
锚点：`"duration_minutes"`、`"durationMinutes"`、`"DURATION-MINUTES"` 归一后相等。

#### `minutes(from value: unknown) => number | null`
语义：数字/数字串 → `>0 ? 值 : null`；字符串取首个数字后判单位：含「秒」或 lowercased 含 `sec` → `n/60`；含「小时」/「时」/`hour`/以 `h` 结尾 → `n*60`；否则 `n>0 ? n : null`。
锚点（`testDurationStringUnitsAreHonoured`）：`"5分钟"→5`、`"2小时"→120`、`"90秒"→1.5`、`"30min"→30`、`"没写"→null`。

#### `doubleValue(value) => number | null`：number→本身；string→trim 后 `Number()`；否则 null。
#### `firstNumber(text: string) => number | null`：正则 `\d+(?:\.\d+)?` 首个匹配转 number。

#### `clockComponents(item) => {hour:number, minute:number} | null`
语义：从 `clockKeys` 取值：字符串 → `clock(text)`；数字 → `clock(fromNumber)`；对象 → `integer(hourKeys)` + `integer(minuteOfClockKeys) ?? 0` 再校验；否则 null。

#### `clock(from text: string) => {hour, minute} | null`
语义：正则 `(\d{1,2})\s*(?::|：|点|時|时)\s*(\d{1,2})?`；minute 缺省 0；**若分钟捕获缺失且含「半」→ 30**；再校验范围。
锚点：`"08:30"`→8:30、`"8点30"`→8:30、`"8点半"`→8:30、`"8点"`→8:00。

#### `clock(fromNumber(n) => {hour, minute} | null`
语义：`int=trunc(n)`；`0..23` → `(int,0)`；`100..2359` → `(int/100, int%100)` 校验；否则 null。锚点：`830 → 8:30`。

#### `makeDeadline(hour: number|null, minute: number|null, on: Date, calendar?) => Date | null`
语义：`hour==null` 或 h∉0..23 → null；`resolvedMinute = minute ?? 0`，∉0..59 → null；返回「on 当日 h:m:00」。
锚点（`testRemoteDeadlineIgnoresOutOfRangeValues`）：`(25,0)→null`、`(8,70)→null`、`(null,30)→null`、`(8,null)→非空`。

#### `extractJSONObject(content: string) => string | null`
语义：
1. trim；若以 ` ``` ` 开头：删首行，从最后一个 ` ``` ` 起截断，再 trim。
2. 取 `{...}`（首 `{` 到末 `}`）与 `[...]`（首 `[` 到末 `]`），各自带**起点下标**。
3. 两者都有 → 起点更靠前者（对象嵌数组 → 对象更早；裸数组 → 数组更早）；只有一个 → 用它；都无 → null。

#### `isRejectedRequest(status: number) => boolean` → `status==400 || status==422`。
锚点：`400/422 → true`；`401/429/500 → false`。

#### `chatCompletionsURL(base: string) => string`
语义：trim；去尾部所有 `/`；若不以 `/chat/completions` 结尾则补 `/chat/completions`；URL 非法时回落 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`。
锚点（`testChatCompletionsURLNormalizesBaseURL`）：`".../v1"`、`".../v1/"`、`".../v1/chat/completions"` 三种输入都归一为 `".../v1/chat/completions"`（不出现双斜杠、不重复拼接）。

#### `getBodyVariants(config): BodyVariant[]`
语义（去重、由全到简）：
```
if usesJSONMode:
   push({json:true, thinking:thinkingDisable})
   push({json:true, thinking:"none"})
push({json:false, thinking:thinkingDisable})
push({json:false, thinking:"none"})
去重（两字段都相等视为重复，保留先出现者）
```
锚点（`testBodyVariants*`）：
- `{json:true, think:chatTemplateKwargs}` → `[（T,ctk）,（T,none）,（F,ctk）,（F,none）]`。
- `{json:true, think:none}` → `[（T,none）,（F,none）]`。
- `{json:false, think:none}` → `[（F,none）]`（**只有一个，不产生重复请求**）。

#### `thinkingDisableBodyEntries(style): Record<string, unknown>`
| style | 返回 |
| --- | --- |
| none | `{}` |
| enableThinking | `{ enable_thinking: false }` |
| chatTemplateKwargs | `{ chat_template_kwargs: { enable_thinking: false } }` |
| thinkingTypeDisabled | `{ thinking: { type: "disabled" } }` |
锚点：`.none` 必须为空对象。

#### `RuleRoutineParsingService.parse(input, now) => Promise<RoutineParseResult | null>`
= `QuickRoutineParser.analyze(input, now)`；`hasSteps` 为假 → null；否则 `{ steps, deadline, source:"rule", leftover }`。

#### `RoutineParsingPipeline.parse(input, now?) => Promise<RoutineParseResult | null>`
语义（**规则优先、模型补位**，三个分支的严格优先级）：
```
fast = try? rule.parse(input, now)            // 抛错视作 null
if fast && fast.isComplete: return fast        // 规则吃全 → 直接返回，不调用模型

better = enhanced ? (try? enhanced.parse(...)) : null

if !fast: return better
if !better: return fast
if better.steps.length > fast.steps.length: return better     // 「严格多于」
if fast.deadline == null && better.deadline != null:          // 数量持平 + 规则无 deadline
    return { steps: fast.steps, deadline: better.deadline, source:"enhanced", leftover: fast.leftover }
return fast                                                    // 数量持平且无补充 → 保留规则
```
锚点：
- `testPipelineSkipsEnhancedServiceWhenRuleIsComplete`：`"去厕所5分钟"` + 记录型 enhanced → `source=="rule"`，`callCount==0`。
- `testPipelineFallsBackToRuleWhenEnhancedThrows`：enhanced 抛错 → `source=="rule"`，titles `["去厕所"]`。
- `testPipelineAdoptsEnhancedResultWhenItFindsMoreSteps`：enhanced 找到 2 项（更快结果 1 项）→ `source=="enhanced"`，titles `["去厕所","倒垃圾"]`。
- `testPipelineKeepsRuleResultWhenEnhancedFindsNoMoreSteps`：enhanced 1 项但不同 → `source=="rule"`，titles `["去厕所"]`。
- `testPipelineAbsorbsEnhancedDeadlineWhenStepCountTies`：数量持平 + enhanced 有 deadline + 规则无 → 保留规则 steps，`deadline==18:30`，`source=="enhanced"`。
- `testPipelineResolvesCanonicalDeadlineWithoutEnhancedPath`：纯规则 `"18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟"` → deadline 18:30，steps.count==3。

---

## 3. 状态机规格（RoutineStore）

> 约定：所有 `commit()` = `snapshot.updatedAt = now; snapshot.originID = deviceID; saveLocally(); publish(snapshot); rescheduleIfNeeded()`。
> `session` = `snapshot.activeSession`。`progress` 数组顺序即执行顺序（index 0 最靠前）。
> **遍历方向**在下文逐一注明。`isIncomplete == state ∈ {pending, active, suspended}`。

### 3.0 只读派生
- `session(): RoutineSession | null` = `snapshot.activeSession`。
- `currentProgress(): StepProgress | null`：`session.state=="running" && activeProgressID!=null` 时，取 `progress` 中 `id==activeProgressID && state=="active"` 者，否则 null。
- `nextProgress(): StepProgress[]` = `progress.filter(isIncomplete)`。
- `template(id): RoutineTemplate | undefined`。
- `addTemplate(t): void`：`templates.unshift(t)` 后 `commit()`（插入到 0 位）。

### 3.1 `start(template, deadlineOverride=null, bufferOverride=null, now=new Date())`
**前置**：无 guard（总是可启动；会覆盖已有 activeSession）。
**计算**：
```
deadline = template.mode=="backward" ? (deadlineOverride ?? template.deadline(on: now)) : null
selectedBuffer = Math.max(0, bufferOverride ?? template.buffer)
plannedStart = deadline != null ? deadline - totalTaskDuration - selectedBuffer : now
cursor = template.mode=="backward" ? plannedStart : now
availableSlack = deadline != null ? (deadline - now - totalTaskDuration) : null   // 秒
remainingBuffer = selectedBuffer                                                   // 缓冲是固定安全垫，不参与扣减
deadlineOverrun = Math.max(0, -(availableSlack ?? 0))
```
**遍历方向**：`template.steps` **正序**一次。
```
for step of template.steps:
  if step.role=="deadline" && deadline != null:
     progress.push(StepProgress{ step, dueAt: deadline+deadlineOverrun, plannedDueAt: deadline, state:"pending", remainingDuration:null…… })
     // 注意：不推进 cursor
     continue
  cursor += step.duration
  progress.push(StepProgress{ step, dueAt: cursor, plannedDueAt: cursor, remainingDuration: step.duration, state:"pending" })
```
**写入**：新建 `RoutineSession{ id:new UUID, templateID, templateName, templateSymbol, startedAt:now, plannedStartAt:plannedStart, targetDeadline:deadline, state:"running", primaryDevice:deviceRole, progress, remainingBuffer, updatedAt:now, revision:1 }`；`activeProgressID` 默认 nil。`commit()`。
**副作用**：`revision=1`（不是自增，是初值）。之后 `commit()` 会刷新 snapshot.updatedAt/originID。
**边界**：
- forward 模式即使传了 `deadlineOverride`，`deadline` 恒为 null。
- backward 模式但 `deadline==null`（无 hour/minute 也无 override）→ deadline 步**落入普通分支**当 0 时长任务处理。

> 锚点（`testMorningRoutineHasAnActualDepartureDeadline` / `testBackwardRoutineCalculatesStartFromDeadlineAndBuffer`）：morning backward，now=2026-08-13 07:00 → deadline 08:35，plannedStart = deadline − 1500 − 600，`plannedStart − deadline == −35*60`。

### 3.2 `start(progress: StepProgress, now=new Date())`
**前置 guard（全部满足才继续）**：`session!=null && session.state=="running" && progress.step.role=="task" && isIncomplete(progress.state) && session.progress 含 progress.id`。
**动作**：`activate(progress.id, session, now, suspendingCurrent:true)` → `session.revision += 1` → `session.updatedAt = now` → 写回 → `commit()`。
**语义**：点击某项「开始」才成为当前任务；会把原当前任务挂起（见 `activate`/`suspendCurrentTask`）。

### 3.3 `complete(progress: StepProgress)`
**前置 guard**：`session!=null && progress 在 session.progress 中（有 index）`。
**now = new Date()**。
```
wasActive = session.activeProgressID == progress.id
progress[index].state = "completed"
progress[index].completedAt = now
progress[index].startedAt = null
progress[index].remainingDuration = 0
if wasActive: session.activeProgressID = null

onlyDeadlineRemains = progress.step.role=="task" && session.progress.every(p => !isIncomplete(p.state) || p.step.role=="deadline")
if onlyDeadlineRemains:
   // 遍历方向：正序，completed 所有仍 incomplete 的 deadline 步
   for i in progress.indices where progress[i].step.role=="deadline" && isIncomplete(progress[i].state):
        progress[i].state="completed"; progress[i].completedAt=now; progress[i].remainingDuration=0
   session.state = "completed"
else:
   resumeMostRecentTaskIfNeeded(session, now)
   startNextTaskIfNeeded(session, now)
   recalculateExpectedSchedule(session, now)

session.revision += 1
session.updatedAt = now
if session.progress.every(p => !isIncomplete(p.state)): session.state = "completed"
写回；commit()
```
**副作用汇总**：被完成项 `state/completedAt/startedAt/remainingDuration`；可能清空 `activeProgressID`；可能自动激活下一项（改 active 项的 state/startedAt/dueAt）；`revision += 1`；整体 `dueAt` 可能被 `recalculateExpectedSchedule` 重算。
**遍历方向**：deadline 收尾 = 正序。

### 3.4 `snoozeCurrent(by seconds = 120)`
**前置 guard**：`currentProgress()` 非空。
**动作**：`applyDelay(currentProgress.id, seconds, incrementSnooze:true)`。
**语义**：「两分钟后再提醒」= 把真实计划整体后推（见 `consumeDelay`），并 `snoozeCount += 1`。

### 3.5 `applyDelay(after progressID, by seconds, incrementSnooze)`（私有）
**前置 guard**：`session!=null && progress 有 index`。
```
consumeDelay(session, startingAt: index, seconds)       // 见 3.6
if incrementSnooze: progress[index].snoozeCount += 1
session.revision += 1
session.updatedAt = new Date()
写回；commit()
```

### 3.6 `consumeDelay(session, startingAt index, seconds)`（私有）
**前置 guard**：`seconds > 0 && index < progress.length`。
**遍历方向**：**正序**，从 `index` 到末尾。
```
for i where i >= index && isIncomplete(progress[i].state):
    progress[i].dueAt += seconds
```
**语义**：延误代表时间线整体后移；**固定缓冲只用于计划展示，不参与扣减**。只迁移 incomplete 项。

### 3.7 `addTemporaryTask(title, minutes, placement)`
**前置 guard**：`session!=null && minutes > 0`。
```
duration = minutes*60
temporary = RoutineStep{ title, prompt:"这是临时插入的事，做完立刻回主线", duration }
now = new Date()
temporaryProgress = StepProgress{
   step:temporary, dueAt: now+duration,
   state: placement=="now" ? "active" : "pending",
   isTemporary:true, plannedDueAt: now+duration, remainingDuration: duration,
   startedAt: placement=="now" ? now : null }

if placement=="now":
   suspendCurrentTask(session, now)                  // 见 3.10
   progress.insert(temporaryProgress, at: 0)
   activeProgressID = temporaryProgress.id
   consumeDelay(session, startingAt: 1, seconds: duration)     // 跳过 index0 的临时项
else: // afterCurrent
   currentIndex = activeProgressID!=null ? firstIndex(id==activeProgressID) : null
   insertionIndex = currentIndex!=null ? min(currentIndex+1, progress.length) : 0
   progress.insert(temporaryProgress, at: insertionIndex)
   consumeDelay(session, startingAt: insertionIndex+1, seconds: duration)

recalculateExpectedSchedule(session, now)
session.revision += 1
session.updatedAt = now
写回；commit()
```
**副作用**：`progress` 插入/重排；`activeProgressID`（now 分支改写）；被 activate/suspend 项字段；`revision += 1`。
**遍历方向**：`consumeDelay` 正序。

### 3.8 `reorderPendingTasks(ids: string[])`
**前置 guard**：
1. `session!=null`。
2. `reorderable = progress.filter(p => isIncomplete(p.state) && p.step.role=="task" && p.id != activeProgressID)`。
3. `setEqual(new Set(ids), new Set(reorderable.map(id)))` —— **必须集合完全相等**，否则整体 no-op（不改、不 commit）。
```
byID = map(reorderable by id)
ordered = ids.map(id => byID[id])          // 保持传入顺序，逐个取值
it = ordered.iterator
for index in progress.indices
    where isIncomplete(progress[index].state) && progress[index].step.role=="task" && progress[index].id != activeProgressID:
       if it.hasNext: progress[index] = it.next()      // 原地槽位替换
recalculateExpectedSchedule(session)                 // now 默认 new Date()
session.revision += 1
session.updatedAt = new Date()
写回；commit()
```
**遍历方向**：**正序**扫描 progress 的可重排槽位；第 k 个槽位放入 `ids` 第 k 项。active 项位置不动。

### 3.9 `deleteFromCurrentSession(progress, now=new Date())`
**前置 guard**：`session!=null && progress.step.role=="task" && progress 有 index`。
```
wasActive = activeProgressID == progress.id
progress.removeAt(index)
suspendedProgressIDs?.removeAll(id == progress.id)
if wasActive:
   activeProgressID = null
   resumeMostRecentTaskIfNeeded(session, now)
   startNextTaskIfNeeded(session, now)
recalculateExpectedSchedule(session, now)
session.revision += 1
session.updatedAt = now
if progress.every(p => !isIncomplete(p.state)): session.state = "completed"
写回；commit()
```
**语义**：只删这次执行，不动模板。**遍历方向**：内部走 3.11/3.12（见下）。

### 3.10 `cancel()` / `finish()`
- `cancel()`：`snapshot.activeSession?.state = "cancelled"; commit()`。
- `finish()`：`snapshot.activeSession?.state = "completed"; commit()`。
- 两者**不**改 revision、不重算 dueAt（除 commit 的 updatedAt/originID）。

### 3.11 `recalculateExpectedSchedule(session, now=new Date())`（私有）
**遍历方向**：**正序**，仅 incomplete 项。
```
cursor = now
for index in progress.indices where isIncomplete(progress[index].state):
   if progress[index].step.role=="deadline":
       progress[index].dueAt = cursor
       continue
   if progress[index].state=="active":
       progress[index].dueAt = max(progress[index].dueAt, now)
   else:
       progress[index].dueAt = cursor + remainingWork(progress[index])
   cursor = progress[index].dueAt
```
**语义**：deadline 的「原计划」保存在 `targetDeadline`/`plannedDueAt`；这里记录的是随实际执行变化的**预计**完成时间。active 项只向前夹（max），不会因重算而提前。

### 3.12 `activate(progressID, session, now, suspendingCurrent)`（私有）
```
if suspendingCurrent && activeProgressID != progressID:
   suspendCurrentTask(session, now)
sourceIndex = firstIndex(id==progressID); if none: return
selected = progress.removeAt(sourceIndex)
selected.state = "active"
selected.startedAt = now
selected.dueAt = now + remainingWork(selected)
progress.insert(selected, at: 0)
activeProgressID = selected.id
suspendedProgressIDs?.removeAll(id == selected.id)
recalculateExpectedSchedule(session, now)
```
**副作用**：被选项 state/startedAt/dueAt；移动到 index 0；activeProgressID；从挂起栈移除；重算全表。

### 3.13 `suspendCurrentTask(session, now)`（私有）
**前置 guard**：`activeProgressID!=null && 有 index && progress[index].state=="active"`。
```
progress[index].remainingDuration = max(0, progress[index].dueAt - now)
progress[index].state = "suspended"
progress[index].startedAt = null
stack = suspendedProgressIDs ?? []
stack.removeAll(id == activeID)
stack.append(activeID)                  // LIFO 栈：最新挂起在栈顶
suspendedProgressIDs = stack
activeProgressID = null
```
**语义**：用 `dueAt - now` 记录未完成剩余时长。

### 3.14 `resumeMostRecentTaskIfNeeded(session, now)`（私有）
**前置 guard**：`activeProgressID == null`。
```
stack = suspendedProgressIDs ?? []
while candidate = stack.popLast():          // LIFO：从最近挂起的开始
   progress = firstIndex(candidate)
   if !(progress && progress.state=="suspended"): continue
   suspendedProgressIDs = stack
   activate(candidate, session, now, suspendingCurrent:false)
   return
suspendedProgressIDs = stack
```
**遍历方向**：栈**逆序**（后进先出）。

### 3.15 `startNextTaskIfNeeded(session, now)`（私有）
**前置 guard**：`activeProgressID == null` 且存在 `next = progress.first(p => p.step.role=="task" && isIncomplete(p.state))`。
**动作**：`activate(next.id, session, now, suspendingCurrent:false)`。
**遍历方向**：**正序**取第一个符合条件的任务。

### 3.16 `mutateProgress(progressID, update: (p)=>void)`（私有）
**前置 guard**：`session!=null && 有 index`。
```
update(progress[index])
session.revision += 1
session.updatedAt = new Date()
if progress.every(p => !isIncomplete(p.state)): session.state = "completed"
写回；commit()
```
**说明**：当前 RoutineStore 内无调用点（可能为预留/外部注入用），移植时保留等价能力。

### 3.17 `commit()`（私有）
```
snapshot.updatedAt = new Date()
snapshot.originID = deviceID
saveLocally()
publish(snapshot)         // 跨端广播
rescheduleIfNeeded()      // 通知重排（Web 端替换方案见 §5）
```

---

## 4. 跨端冲突裁决规则

对应 `RoutineStore.apply(_ incoming:)`。Web 端实现为一个**纯函数式裁决器**，输入两端快照，输出「是否采纳 incoming」。

### 4.1 伪码

```
function shouldAdopt(incoming: RoutineSnapshot, current: RoutineSnapshot, selfDeviceID: string): boolean {
  // 条件 1：来源过滤（最高优先级，最先判）
  if (incoming.originID === selfDeviceID) return false;   // 自己发出去的广播回声，丢弃

  // 条件 2 / 3：版本与时间戳，二者为「或」关系
  const incomingRevision = incoming.activeSession?.revision ?? 0;
  const currentRevision  = current.activeSession?.revision  ?? 0;

  if (incomingRevision > currentRevision) return true;          // 版本严格更新
  if (incoming.updatedAt > current.updatedAt) return true;      // 时间戳严格更新（兜底）
  return false;                                                 // 两者都不严格更新 → 拒绝
}

function apply(incoming, current, selfDeviceID) {
  if (!shouldAdopt(incoming, current, selfDeviceID)) return current;
  // 采纳：整体替换 snapshot
  const next = { ...incoming };
  saveLocally(next);
  // rescheduleIfNeeded(next)
  return next;
}
```

### 4.2 三个条件的确切优先级与边界

| 顺序 | 条件 | 判据 | 边界情况 |
| --- | --- | --- | --- |
| 1 | **originID 过滤** | `incoming.originID !== selfDeviceID` | **最先判且短路**：只要 originID 等于本机 deviceID，无论版本/时间如何更新，一律拒收（防回声导致自激同步）。deviceID 持久化在 UserDefaults `"morning-mainline.device-id"`。 |
| 2 | **revision 严格更大** | `incomingRevision > currentRevision` | revision 取 `activeSession?.revision ?? 0`。两侧都无 session → 0 vs 0，不成立，落到条件 3。incoming 有 session、current 无 → `>=1 > 0` 成立。 |
| 3 | **updatedAt 兜底** | `incoming.updatedAt > snapshot.updatedAt` | 与条件 2 是 **OR**，不是 AND：**时间戳更新可以单独胜出**（即使 revision 相等或更低）。用于「只改了模板、没有 session revision 变化」的场景。 |

**关键边界（必须复现）**：
- `incomingRevision > currentRevision` 与 `incoming.updatedAt > snapshot.updatedAt` **任一**成立即采纳；只有**两者都不成立**（即 `incomingRevision <= currentRevision` **且** `incoming.updatedAt <= current.updatedAt`）才拒绝。
- **相等即拒绝**：revision 相等且 updatedAt 相等 → 拒绝（用的是严格 `>`，不是 `>=`）。这保证并发写入不会被同值覆盖，但也意味着「时钟回拨且 revision 未增」的更新会被吞——移植时保持原语义，不要改成 `>=`。
- `apply` 采纳后是**整体替换** `snapshot = incoming`（不是字段合并）。templates 与 activeSession 一起被覆盖。
- `saveLocally / rescheduleIfNeeded` 在采纳后执行；reject 分支**不**执行副作用。
- 双向对称：两端都跑同一裁决器。由于「严格大于」，两端各自广播后，各自的 originID 过滤会拦掉回声，不会互相覆盖成死循环。

---

## 5. 不可移植部分清单

以下依赖原生 API，Web 端不能直接搬。逐项给出「现状职责」与「Web 替代必须满足的条件」。

### 5.1 本地通知调度 — `ReminderScheduler`（`UNUserNotificationCenter`）
- **现在负责什么**：
  - 启动时 `requestAuthorization([.alert,.sound,.badge])`。
  - `replaceNotifications(session:)`：先删所有前缀 `morning-mainline-` 的待发通知，再为 `state=="running"` 会话重建：
    - 每个 incomplete 的 **task** 步在其 `dueAt > now` 时各排一条（identifier `morning-mainline-{sessionID}-{progressID}-due`），标题 `不跑偏 · {标题}`，正文 `prompt`，`categoryIdentifier=MORNING_MAINLINE_STEP`，`userInfo.progressID`。
    - 只有整条计划最终 `targetDeadline` 使用**密集提醒**，共 8 个里程碑：−10/−5/−3/−1/0/+2/+4/+6 分钟（identifier `...-deadline-milestone-{offset}`），`interruptionLevel=.timeSensitive`；0 及正偏移用自定义音 `deadline-overdue.aiff`（watchOS 用系统音）。文案随偏移变化（见源码 60–93 行）。
- **Web 替代必须满足**：
  - 具备「即使页面关闭也能按时触发」的能力 → 只能用 Service Worker + `Notification` / Push（Web Push + 后端调度），或用原生壳（如 Capacitor/Tauri）桥接系统通知，否则只能做到「页面在前台时提醒」。
  - 需要用户授权、需要「先清后建」的幂等重建（同一 identifier 覆盖语义）。
  - 需支持 **8 个 deadline 里程碑 + 每 task 一条** 的排期，并复刻 `dueAt > now` 过滤与文案（含中文毫秒/分钟偏移）。
  - `timeSensitive`、自定义音、后台唤醒在标准 Web 平台**不可保证**，属降级项。

### 5.2 手表同步 — `ConnectivityService`（`WCSession` / WatchConnectivity）
- **现在负责什么**：iOS ↔ watchOS 双向同步 `RoutineSnapshot`。编码为 JSON `Data` 放在 `payload["snapshot"]`，通过 `updateApplicationContext`（最新态）+ `sendMessage`（可达时即时）/ `transferUserInfo`（兜底队列）发送；收到后 `decode` 并回调 `onSnapshot`。不可用时为 no-op 空实现。
- **Web 替代必须满足**：
  - 因为「Watch 端保留原生 Swift 不动」，Web 端要同步就得与 **iPhone 原生**互通，需新增一条 iOS↔Web 通道（如 iCloud KV / 自建 HTTP / WebSocket），且必须复用 §0 的序列化契约（Date 参考秒、UUID 大小写）。
  - 需保证「最新态覆盖」（`updateApplicationContext` 语义）+「可靠补发」（`transferUserInfo` 语义）两种传输语义都有对应（如 WebSocket 实时 + 重连后全量拉取）。
  - 冲突解决仍走 §4 的 originID/revision/updatedAt 裁决；`pendingIncoming/Outgoing` 的「回调未就绪时缓存」也要保留。

### 5.3 本地持久化 — `UserDefaults`
- **现在负责什么**：`localKey = "morning-mainline.local-snapshot.v2"` 存整个 `RoutineSnapshot`（JSON `Data`）；`"morning-mainline.device-id"` 存本机 deviceID（首次生成 UUID 并持久化，后续复用）。
- **Web 替代必须满足**：用 `localStorage`/`IndexedDB` 存同一 JSON 结构（保持 §0 编码）；deviceID 也要持久化且稳定（否则 originID 过滤失效 → 同步自激）。

### 5.4 App Group 共享容器 — `AppGroupSharedStore`（`UserDefaults(suiteName: "group.com.jaynana.MorningMainline")`）
- **现在负责什么**：App 与 Widget 扩展共享**精简快照** `MainlineWidgetSnapshot`，键 `"morning-mainline.widget-snapshot.v1"`；写入后 `WidgetCenter.shared.reloadAllTimelines()` 刷新小组件/表盘。
- **Web 替代必须满足**：Web 无 WidgetKit，若要在网页展示同等「当前任务/预计完成/延误」卡片，直接**运行时调用** `makeWidgetSnapshot(at:)` 的等价函数（见 §5.5），不必落共享容器；若要继续与原生 Widget 共享，则需 iPhone 侧把 `MainlineWidgetSnapshot` 也暴露给 Web 通道。

### 5.5 小组件时间线 — `WidgetKit`（`MainlineWidgetBundle` / `MainlineWidgetProvider` / `MainlineWidgetEntry`）
- **现在负责什么**：`makeWidgetSnapshot(at:)`（RoutineStore 私有）把会话压缩成 `MainlineWidgetSnapshot`：当前任务标题/`dueAt`/`originalDueAt`、`isHardDeadline`、`estimatedCompletion(at:)`、延误秒数 `delayDuration`（有 targetDeadline 时= `max(0, estimatedCompletion - targetDeadline)`，否则 `max(0, current.dueAt - current.originalDueAt)`，否则 0）、`isLate = delayDuration>0`、`hasActiveSession`、`sessionName`。`MainlineWidgetProvider.entry(for:)` 再叠加「快照生成后继续流逝的延误」（liveOverrun / additionalOverrun）。
- **Web 替代必须满足**：
  - `makeWidgetSnapshot` 逻辑本身**可移植**（纯计算，依赖 `estimatedCompletion`/`originalDueAt`，见 §2.5、§2.4）——Web 页内卡片可直接实现。
  - 真正不可移植的是 **WidgetKit 时间线刷新机制**（`reloadAllTimelines`、系统按时间线自动重建）与表盘 complication；Web 需用定时器/Service Worker 周期刷新或前端轮询替代，且 `capturedAt` 后的「live 延误外推」逻辑要照搬以保证数字一致。

### 5.6 iCloud KV — `CloudSnapshotStore`（`NSUbiquitousKeyValueStore`）
- **现在负责什么**：把 `RoutineSnapshot` 同步到 iCloud KV（键 `"morning-mainline.snapshot.v1"`），监听 `didChangeExternallyNotification` 拉取远端。**注意**：`RoutineStore` 当前**未**接入它（`RoutineStore` 只用了 `ConnectivityService`），属预备设施。
- **Web 替代必须满足**：Web 无法直连 iCloud KV；要跨 Apple 设备同步须经 iPhone 原生中转或自建云。若 Web 端要独立同步，需另建服务端存储，并继续遵守 §0 编码与 §4 裁决。

### 5.7 其它原生耦合（小项）
- `@MainActor` / `ObservableObject` / `@Published`：SwiftUI 响应式。Web 端用状态管理（如 Pinia/Redux/Zustand）替代，`private(set)` → 只读 getter + action。
- 网络：`URLSession` → `fetch`；请求体为手工拼的 `[String:Any]`（动态键），Web 侧保持动态对象构造即可；`connection.timeout` → `AbortController`。
- API Key 来源：`ProcessInfo.environment` / `Info.plist` → Web 侧改用 `import.meta.env` / 后端代理注入，**不要**写死。

---

## 附录 A：移植自检清单（与 Tests 对齐）
移植完成后，至少应通过等价于以下 44 个测试的用例（可 1:1 转成前端单测）：
`testMorningRoutineHasAnActualDepartureDeadline`、`testBackwardRoutineCalculatesStartFromDeadlineAndBuffer`、`testPassedDeadlineRollsOnlyDailyTemplateToTomorrow`、`testQuickParserOnlyBuildsTaskSteps`、`testOldTemplateWithoutRecurrenceDefaultsToOnce`、`testQuickTemplateUsesExplicitDeadlineAndRecurrence`、`testQuickTemplateWithoutDeadlineUsesForwardTiming`、`testOverdueSessionKeepsDeadlineLastAndEstimatesCompletion`、`testOldProgressWithoutNewTimingFieldsStillDecodes`、`testRuleOutcomeIsCompleteWhenEveryDurationIsConsumed`、`testRuleOutcomeReportsLeftoverWhenSomethingIsNotUnderstood`、`testDeadlineExpressionIsNotCountedAsLeftover`、`testTimeAnchorWordsAreNotCountedAsLeftover`、`testRuleReadsTrailingDeadlineFromCanonicalExample`、`testPipelineResolvesCanonicalDeadlineWithoutEnhancedPath`、`testInferredDeadlineUnderstandsHalfHour`、`testInferredDeadlineRegressionCoversBothWordOrders`、`testInferredDeadlineIgnoresPlainTaskDurations`、`testPipelineSkipsEnhancedServiceWhenRuleIsComplete`、`testPipelineFallsBackToRuleWhenEnhancedThrows`、`testPipelineAdoptsEnhancedResultWhenItFindsMoreSteps`、`testPipelineKeepsRuleResultWhenEnhancedFindsNoMoreSteps`、`testPipelineAbsorbsEnhancedDeadlineWhenStepCountTies`、`testRemotePayloadDecodesPlainJSON`、`testRemotePayloadSurvivesMarkdownFenceAndExtraPreamble`、`testRemotePayloadAcceptsDurationAsString`、`testRemotePayloadAcceptsInventedFieldNamesFromRealResponse`、`testRemotePayloadAcceptsBareArrayRoot`、`testRemotePayloadTreatsTrailingClockOnlyItemAsDeadline`、`testRemoteDeadlineAcceptsMergedClockFieldOnRoot`、`testRemotePayloadWithoutAnyTaskFallsBackToRules`、`testRemotePayloadKeepsMidListTaskThatCarriesAClock`、`testRemotePayloadKeepsTaskWithoutDurationUsingFallback`、`testRemotePayloadRejectsEmptyStepList`、`testRemotePayloadRejectsGarbage`、`testDurationStringUnitsAreHonoured`、`testRemoteDeadlineIgnoresOutOfRangeValues`、`testChatCompletionsURLNormalizesBaseURL`、`testCosmoMindConfigurationTargetsInternalGateway`、`testThinkingDisableStylesProduceDistinctFields`、`testOnlyRequestShapeErrorsTriggerDegradedRetry`、`testBodyVariantsShrinkFromFullestToSimplest`、`testBodyVariantsSkipThinkingWhenNotEnabled`、`testBodyVariantsAlwaysIncludeMinimalFallback`。

## 附录 B：最容易移植出错的点（工程视角，供后续 QA 重点覆盖）
1. **Date 参考日期**：JSONEncoder 默认把 `Date` 写成「自 2001-01-01 起的秒」，不是 Unix 秒。跨端快照互通若把时间当 Unix 秒，会整体偏移约 31 年，且因仍是合法 Double 而**静默错位**，最难发现。
2. **`consumeDelay` / `recalculateExpectedSchedule` 的遍历方向与过滤**：前者「从 index 起、仅 incomplete、整体后移」，后者「从 now 起、正序、active 用 max 夹、deadline 直接吃 cursor」。方向或过滤写反，`dueAt` 会连锁算错，却仍产生看似合理的数字。
3. **同步裁决用严格 `>` 且 revision/updatedAt 为 OR**：相等要拒收、时间戳可单独胜出、originID 最先短路。任何一处从 `>` 改 `>=`、或把 OR 写成 AND、或漏掉 originID 过滤，都会导致「更新丢失」或「同步自激」。
