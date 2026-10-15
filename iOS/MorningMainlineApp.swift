import SwiftUI
import UIKit
import UserNotifications
import OSLog

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

        Self.configureRoutineParsing()
    }

    /// 注册云端解析服务，让「一句话创建」在一句话规则没读全时交给大模型补位。
    ///
    /// Key 不写在源码里，依次从环境变量 `COSMO_MIND_API_KEY`、Info.plist 的
    /// `CosmoMindAPIKey` 读取；都取不到时仍会注册服务，用网关可能存在的免鉴权通道。
    /// 任何失败（超时、鉴权错、格式不对）都会自动回退本机规则，不影响创建流程。
    ///
    /// 想回到纯本机规则模式：注释掉下面这行即可。
    private static func configureRoutineParsing() {
        RoutineParsing.current.enhanced = RemoteRoutineParsingService(
            configuration: .cosmoMind(
                apiKey: RemoteRoutineParsingService.Configuration.apiKeyFromEnvironment()
            )
        )
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

        /// 此时 WebHost 尚未 attach，Vue 页内提醒通道一定还不可用，因此必须保留系统横幅兜底。
        /// attach 后由 `WebHost.Coordinator` 接替，并仅在 Vue 明确 ready 后抑制横幅。
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .sound]
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
                Logger(subsystem: "com.jaynana.MorningMainline", category: "WebLifecycle")
                    .notice("Notification opened through launch delegate")
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
