# 早上主线（MorningMainline）

一个供 iPhone、iPad 与 Apple Watch 独立使用、并能同步进度的早间流程 App。

## 第一版能力

- Apple Watch、iPhone 或 iPad 任意一端开始流程
- 相对时间节点：开始后 3 分钟、5 分钟
- 绝对硬节点：8:20 下楼、8:35 出门
- 完成与有限次数延后提醒
- iPhone/iPad 自适应布局，支持 iPad 台前调度窗口缩放
- WatchConnectivity：Watch 与 iPhone 可达时即时同步，离线时排队补传
- iCloud KVS：三端最终状态同步
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

首次运行前，在 Xcode 中为 iOS 与 Watch 两个 Target 选择自己的 Development Team。真机同步测试需要登录相同 Apple ID，并为应用开启 iCloud 权限。

> 当前机器尚未安装完整 Xcode，因此项目已生成但未在模拟器或真机编译。安装 Xcode 后先运行 `xcodegen generate`，再进行签名与真机验证。
