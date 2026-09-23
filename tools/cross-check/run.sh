#!/usr/bin/env bash
#
# run.sh — 一键复现跨端交叉验证（Swift 真跑 ↔ TS）
#
# 编译三个 Swift harness（都直接编入 Shared/ 原文件，不复制粘贴模型代码），
# 再用 vite-node 跑比对脚本。退出码 0 = 全部一致。
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "== 1/4 编译 models harness (SwiftHarness) =="
xcrun swiftc -o tools/cross-check/SwiftHarness/harness \
  tools/cross-check/SwiftHarness/main.swift \
  Shared/Models/RoutineModels.swift

echo "== 2/4 编译 store harness (StoreHarness) =="
xcrun swiftc -o tools/cross-check/StoreHarness/store_harness \
  tools/cross-check/StoreHarness/StoreHarness.swift \
  Shared/Models/RoutineModels.swift \
  Shared/Store/RoutineStore.swift \
  Shared/Services/ConnectivityService.swift \
  Shared/Services/AppGroupSharedStore.swift \
  Shared/Services/ReminderScheduler.swift \
  Shared/Widget/MainlineWidgetShared.swift

echo "== 3/4 编译 parser harness (ParserHarness) =="
xcrun swiftc -o tools/cross-check/ParserHarness/parser_harness \
  tools/cross-check/ParserHarness/ParserHarness.swift \
  Shared/Models/RoutineModels.swift \
  Shared/Services/RoutineParsingService.swift \
  Shared/Services/RemoteRoutineParsingService.swift

echo "== 4/4 运行比对（vite-node） =="
TZ=Asia/Shanghai web/node_modules/.bin/vite-node tools/cross-check/compare.ts
