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
    final class Coordinator: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
        /// 注册名，必须与 `webview.ts:129` 的 `window.webkit?.messageHandlers?.mainline` 一致。
        private static let handlerName = "mainline"

        private let store: RoutineStore
        private weak var webView: WKWebView?
        private var snapshotSubscription: AnyCancellable?

        /// 抑制「JS 自己写快照」引发的一次反向 emit，避免 `snapshot.write` ↔ `snapshot.changed` 回环。
        /// `@Published` 的 sink 是同步触发的，一次性标记即可覆盖那一次变更。
        private var suppressNextSnapshotEmit = false

        init(store: RoutineStore) {
            self.store = store
            super.init()
        }

        func attach(to webView: WKWebView) {
            self.webView = webView

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

            // 让 `notifications.present` 在 App 前台也能横幅展示，并接收点击回跳。
            UNUserNotificationCenter.current().delegate = self

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
        private func emit(event: String, payload: [String: Any]) {
            guard let json = Self.jsonString(payload) else { return }
            evaluate("window.__mainlineEmit('\(event)', \(json))")
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

        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .sound]
        }

        nonisolated func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            let info = response.notification.request.content.userInfo
            var payload: [String: Any] = [:]
            if let value = info["progressID"] as? String { payload["progressID"] = value }
            if let value = info["sessionID"] as? String { payload["sessionID"] = value }
            if let value = info["minuteOffset"] as? Int { payload["minuteOffset"] = value }
            guard !payload.isEmpty else { return }
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
