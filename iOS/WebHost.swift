import Combine
import SwiftUI
import UIKit
import UserNotifications
import WebKit

/// iOS / iPad 侧 WKWebView 宿主：UI 由 `web/` 的 Vue 产物承载。
///
/// 架构决定（P2）：本宿主**只做「能力提供 + 持久化 + 广播」**，不再承担状态机职责。
/// JS 侧的 `web/src/core/store.ts` 已经是 Swift `RoutineStore` 的逐行移植，它自己跑状态机
/// 并做冲突裁决；原生若再驱动一份 `start` / `complete`，同一个 App 里会有两份状态机各自运算，
/// 必然打架。因此原生侧只保留：设备信息、快照读写、通知、云端解析转发。
///
/// wire 协议的唯一来源是 `web/src/platform/webview.ts`。任何字段不一致都**改这里去适配它**，
/// 而不是反过来改 JS 契约。
@MainActor
struct WebHost: UIViewControllerRepresentable {
    /// 显式由 `MorningMainlineApp` 注入，避免 `@EnvironmentObject` 在 `makeCoordinator()` 时机尚未就绪。
    let store: RoutineStore

    func makeCoordinator() -> Coordinator {
        Coordinator(store: store)
    }

    func makeUIViewController(context: Context) -> WebHostController {
        let controller = WebHostController()
        context.coordinator.attach(to: controller.webView)
        return controller
    }

    func updateUIViewController(_ controller: WebHostController, context: Context) {
        // 桥的一切都由 Coordinator 的事件流驱动，SwiftUI 侧无需随状态刷新。
    }
}

// MARK: - 承载视图

/// 只承载一个铺满可用区域的 `WKWebView`。
final class WebHostController: UIViewController {
    let webView: WKWebView

    init() {
        let configuration = WKWebViewConfiguration()
        // 桥通过 `window.webkit.messageHandlers.mainline` 通信，注册在 Coordinator.attach(to:)。
        configuration.userContentController = WKUserContentController()
        configuration.allowsInlineMediaPlayback = true
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) 未实现")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // 与 Vue 产物的画布同色，避免初始化瞬间露出白底。
        let canvas = UIColor(red: 1.000, green: 0.985, blue: 0.925, alpha: 1)
        view.backgroundColor = canvas
        webView.isOpaque = false
        webView.backgroundColor = canvas
        webView.scrollView.backgroundColor = canvas

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        // 贴安全区：Vue 侧的吸顶工具栏（`position: sticky; top: 0`）不会顶进刘海/状态栏。
        // 代价是顶部/底部各让出一条画布色，与 App 底色一致，观感上无缝。
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif
    }
}

// MARK: - 桥

