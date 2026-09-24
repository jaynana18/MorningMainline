import SwiftUI
import UIKit
import UserNotifications

@main
struct MorningMainlineApp: App {
    /// 通知中心 delegate 必须在 `application(_:didFinishLaunchingWithOptions:)` **返回前**设好。
    /// 但 SwiftUI 侧真正挂 `UNUserNotificationCenter` delegate 的地方是 `WebHost.Coordinator.attach(to:)`，
    /// 它在 `makeUIViewController`（SwiftUI 建视图）时才发生，**晚于 didFinishLaunching**。
    /// 若等到那时才设，冷启动点系统通知的那一次 `didReceive` 回调会被系统**直接丢弃** → 回跳丢首条。
    /// 因此改由本 `AppDelegate` 在最早的入口先设好，接住「启动 → attach」这个窗口；attach 之后
    /// 由 `WebHost.Coordinator` 接替（见 `iOS/WebHost.swift` 的 `attach(to:)`）。
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @StateObject private var store: RoutineStore

    init() {
        #if os(iOS)
        let role: DeviceRole = UIDevice.current.userInterfaceIdiom == .pad ? .pad : .phone
        #else
        let role: DeviceRole = .phone
        #endif
        _store = StateObject(wrappedValue: RoutineStore(deviceRole: role))
    }

    // MARK: - 冷启动通知回跳入口

    /// 只负责「启动最早窗口」的通知 delegate：设好 `UNUserNotificationCenter` 的 delegate，
    /// 并接住「App 启动 → `WebHost` attach」之间到达的通知点击（存入 `WebHost.NotificationInbox`）。
    ///
    /// 职责边界：attach 之后的一切通知交互由 `WebHost.Coordinator` 接替；两条路径最终都汇到
    /// 同一个 `notification.opened` 事件（见 `iOS/WebHost.swift`）。
    ///
    /// 嵌入为 `MorningMainlineApp` 的嵌套类型，避免新增顶层命名污染；`@UIApplicationDelegateAdaptor`
    /// 对嵌套类型同样支持。
    final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
        func application(
            _ application: UIApplication,
            didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
        ) -> Bool {
            // **必须在 return true 之前设好**：Apple 要求 delegate 在 didFinishLaunching 返回前就位，
            // 否则冷启动那一刻点系统通知触发的 `didReceive` 会被系统丢弃（回跳丢首条）。
            UNUserNotificationCenter.current().delegate = self
            return true
        }

        /// 与 `WebHost.Coordinator.userNotificationCenter(_:willPresent:)` 是**同一策略**：
        /// **前台不放行横幅是刻意的** —— 前台通道交给 Vue 侧页内弹窗
        /// （`web/src/stores/reminders.ts` 的引擎），若这里再放行，同一条提醒会出现两份。
        /// （交叉引用：`iOS/WebHost.swift` 的同名实现也返回 `[]`。）
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            []
        }

        /// 冷启动那一击：此时 `WebHost` 尚未 attach，没有可投递的 WebView，遂把载荷存入信箱，
        /// 等 `Coordinator.attach(to:)`（安装消费者时）当场交出补发（届时若页面未就绪会被入队，
        /// 由 `didFinish` flush —— 保证冷启动点击不丢）。attach 之后的点击由
        /// `WebHost.Coordinator.userNotificationCenter(_:didReceive:)` 直接 emit。
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            await MainActor.run {
                WebHost.NotificationInbox.store(response: response)
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            // P2：iOS/iPad 的 UI 交给 `web/` 的 Vue 产物承载（WKWebView 宿主）。
            // `iOS/ContentView.swift` 仍保留在工程里（原生实现留作回退），但不再被引用。
            WebHost(store: store)
                .environmentObject(store)
        }
    }
}
