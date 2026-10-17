# AGENTS.md — 不跑偏（MorningMainline）

> 给 AI / 新接手的人看的**上手 + 进度**文件。技术细节的权威来源是同目录 `docs/web-migration/`。
> 最后更新：2026-10-16。

## 1. 这个项目是什么

给「容易临时跑偏」的人用的**任务线 App**：把一件事拆成有先后顺序的步骤，倒推或顺排出时间线，执行中只突出**当前一步**，超时就提醒。

一句话创建：「9点到宜家 路上40分钟 留15分钟堵车」→ 自动拆成带通勤的步骤链。

主要坑：**P 人**会临时加事 / 拖延 —— 所以「延误后整条时间线后移、但固定缓冲不可被挪用」是核心语义。

## 2. 架构主力：三个端，两种宿主

```
iOS / iPad  ── WKWebView ──┐
                           ├── 同一份 Vue 3 代码（web/）
浏览器（可独立用） ─────────┘
Apple Watch ── 原生 Swift，完全独立，不改
```

| 层 | 位置 | 职责 |
| --- | --- | --- |
| **core** | `web/src/core/` | 纯逻辑：模型、解析、状态机、序列化、冲突裁决。**零 DOM / 零平台 API**，跨端 100% 同代码 |
| **platform** | `web/src/platform/` | 双宿主能力收口。宿主差异**只在这里**，core 与视图禁止感知宿主 |
| **stores** | `web/src/stores/` | Pinia：包一层 core 状态机；提醒引擎 |
| **views** | `web/src/views/` | 界面（从 `iOS/ContentView.swift` 1385 行 / 13 个 View 移植） |
| **iOS** | `iOS/WebHost.swift` | WKWebView 容器 + 桥（`window.webkit.messageHandlers.mainline`） |
| **Shared / Watch** | `Shared/` `Watch/` | 原生侧：模型、通知调度、WatchConnectivity、Watch UI |

**宿主探测**：`window.webkit?.messageHandlers?.mainline` 存在 ⇒ WebView 宿主，否则浏览器宿主。

**浏览器宿主的物理边界**（不要在 UI 上假装能做到）：无 Watch 同步、无后台系统通知（仅前台）、无小组件。

## 3. 三条不可协商的语义（改了就跨端漂移）

1. **Date 是 Apple 参考秒，不是 Unix 秒。** `epochMs = (refSeconds + 978307200) * 1000`。
   Swift `JSONEncoder` 默认基准 2001-01-01。当 Unix 秒处理会**静默偏移 31 年** —— 仍是合法数字，最难发现。
2. **冲突裁决用严格 `>`，revision 与 updatedAt 是 OR。**
   `originID === 自身` **最先短路拒收**（防同步自激）；二者任一大于才采纳，**相等即拒**。禁止改 `>=`。
3. **缓冲不可被延误挪用。** `remainingBuffer` 初始化后永不变；延误只让**未完成项**的 `dueAt += seconds`，**绝不前移**。

## 4. 提醒：唯一决策点 + 双通道

- **唯一决策点** = `web/src/stores/reminders.ts` 的 1Hz `tick`。可见 → 应用内弹窗；不可见 → 系统通知。**严格互斥**。
- **文案单一来源** = `web/src/core/reminders.ts`，**逐字镜像** `Shared/Services/ReminderScheduler.swift`。
  改一处必须同步另一处。8 个里程碑：−10 / −5 / −3 / −1 / 0 / +2 / +4 / +6 分钟。
- **超时口径** = `startedAt + step.duration`（**不是** `dueAt`，它会被前推）；分钟数一律 **`floor`**。
- `.inactive` **不算后台**：只观察 `didEnterBackground` 发 `false`，不观察 `willResignActive`。
- **语音播报**只在亮屏（App 前台）由 App 自己念（`iOS/SpeechAnnouncer.swift`）；**后台播报不可行**（系统限制，加 `UIBackgroundModes: audio` 也救不了）。
- 只提醒**当前那一项**：`focusedTask(session)`（active 优先，否则第一个未完成）。

## 5. 服务端（BFF，`server/`）

存在理由：**客户端产物只要能下载，就一定能反查出 Key。** 所以凭据一律留在服务端。

| 端点 | 作用 |
| --- | --- |
| `/api/account/*` | 注册 / 登录 / 快照同步 / **偏好同步** |
| `/api/account/parse` | AI 解析主通道（带缓存） |
| `/api/account/preferences` | 「用户习惯」三项：出行方式 / 语音播报 / 超时提醒间隔 |
| `/api/commute/rest` · `/api/commute/staticmap` | **高德代理**（JSON / PNG） |
| `/api/model/chat/completions` | 模型代理（另进程 `model-proxy.mjs`） |

**高德 Key 三道防线**（`handleCommute`）：

1. Key 只存服务端环境变量 `AMAP_WEB_SERVICE_KEY`（`server/.env.account`，**不带 `VITE_` 前缀**），客户端零凭据；
2. **精确字符串 path 白名单** `AMAP_PATHS`（不做前缀匹配）防 SSRF；
3. 按 IP 限流 60/分、2000/天（`AMAP_DAILY_LIMIT` 可调）。