extension WebHost {
    /// 桥的宿主侧：处理 JS → 原生调用，并把原生事件（快照变更 / 通知点击）推回 JS。
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
        UNUserNotificationCenterDelegate {
        /// 注册名，必须与 `webview.ts:129` 的 `window.webkit?.messageHandlers?.mainline` 一致。
        private static let handlerName = "mainline"

        /// `pendingEvents` 的条数上界。
        ///
        /// 事件积压只发生在「页面刚起步」的极短窗口（`didFinish` 之前，或 `didFinish` 之后
        /// JS bundle 尚未执行完）。封顶是为了防止**页面长期加载失败**时队列无界增长占用内存；
        /// 超界时丢最旧的（越旧的事件对已过时的 UI 越无意义）。
        private static let maxPendingEvents = 32

        /// 单次事件投递失败后的重试间隔（秒）。
        private static let deliveryRetryInterval: TimeInterval = 0.25

        /// 单次事件投递的最大尝试次数（配合间隔 ≈ 5s 总窗口）。
        ///
        /// 覆盖 `didFinish` 之后 JS bundle 仍在解析/执行、`window.__mainlineEmit` 尚未由 JS
        /// `install()` 挂上的窗口——此时 `evaluateJavaScript` 会抛错，重试可补上。
        private static let maxDeliveryAttempts = 20

        private let store: RoutineStore
        private weak var webView: WKWebView?
        private var snapshotSubscription: AnyCancellable?

        /// JS 侧 `window.__mainlineEmit` 是否已就绪。`didFinish` 置 true；开始导航 / 加载失败置 false。
        private var isPageReady = false

        /// 页面就绪前到达的待发事件（按到达顺序）。详见 `maxPendingEvents`。
        private var pendingEvents: [(event: String, payload: [String: Any])] = []

        /// 抑制「JS 自己写快照」引发的一次反向 emit，避免 `snapshot.write` ↔ `snapshot.changed` 回环。
        /// `@Published` 的 sink 是同步触发的，一次性标记即可覆盖那一次变更。
        private var suppressNextSnapshotEmit = false

        /// 前后台通知观察者 token（`didEnterBackground` / `willEnterForeground`）。
        ///
        /// 持有 token 是为了让观察者在本对象存活期间保持注册；闭包内一律 `[weak self]`，
        /// 因此 `self` 销毁后闭包自动哑火，即便 token 未显式移除也不会有强引用环。
        private var appStateObservers: [NSObjectProtocol] = []

        init(store: RoutineStore) {
            self.store = store
            super.init()
        }

        func attach(to webView: WKWebView) {
            self.webView = webView
            webView.navigationDelegate = self

            let controller = webView.configuration.userContentController
            controller.add(self, name: Self.handlerName)
            controller.addUserScript(Self.uuidPolyfillScript)

            // 原生 → JS 的快照广播：Watch / 对端推来的变更经 `store.apply(_:)` 落库后触发。
            snapshotSubscription = store.$snapshot
                .dropFirst() // 跳过订阅瞬间的当前值，只在真正变更时 emit。
                .sink { [weak self] snapshot in
                    guard let self else { return }
                    if self.suppressNextSnapshotEmit {
                        self.suppressNextSnapshotEmit = false
                        return
                    }
                    self.emit(
                        event: "snapshot.changed",
                        payload: ["snapshot": Self.encodeJSONString(snapshot) ?? "null"]
                    )
                }

            // MARK: 通知 delegate（接力：AppDelegate → Coordinator）

            // 让 `notifications.present` 在 App 前台也能横幅展示，并接收点击回跳。
            //
            // 接力关系：`MorningMainlineApp.AppDelegate` 在 `didFinishLaunching` 返回前先设好 delegate，
            // 负责接住「启动 → 本次 attach」这个窗口（冷启动那一击，晚设会被系统丢弃）；
            // attach 之后由本 Coordinator 接替 delegate。两条路径最终都汇到同一个 `notification.opened` 事件。
            UNUserNotificationCenter.current().delegate = self

            // 接管通知信箱：本 Coordinator 成为唯一消费者，从此通知点击直接交付、不再经队列。
            //
            // 用 `installConsumer` 而非「drain 一次」是为了**从根上消除竞态**：`AppDelegate` 的
            // `didReceive` 里那个 `MainActor.run` 闭包若排在本次 attach **之后**才落地，一次性 drain
            // 会漏掉它（那一条会写进再无人 drain 的信箱、永久丢失）。安装消费者后：attach 前到达的
            // 积压在安装瞬间当场交付；attach 后到达的由 `store` 直接调用消费者交付。全部顺序闭合。
            //
            // 此刻 `isPageReady` 通常仍是 `false`，交付进来的事件会被 `emit` 入队、等 `didFinish` flush ——
            // 这正是想要的效果：冷启动那次点击不会因为 WebView 尚未就绪而丢。
            NotificationInbox.installConsumer { [weak self] items in
                for item in items {
                    self?.emit(event: "notification.opened", payload: item)
                }
            }

            // MARK: 前后台状态（原生权威告知 JS）

            // **为什么需要原生显式信号**：JS 侧唯一可用的 `document.visibilityState` /
            // `visibilitychange` 在 WKWebView 里可靠性无法保证 —— App 进入后台时 WKWebView
            // 未必同步派发可见性变化，`visibilityState` 可能停在 `"visible"` 不动。因此前后台
            // 由原生（唯一权威来源）通过 `app.state` 事件显式告知 JS，JS 侧不再依赖 `visibilityState`。
            //
            // **进入前台的三条路径，缺一不可**：
            // - `from background`：`willEnterForeground` 覆盖；
            // - `首次启动`：不触发 `willEnterForeground`，由 `didFinish` 时按真实态补发；
            // - `.inactive → .active`：**只能靠 `didBecomeActive` 覆盖** —— 例如系统通知授权弹窗、
            //   Face ID、来电横幅、控制中心、App 切换器都会让 App 短暂 `.inactive` 再回到 `.active`，
            //   这一段**既不触发** `willEnterForeground` **也不是**页面加载（`didFinish`）。
            //   （`web/src/stores/routine.ts:228` 的 `requestNotificationAuthorization()` 不 await，
            //   会弹系统授权弹窗，正是这条路径的真实触发源。）
            //   漏掉它的后果就是 R1 静默失效：`.inactive` 时若把态发成 `false`，JS 会把提醒全推给
            //   系统通道，而两处 `willPresent` 前台都返回 `[]`，用户在前台看不到任何提醒，直到
            //   下次真正进出后台才自愈。故必须补 `didBecomeActive`。
            //
            // **刻意不加 `willResignActive`**：`.active → .inactive` 期间（拉下控制中心、来电横幅等）
            // **不**发 `visible:false` —— 此时 App 仍是前后台意义上的前台、页面仍然可见，不该把提醒
            // 推给系统通道。我们只观察 `didEnterBackground`（真正的后台）。
            //
            // **幂等**：从后台回来时 `willEnterForeground(true)` 与 `didBecomeActive(true)` 会各发一次
            // `true`；JS 侧 `applyVisibility` 命中 `next === visible.value` 会提前 return，重复无害。
            //
            // 用闭包 + `Task { @MainActor in }` 而非 `@objc` selector：避开与 `@MainActor` 隔离的摩擦。
            appStateObservers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.emitAppState(visible: false) }
            })
            appStateObservers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.emitAppState(visible: true) }
            })
            appStateObservers.append(NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.emitAppState(visible: true) }
            })

            Self.loadStartPage(in: webView)
        }

        // MARK: 启动页加载（本地 file:// vs 开发用 dev server）

        private static func loadStartPage(in webView: WKWebView) {
            #if DEBUG
            // 开发热更新：设 `MAINLINE_WEB_DEV_SERVER=http://localhost:5173` 后从 Xcode Run 即可。
            // 默认不连 —— 否则没有 dev server 时（真机 / 未启动 vite）会是整屏白，难以判断是代码问题。
            let key = "MAINLINE_WEB_DEV_SERVER"
            if let raw = ProcessInfo.processInfo.environment[key],
               !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let url = URL(string: raw) {
                webView.load(URLRequest(url: url))
                return
            }
            #endif
            loadBundled(in: webView)
        }

        /// 生产形态：读 bundle 里的 `dist/index.html`（`web/dist` 以 folder reference 打进 bundle）。
        private static func loadBundled(in webView: WKWebView) {
            guard let url = Bundle.main.url(
                forResource: "index",
                withExtension: "html",
                subdirectory: "dist"
            ) else {
                // 明确报错胜过白屏：多半是忘了先跑 `vite build` 再 `xcodegen generate`。
                webView.loadHTMLString(Self.missingBundleHTML, baseURL: nil)
                return
            }
            // read access 限定在 dist 目录，相对路径 `./assets/...` 才能解析到。
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }

        private static let missingBundleHTML = """
        <!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>不跑偏</title></head>
        <body style="margin:0;padding:24px;font:16px -apple-system;background:#fffbf0;color:#1d1f1d">
        <h2>未找到 web 产物</h2>
        <p>先执行 <code>cd web &amp;&amp; npm run build</code> 生成 <code>web/dist</code>，
        再执行 <code>xcodegen generate</code> 重新打包。</p>
        </body></html>
        """

        // MARK: JS → 原生

        nonisolated func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == Self.handlerName,
                  let body = message.body as? [String: Any],
                  let id = body["id"] as? String,
                  let method = body["method"] as? String
            else { return }
            let params = body["params"] as? [String: Any] ?? [:]
            Task { @MainActor in
                await self.handle(id: id, method: method, params: params)
            }
        }

        private func handle(id: String, method: String, params: [String: Any]) async {
            switch method {
            case "device.info":
                reply(id: id, result: ["id": store.deviceId, "role": Self.deviceRoleWire])

            case "snapshot.read":
                reply(id: id, result: Self.encodeJSONString(store.snapshot) ?? "null")

            case "snapshot.write":
                adoptFromWebView(params["snapshot"])
                reply(id: id)

            case "notifications.requestAuthorization":
                // 必须等它完成再回执；`granted` 以随后的系统设置为准（scheduler 不返回结果）。
                await ReminderScheduler.shared.requestAuthorization()
                let granted = await Self.notificationsAuthorized()
                reply(id: id, result: ["granted": granted])

            case "notifications.replace":
                let session = Self.decodeSession(params["session"])
                await ReminderScheduler.shared.replaceNotifications(session: session)
                reply(id: id)

            case "notifications.present":
                await presentLocalNotification(params)
                reply(id: id)

            case "parse.withModel":
                let parsed = await parseWithModel(params["input"] as? String ?? "")
                reply(id: id, result: parsed ?? NSNull())

            default:
                reply(id: id, ok: false, error: "未知桥方法：\(method)")
            }
        }

        /// `device.info` 的 role（iPad → pad）。
        private static var deviceRoleWire: String {
            UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone"
        }

        /// `snapshot.write`：用 JS（本机 UI 层）的权威快照替换，不重写 updatedAt / originID / revision。
        private func adoptFromWebView(_ raw: Any?) {
            guard let text = raw as? String,
                  let data = text.data(using: .utf8),
                  let snapshot = try? JSONDecoder().decode(RoutineSnapshot.self, from: data)
            else { return }

            // JS 自己写进来的那份变更不要再 emit 回 JS，否则 `write → changed → apply → …` 回环。
            suppressNextSnapshotEmit = true
            store.adoptFromWebView(snapshot)
        }

        /// `notifications.replace` 的 params.session 是**单个会话**的线格式对象（不是快照）。
        private static func decodeSession(_ raw: Any?) -> RoutineSession? {
            guard let raw, !(raw is NSNull),
                  let data = try? JSONSerialization.data(withJSONObject: raw)
            else { return nil }
            return try? JSONDecoder().decode(RoutineSession.self, from: data)
        }

        private static func notificationsAuthorized() async -> Bool {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            return status == .authorized || status == .provisional || status == .ephemeral
        }

        private func presentLocalNotification(_ params: [String: Any]) async {
            let content = UNMutableNotificationContent()
            content.title = params["title"] as? String ?? "不跑偏"
            content.body = params["body"] as? String ?? ""
            content.sound = .default
            if params["level"] as? String == "timeSensitive" {
                content.interruptionLevel = .timeSensitive
            }
            // trigger = nil → 立即投递；前台展示由 willPresent 放开。
            let request = UNNotificationRequest(
                identifier: "morning-mainline-present-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            try? await UNUserNotificationCenter.current().add(request)
        }

        /// `parse.withModel`：转发现有的增强解析服务。
        /// **安全边界（§7）：API Key 只留在原生侧，绝不进 web 产物。**
        private func parseWithModel(_ input: String) async -> Any? {
            guard let enhanced = RoutineParsing.current.enhanced,
                  let parsed = try? await enhanced.parse(input, now: Date())
            else { return nil }
            return Self.encodeParseResultWire(parsed)
        }

        /// 编码成与 `webview.ts:decodeParseResultWire` 逐字段一致的线格式。
        ///
        /// 对照（左 = JS 读取的字段，右 = 这里的产出）：
        /// - `id`        ← `RoutineStep.id`（UUID 字符串）
        /// - `title`     ← `RoutineStep.title`
        /// - `prompt`    ← `RoutineStep.prompt`
        /// - `duration`  ← `RoutineStep.duration`（秒，Double）
        /// - `importance`← `RoutineStep.importance`（"normal" | "hardDeadline"）
        /// - `role`      ← `RoutineStep.role`（"task" | "deadline"）
        /// - `deadline`  ← `RoutineParseResult.deadline`（**Apple 参考秒 Double**，nil 时键缺失，JS 按 null 处理）
        /// - `source`    ← `RoutineParseSource.rawValue`（"rule" | "enhanced"）
        /// - `leftover`  ← `RoutineParseResult.leftover`
        ///
        /// `JSONEncoder` 默认 `.deferredToDate` 恰好就是 Apple 参考秒，与 JS `refSecondsToMs` 对齐。
        private static func encodeParseResultWire(_ result: RoutineParseResult) -> Any? {
            struct Wire: Encodable {
                let steps: [RoutineStep]
                let deadline: Date?
                let source: String
                let leftover: String
            }
            let wire = Wire(
                steps: result.steps,
                deadline: result.deadline,
                source: result.source.rawValue,
                leftover: result.leftover
            )
            guard let data = try? JSONEncoder().encode(wire),
                  let object = try? JSONSerialization.jsonObject(with: data)
            else { return nil }
            return object
        }

        // MARK: 原生 → JS

        /// 回执：`window.__mainlineReply({id, ok, result?, error?})`（`webview.ts` 按 id 匹配）。
        private func reply(id: String, ok: Bool = true, result: Any = NSNull(), error: String? = nil) {
            var payload: [String: Any] = ["id": id, "ok": ok]
            if ok {
                payload["result"] = result
            } else {
                payload["error"] = error ?? "原生桥处理失败"
            }
            guard let json = Self.jsonString(payload) else { return }
            evaluate("window.__mainlineReply(\(json))")
        }

        /// 事件：`window.__mainlineEmit(event, payload)`。
        ///
        /// 页面（含 JS bundle）尚未就绪时**入队缓冲**，待 `didFinish`（或 JS 挂载补上后）flush。
        /// 修掉的原缺陷：原先直接 `evaluateJavaScript` 并忽略错误，若此刻 `window.__mainlineEmit`
        /// 尚未由 JS `install()` 挂上则会抛错、事件永久丢失（典型场景：用户点系统通知冷启动 App）。
        private func emit(event: String, payload: [String: Any]) {
            guard isPageReady else {
                if pendingEvents.count >= Self.maxPendingEvents {
                    pendingEvents.removeFirst()
                }
                pendingEvents.append((event: event, payload: payload))
                return
            }
            deliver(event: event, payload: payload, attempt: 1)
        }

        /// 把前后台状态显式推给 JS（`app.state` 事件，载荷 `["visible": Bool]`）。
        ///
        /// 线格式契约（与 `web/src/platform/webview.ts` 的 `handleEmit` 的 `app.state` 分支严格一致，不得擅改）：
        /// - 事件名：`"app.state"`
        /// - 载荷：`["visible": <Bool>]`，键名必须是 `"visible"`
        ///
        /// 复用 `emit(event:payload:)`，因此自动继承「页面就绪前入队 / `didFinish` 后按序 flush /
        /// `evaluateJavaScript` 失败延迟重试」的全部投递保障，不另起投递路径。
        private func emitAppState(visible: Bool) {
            emit(event: "app.state", payload: ["visible": visible])
        }

        /// 投递单个事件；`evaluateJavaScript` 带回非 nil error 且未达尝试上界时，延迟后重试。
        private func deliver(event: String, payload: [String: Any], attempt: Int) {
            guard let json = Self.jsonString(payload), let webView else { return }
            let script = "window.__mainlineEmit('\(event)', \(json))"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                guard let error else { return } // 成功：无 error。
                guard let self, attempt < Self.maxDeliveryAttempts else { return }
                Task { @MainActor in
                    try? await Task.sleep(
                        nanoseconds: UInt64(Self.deliveryRetryInterval * 1_000_000_000)
                    )
                    self.deliver(event: event, payload: payload, attempt: attempt + 1)
                }
            }
        }

        // MARK: 导航代理（页面就绪态 + 待发事件 flush）

        /// 开始导航：重新进入缓冲态（页面重载后 `window.__mainlineEmit` 需 JS 重新挂载）。
        nonisolated func webView(
            _ webView: WKWebView,
            didStartProvisionalNavigation navigation: WKNavigation!
        ) {
            Task { @MainActor in
                self.isPageReady = false
            }
        }

        /// 页面加载完成：标记就绪，并按到达顺序 flush 待发队列。
        /// 注意：`didFinish` 只保证文档加载完毕，JS bundle 可能仍在执行；未挂上时靠 `deliver` 重试补上。
        nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                self.isPageReady = true
                let buffered = self.pendingEvents
                self.pendingEvents.removeAll()
                for item in buffered {
                    self.deliver(event: item.event, payload: item.payload, attempt: 1)
                }
                // 页面就绪后按真实态补发一次。**只在 `.active` 时发 `true`，其余情况什么都不发**：
                // - 它覆盖**首次启动**：冷启动不会触发 `willEnterForeground`，光靠观察者 JS 收不到初始态。
                // - **`.inactive` / `.background` 时故意不发**：`.inactive` 是过渡态（授权弹窗 / Face ID /
                //   来电横幅…），JS 侧默认值本就是 `true`，此刻发 `false` 是**主动写入错误信息**（即 R1
                //   静默失效）；改由 `didBecomeActive` 在真正转正时纠正。`.background` 时也无需补发：
                //   `didEnterBackground` 已经（或将）发出 `false`，它会经既有队列/flush 正常送达。
                //
                // 必须在 flush 循环**之后**：顺序保证「先补历史事件，再纠正当前态」，
                // 否则一条迟到的陈旧 `app.state` 可能覆盖掉刚补的真实态。
                if UIApplication.shared.applicationState == .active {
                    self.emitAppState(visible: true)
                }
            }
        }

        /// 加载失败：退回缓冲态，但**保留**待发队列（页面稍后可能重试成功，事件不应丢）。
        nonisolated func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            Task { @MainActor in
                self.isPageReady = false
            }
        }

        /// 已提交导航阶段失败：同样退回缓冲态并保留队列。
        nonisolated func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            Task { @MainActor in
                self.isPageReady = false
            }
        }

        private func evaluate(_ script: String) {
            webView?.evaluateJavaScript(script, completionHandler: nil)
        }

        /// 用 `JSONSerialization` 生成 JSON 片段（**不手工拼字符串**），再作为 JS 字面量注入。
        /// JSON 是 JS 表达式语法的子集，故 `window.__mainlineReply(<json>)` 始终是合法调用。
        private static func jsonString(_ object: [String: Any]) -> String? {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object)
            else { return nil }
            return String(data: data, encoding: .utf8)
        }

        private static func encodeJSONString<T: Encodable>(_ value: T) -> String? {
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        }

        // MARK: 通知代理（前台展示 + 点击回跳）

        /// `willPresent` **只在 App 处于前台时**被调用。
        ///
        /// 前台通道交由 WebView 承载的 Vue 侧页内弹窗（`web/src/stores/reminders.ts` 的引擎）负责展示；
        /// 若这里再放行横幅，同一条提醒会出现两份（ARCHITECTURE §6「应用内弹窗覆盖前台、
        /// 系统通知覆盖后台/锁屏」）。因此前台一律不放行（返回 `[]`）。
        ///
        /// 这里**故意不加 `.list`**：前台通道既然交给页内弹窗，就不该再往通知中心留一份副本。
        ///
        /// 交叉引用：`MorningMainlineApp.AppDelegate` 的同名实现也返回 `[]`（同一策略）——
        /// 冷启动到 attach 之间由 AppDelegate 担任 delegate，attach 之后由本 Coordinator 担任，
        /// 两处必须保持同一前台策略，否则窗口切换的瞬间会出现行为不一致。
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            []
        }

        /// attach 之后到达的通知点击：直接 emit 给 JS（此时 delegate 已由本 Coordinator 担任）。
        ///
        /// 载荷抽取与冷启动窗口共用 `NotificationInbox.notificationOpenedPayload(from:)`，
        /// 保证两条路径产出的 `notification.opened` 载荷**逐字一致**，不留两份拷贝。
        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            guard let payload = NotificationInbox.notificationOpenedPayload(from: response) else {
                return
            }
            await MainActor.run {
                self.emit(event: "notification.opened", payload: payload)
            }
        }

        // MARK: crypto.randomUUID 兜底

        /// `crypto.randomUUID()` 只在**安全上下文**可用。`file://` 下 WebKit 未必把它视为安全上下文，
        /// 一旦缺失，JS 侧 `core/types.ts` 与 `webview.ts` 的 id 生成会全盘失效。
        /// 这里在文档开始前补一个等价实现（优先 `getRandomValues`，退化为 `Math.random`）。
        private static let uuidPolyfillScript: WKUserScript = {
            let source = """
            (function () {
              var c = window.crypto;
              if (!c) { return; }
              if (typeof c.randomUUID === 'function') { return; }
              c.randomUUID = function () {
                var b = new Uint8Array(16);
                if (typeof c.getRandomValues === 'function') {
                  c.getRandomValues(b);
                } else {
                  for (var i = 0; i < 16; i += 1) { b[i] = Math.floor(Math.random() * 256); }
                }
                b[6] = (b[6] & 15) | 64;
                b[8] = (b[8] & 63) | 128;
                var hex = [];
                for (var j = 0; j < 16; j += 1) {
                  hex.push((b[j] + 256).toString(16).slice(1));
                }
                return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
                  hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
                  hex.slice(10, 16).join('');
              };
            })();
            """
            return WKUserScript(
                source: source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        }()
    }
}

