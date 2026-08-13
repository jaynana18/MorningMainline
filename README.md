# 早上主线（MorningMainline）

一个供 iPhone、iPad 与 Apple Watch 独立使用、并能同步进度的早间流程 App。

## 第一版能力

- Apple Watch、iPhone 或 iPad 任意一端开始流程
- 相对时间节点：开始后 3 分钟、5 分钟
- 绝对硬节点：8:20 下楼、8:35 出门
- 完成与有限次数延后提醒
- iPhone/iPad 自适应布局，支持 iPad 台前调度窗口缩放
- WatchConnectivity：Watch 与 iPhone 可达时即时同步，离线时排队补传
- iCloud KVS：使用付费 Apple Developer Team 并启用 iCloud 权限后，三端最终状态同步
- 本地通知：App 不在前台时仍能收到节点提醒

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