参数用白名单 `AMAP_PARAMS` 透传 —— `key` **不在表内**，客户端自带 key 会被丢弃。

**「用户习惯」三项跟账号走**（`platform/account.ts` → `withAccountSync`），LWW 非乐观锁，`updatedAt` 服务端打。
🔴 `pullPreferences` **绝不能整体替换**本机设置，必须只并白名单三项（`pickPreferences`）。

## 6. 安全边界（别回退）

- API Key **绝不进客户端**。`SharedSettings` 已无 `amapKey`，`developerAmapKey()` 与 `web/.env.local` 已删除。**不要把 Key 挪进 localStorage / App Group / Watch settings** —— 那只是换个地方公开。
- 🔴 **静态地图不能走桥**：`<img src>` 不认 Promise，且 `file://` 下 `/api/commute/…` 会解析到文件系统根 → WebView 宿主必须拼固定 HTTPS 域名（`platform/commute.ts` 的 `COMMUTE_ORIGIN`）。
- `.xcscheme` 在 `.gitignore`（内含调试环境变量）。

## 7. 全屏适配（2026-10-15 定，改布局前必读）

**分工：原生交还整个屏幕，避让全权归 CSS 的 `env(safe-area-inset-*)`。**

**三处缺一不可**：

| # | 位置 | 改动 | 缺了会怎样 |
| --- | --- | --- | --- |
| 1 | `iOS/MorningMainlineApp.swift` | `WebHost(...).ignoresSafeArea()` | SwiftUI 会把整个 `UIViewControllerRepresentable` 内缩到安全区，**只改约束无效** |
| 2 | `iOS/WebHost.swift` | 约束绑 `view.*Anchor`（不是 `safeAreaLayoutGuide`）+ `contentInsetAdjustmentBehavior = .never` | 露黑边 / 双重避让 |
| 3 | `web/index.html` | viewport 加 `viewport-fit=cover` | **`env(safe-area-inset-*)` 恒为 0**，CSS 避让全部失效 |

连带：每个贴边容器自己吃 `env()`（`.mm-toolbar` 吃 top；底部抽屉**不吃 top**；登录页自己补）。
⚠️ 黑边**浅色下几乎看不出**（`#F5F7FB` ≈ 画布 `#f5f7fb`），**必须在深色模式验**。

## 8. 常用命令

```bash
# Web 侧
cd web
npm run typecheck     # tsc --noEmit
npm test              # TZ=Asia/Shanghai vitest run
npm run build         # vite build → web/dist

# 工程
/opt/homebrew/bin/xcodegen generate      # 新增 .swift 后必须跑
xcodebuild -scheme MorningMainlineApp -destination 'generic/platform=iOS'   # 真机配置验证
```

**⚠️ 改 `web/` 后必须先 `vite build` 再 `xcodebuild`**（反了不报错，但打进旧 UI）。
验证法：比对包内 `dist/assets/*.js` 与 `web/dist/assets/` 的 hash 名是否一致。

**`web/dist` 是 folder reference**（`lastKnownFileType = folder`）→ 构建时读当前目录，改 `web/` **不必**重跑 `xcodegen generate`。

**`CFBundleVersion` 在四份 plist**（iOS / iOSWidget / Watch / WatchWidget）各一份，装机前一起 +1：

```bash
for f in iOS/Info.plist iOSWidget/Info.plist Watch/Info.plist WatchWidget/Info.plist; do
  plutil -replace CFBundleVersion -string 11 "$f"
done
```

**scheme 名是 `MorningMainlineApp`**（不是 `MorningMainline`，后者不存在）。

## 9. 已知的真机 / 工具链约束

- **个人开发 Team 不支持需付费账号的 capability**：`timeSensitive`、Push、iCloud、Sign in with Apple、Associated Domains。
  **声明 `timeSensitive` 会让整个工程打不出包**（已摘除，代码保留该字段）。当前未启用 iCloud，跨设备靠服务端同步。
- **Watch 无法部署** = Xcode 26.6 上限 watchOS 26.5 vs 设备 27.0.1。工具链代差，非代码问题。
  ⚠️ **不要 unpair watch**（unpair 后无法被重新发现）。
- **`UNUserNotificationCenterDelegate` 的 async 方法必须标 `@MainActor`**（写 `nonisolated` → 真机 `SIGABRT`，**模拟器测不出**）。
- 单测/编译加 `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`；真机打包用 `-destination 'generic/platform=iOS'`（不加免签名参数）。

## 10. 当前进度（2026-10-16）

### 阶段（`docs/web-migration/ARCHITECTURE.md` §8）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 脚手架 + core 全量移植 | ✅ 44 用例 / 28 断言 |
| P1 | 桥 + stores + 视图（浏览器内跑通全流程） | ✅ |
| P2 | `WebHost.swift` + webview 桥，替换 `ContentView` | ✅ 已在真机跑 |
| P3 | 应用内弹窗 + 通知点击回跳 | ✅ |
| P4 | 一致性回归 + 真机验收 | 🔶 进行中 |