// MARK: - 通知信箱

extension WebHost {
    /// 接住「App 启动 → WebView attach」窗口内到达的通知点击，并在 attach 后交给消费者直接投递。
    ///
    /// 背景：`UNUserNotificationCenter` 的 delegate 若不在 `didFinishLaunching` 返回前设好，
    /// 冷启动点通知的那一次 `didReceive` 会被系统丢弃。改由 `MorningMainlineApp.AppDelegate`
    /// 在最早入口设好 delegate 后，它本身**没有**可投递的 WebView（`WebHost` 尚未 attach），
    /// 遂把载荷暂存到本信箱；待 `Coordinator.attach(to:)` 安装消费者时当场交付
    /// （若页面未就绪则入队，等 `didFinish` flush）。attach 之后的点击由消费者直接交付、不再经队列。
    ///
    /// **为什么需要「消费者」而非一次性 drain**：`AppDelegate.didReceive` 那个 `MainActor.run`
    /// 闭包若排在 `attach` **之后**才落地，而 attach 已经 drain 过一次（信箱当时为空），一次性 drain
    /// 会漏掉这条 —— 它会被写进再无人 drain 的信箱、永久丢失（`attach`/`drain` 全仓仅一处调用，不会自愈）。
    /// 安装消费者后：attach 前积压的当场交付；attach 后到达的直接交付。全部顺序闭合。
    @MainActor
    enum NotificationInbox {
        /// 待回跳载荷的条数上界。
        ///
        /// 消费者安装**之前**才需要此队列：页面长期加载不出来（web 产物缺失 / 持续崩溃）且尚未 attach
        /// 时，若持续累积就会无界增长占用内存。封顶 32 与 `Coordinator.maxPendingEvents`
        /// 对称；超界时丢最旧的 —— 用户当下的意图以最新一次点击为准。
        private static let maxPending = 32

