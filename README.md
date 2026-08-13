# 不跑偏（MorningMainline）

一个让 P 人在临时想做别的事时，依然看得见主线与截止时间的 iPhone、iPad、Apple Watch 任务线 App。

## 当前 MVP

- 任务线选择：上班早晨、写作业、去宜家，也可保留自定义任务线
- 两种计划方式：从现在顺排，或根据截止时间、步骤时长和缓冲倒推
- 一句话创建：解析常见的“9点到宜家 路上40分钟 留15分钟堵车”式输入，并生成可编辑前的任务线预览
- 执行中只突出一个当前主线；完成、延后两分钟、临时加事都能直接操作
- 延后或临时加事会优先消耗缓冲；缓冲用完后明确显示预计晚多久
- Apple Watch 可以先选择要执行的任务线，再完成当前步骤或延后两分钟
- 本地通知：App 不在前台时仍能收到节点提醒
- iPhone/iPad 自适应布局，支持 iPad 台前调度窗口缩放
- WatchConnectivity：Watch 与 iPhone 可达时即时同步，离线时排队补传

## 工程结构

```text
Shared/   共享模型、流程状态、通知和同步逻辑
iOS/      iPhone / iPad 共用界面
Watch/    Apple Watch 界面
Tests/    核心时间规则测试
```

## 打开工程

```bash
xcodegen generate
open MorningMainline.xcodeproj
```

工程当前已配置个人开发 Team，可直接在已登记的 iPhone、iPad 与 Apple Watch 上调试。个人免费 Team 不支持 iCloud Capability，因此当前签名配置未启用 entitlements；iPhone 与 Apple Watch 仍可通过 WatchConnectivity 同步，iPhone 与 iPad 可分别独立使用。

若后续加入付费 Apple Developer Program，请在 iOS 与 Watch Target 中重新启用对应 entitlements，并为应用开启 iCloud Key-value storage，即可恢复跨 iPhone、iPad 与 Apple Watch 的 iCloud 最终同步。

## 真机验证

- Xcode 26.6 构建通过
- iPhone 13 Pro Max（iOS 26.5）安装与启动通过
- Apple Watch Series 9（watchOS 26.3）安装与启动通过