### 最近几轮做完的

- **B 方案落地**：高德 Key 全部撤到服务端（`handleCommute` 三道防线 + 精确 path 白名单 + 按 IP 限流）。
  客户端产物实测 **0 个 32 位 hex 串 / 0 处 `restapi.amap.com`**。
- **「用户习惯」三项跟账号走**：出行方式 / 语音播报 / 超时提醒间隔，走 `/api/account/preferences`。
- **超时提醒间隔用户可配**（两阶段策略，最小 1 分钟最大 10 分钟）。
- **点通知直达任务详情**（自动展开 `step.prompt` + 高亮 + 滚到中间），修掉闪退。
- **应用内语音播报**（亮屏也能听，播报时刻用当下 `new Date()`）。
- **全屏适配修复**（黑边三层修复，见 §7），三机型模拟器验证（刘海 / 非全面屏 SE / iPad）全部无黑边。

### 验证基线（可对外陈述）

- `typecheck` **0 错**
- `vitest` **336 通过 / 8 既有失败**（8 个是既有问题，与基线一致，无回归）
- 服务端 3 个测试文件全 pass
- `xcodebuild -destination 'generic/platform=iOS'` **BUILD SUCCEEDED**
- 构建号 **10**

### 待办

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | ✅ **部署（原最紧急）** | **2026-10-17 完成**。线上 nginx 补上 `location /api/commute/`；公网实测 `rest` → **200 JSON**（`"status":"1"`，解析出青岛市黄岛区）、`staticmap` → **200 PNG**（400×240）。备份 `/opt/morning-mainline-account/backups/prefs-20261017132740` |
| 2 | ✅ **高德 Key** | 沿用旧 Key（用户加了 IP 白名单），写进 `/opt/morning-mainline-account/.env.account` 的 `AMAP_WEB_SERVICE_KEY`（**不带 `VITE_`**）。白名单里是**服务器出网 IP** `47.104.95.146`，本机直连返 `INVALID_USER_IP` 属预期 |
| 3 | ✅ **线上前端旧版** | 已切到 `/var/www/morning-mainline/releases/20261017-djec4b5f`（`index-DjEc4B5F.js`，与包内一致）：`api/commute` 1 处、旧 Key 0 处、`restapi.amap.com` 0 处 |
| 4 | 真机自测 | 按 `docs/真机冒烟测试清单.md`（1.3），重点 #11–#16。#11 应已通过（待办 1 已修）。**App 无需重装**：代理地址没变，只是服务端补了路由 |
| 5 | 推送 origin/main | 用户未表态 |

> **SSH 入口**：`root@47.104.95.146` 已装本机 `~/.ssh/id_ed25519.pub`（2026-10-17 经阿里云控制台「云助手 → 发送命令」以 root 写入）。此前 `root`/`ubuntu`/`admin`/`ecs-user`/`panna`/`deploy` 全部 `Permission denied (publickey)`。

### 已知问题 / 非问题

| 现象 | 定性 |
| --- | --- |
| **地图加载不出来** | ✅ **已修复（2026-10-17）**。根因是部署缺失：线上 nginx 没有 `/api/commute/`，请求被 SPA fallback 吞成 `index.html`（**HTTP 200 但 `text/html`** —— 只看状态码会误判为「通」）。与「历史/新任务」无关，所有路线图都是实时向代理请求的 |
| **深色模式下界面没变化** | ✅ **正常**。全仓 0 处 `prefers-color-scheme`，颜色硬编码浅色 → App 恒为浅色主题，深色模式只影响系统 UI（状态栏/弹窗）。黑边修好后深色与浅色观感一致，正是修复生效 |


### 仓库状态

`main` 领先 `origin/main` **6 个提交**（最新 `ebd5c2a 新增只更新账号服务的部署脚本`），另有 **34 项未提交改动**（B 方案 + 黑边修复两轮）。

## 11. 动手前先看这几份

| 想知道 | 看 |
| --- | --- |
| 整体架构 / 宿主矩阵 / 分阶段 | `docs/web-migration/ARCHITECTURE.md`（§1b 全屏适配、§4b 接口冻结、§5 三条语义） |
| 类型 / 函数 / 状态机 / 序列化契约 | `docs/web-migration/LOGIC_PORT_SPEC.md` |
| 44 用例 / 28 断言 M1–M28 / 16 盲区 | `docs/web-migration/CROSS_PLATFORM_TEST_SPEC.md` |
| 装机后测什么 | `docs/真机冒烟测试清单.md` |
| 服务端部署 | `server/ACCOUNT_SETUP.md` |

## 12. 工作约定

- 改代码**只改不跑**，用户自己验证（除非用户要求跑）。
- 不主动跑语法/格式校验；常规改动肉眼可查。
- 顺带重构/扩展**不做** —— 只改用户要求的范围。
- 遇到「修了一层不生效」先怀疑**还有第二层**（黑边就是两层内缩）。
- **判据本身也要验**：黑边排查时判据写错两次，比结果更值得花时间。