        /// 已安装的消费者。非 nil 表示 attach 已完成，此后载荷直接交付、不再入队。
        private static var consumer: (([[String: Any]]) -> Void)?

        /// 待回跳的通知点击载荷（按到达顺序）；仅在消费者安装前使用。
        private static var pending: [[String: Any]] = []

        /// 安装消费者并**接管**信箱：先把当前积压当场交付，此后到达的直接交付、不再经队列。
        ///
        /// 只允许安装一次（由 `Coordinator.attach(to:)` 调用）。安装即接管：残留的 `pending` 全部
        /// 取出清空并立即交付，保证 attach 前到达的点击不丢。
        static func installConsumer(_ c: @escaping ([[String: Any]]) -> Void) {
            consumer = c
            let items = pending
            pending.removeAll()
            if !items.isEmpty {
                c(items)
            }
        }

        /// 接住一次通知点击。载荷为空（三个字段都取不到）时忽略。
        ///
        /// 若消费者已安装则**直接交付**（途经队列反而引入延迟与遗漏风险）；否则入队，
        /// 超 `maxPending` 时丢最旧。
        static func store(response: UNNotificationResponse) {
            guard let payload = notificationOpenedPayload(from: response) else { return }
            if let consumer {
                consumer([payload])
                return
            }
            if pending.count >= maxPending {
                pending.removeFirst()
            }
            pending.append(payload)
        }

