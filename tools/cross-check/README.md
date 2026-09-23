# 跨端交叉验证工具（tools/cross-check）

用 **真实 Swift 运行产出的字节** 交叉验证 `web/src/core/` 的 TS 实现。
不依赖任何「TS 自测自洽」的往返测试——那种测试在数学上无法证明跨端一致。

## 为什么需要它

`web/tests/**` 里 114 个测试全是 **TS encode → TS decode** 的往返。
即使两端约定整体偏移（例如把 Apple 参考日期当成 Unix 秒），往返依旧自洽通过。
唯一能证明「跨端逻辑一致」的手段，是让 Swift 真跑、把字节喂给 TS（及反向），逐字段比对。

## 目录结构

```
tools/cross-check/
├── run.sh                      # 一键复现：编译三个 harness + 跑比对
├── compare.ts                  # 比对脚本（vite-node 运行，直接 import web/src/core）
├── SwiftHarness/
│   ├── main.swift              # 模型/序列化/会话计算属性 harness（编入 RoutineModels.swift）
│   └── harness                 # 编译产物
├── StoreHarness/
│   ├── StoreHarness.swift      # RoutineStore 状态机 harness（编入 Store + 依赖）
│   └── store_harness
├── ParserHarness/
│   ├── ParserHarness.swift     # 解析层 harness（编入 ParsingService/RemoteParsingService）
│   └── parser_harness
└── fixtures/                   # 各 harness 的原始输出 + 比对结果（证据留档）
```

关键点：**harness 直接编入 `Shared/**` 原文件**，绝不复制粘贴模型代码——
复制会引入偏差、失去验证意义。

## 复现（完整命令）

```bash
# 一键（推荐）
bash tools/cross-check/run.sh          # 退出码 0 = 全部一致

# 或分步
cd <repo-root>

# 1. models harness（只依赖 Foundation，最稳）
xcrun swiftc -o tools/cross-check/SwiftHarness/harness \
  tools/cross-check/SwiftHarness/main.swift \
  Shared/Models/RoutineModels.swift

# 2. store harness（RoutineStore + SwiftUI/WidgetKit/UserNotifications 依赖，macOS 可编译）
xcrun swiftc -o tools/cross-check/StoreHarness/store_harness \
  tools/cross-check/StoreHarness/StoreHarness.swift \
  Shared/Models/RoutineModels.swift \
  Shared/Store/RoutineStore.swift \
  Shared/Services/ConnectivityService.swift \
  Shared/Services/AppGroupSharedStore.swift \
  Shared/Services/ReminderScheduler.swift \
  Shared/Widget/MainlineWidgetShared.swift

# 3. parser harness（两个解析服务都只 import Foundation）
xcrun swiftc -o tools/cross-check/ParserHarness/parser_harness \
  tools/cross-check/ParserHarness/ParserHarness.swift \
  Shared/Models/RoutineModels.swift \
  Shared/Services/RoutineParsingService.swift \
  Shared/Services/RemoteRoutineParsingService.swift

# 4. 比对
TZ=Asia/Shanghai web/node_modules/.bin/vite-node tools/cross-check/compare.ts
```

Node 绝对路径（如需）：`/Users/panna/.workbuddy/binaries/node/versions/22.22.2-3/bin/node`

## harness 子命令

```bash
tools/cross-check/SwiftHarness/harness emit        # 默认 JSONEncoder 编码固定快照 → JSON
tools/cross-check/SwiftHarness/harness truth       # 同一快照的绝对时刻(unix ms)真值表
tools/cross-check/SwiftHarness/harness nilcheck    # 含 nil optional 的实例 → 原始 JSON 字节
tools/cross-check/SwiftHarness/harness decode      # stdin 读 JSON，JSONDecoder 解码后再编码
tools/cross-check/SwiftHarness/harness session     # 测试 8 锚点的 estimatedDueDates/Completion
tools/cross-check/SwiftHarness/harness widget      # widget 延误公式真值
tools/cross-check/SwiftHarness/harness constants   # Date.distantPast 实际编码值
TZ=Asia/Shanghai tools/cross-check/StoreHarness/store_harness     # RoutineStore.start 输出
TZ=Asia/Shanghai tools/cross-check/ParserHarness/parser_harness   # 解析层全锚点输出
```

## 比对项（compare.ts）

| 组 | 内容 |
|----|------|
| 0 | 自检：注入 3 处错误，证明比对器能检出（证伪脚本自身） |
| A | Swift→TS：全快照字段（绝对时刻 ms / key 名 / enum / UUID / optional） |
| B | nil optional：Swift 省略键 → TS 能解；TS 显式 null → Swift 能解 |
| C | TS→Swift：TS encodeSnapshot → Swift JSONDecoder → 字段一致 |
| D | RoutineStore.start 排程：倒推公式 / 缓冲 / 末尾 deadline 节点 |
| E | RoutineSession 计算属性：estimatedDueDates / estimatedCompletion / isLate |
| F | Widget 延误公式（核验 900 期望值） |
| G–J | 解析层：inferredDeadline / makeSteps / analyze·leftover / 云端宽松解析 |
| K | [信息] Date.distantPast 常量对齐 |

## 时区约定

所有涉及本地日历日的比对（D/G）都用 `TZ=Asia/Shanghai` 运行 Swift，
TS 侧显式传 `'Asia/Shanghai'`。两组 harness 的绝对时刻比对（A/C/E/F）与时区无关。