        /// `UNNotificationResponse` → `notification.opened` 载荷。**载荷抽取的单一来源**：
        /// 冷启动窗口的 `NotificationInbox.store` 与 attach 之后的
        /// `Coordinator.userNotificationCenter(_:didReceive:)` 两处共用此函数，不再各留一份拷贝。
        ///
        /// 逻辑与原 `Coordinator` 实现逐字一致：读 `userInfo` 的 `progressID`（String）、
        /// `sessionID`（String）、`minuteOffset`（Int），取到哪个填哪个；三者都取不到返回 `nil`。
        ///
        /// 标记 `nonisolated`：这是纯函数，不触碰任何 actor 状态，因此既能被 `@MainActor` 的
        /// `store` 直接调用，也能被 `nonisolated` 的 `didReceive` 直接调用，无需额外的 actor 跳转。
        nonisolated static func notificationOpenedPayload(
            from response: UNNotificationResponse
        ) -> [String: Any]? {
            let info = response.notification.request.content.userInfo
            var payload: [String: Any] = [:]
            if let value = info["progressID"] as? String { payload["progressID"] = value }
            if let value = info["sessionID"] as? String { payload["sessionID"] = value }
            if let value = info["minuteOffset"] as? Int { payload["minuteOffset"] = value }
            return payload.isEmpty ? nil : payload
        }
    }
}
