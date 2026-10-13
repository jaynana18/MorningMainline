import Foundation

#if canImport(WatchConnectivity)
import WatchConnectivity

/// iPhone ↔ Apple Watch 的同步通道。
///
/// 承载两类载荷，各有独立的回调：
/// - `snapshot`：任务数据（原有）。
/// - `settings`：跨设备共用的轻量设置，目前是高德 Web 服务 Key 与出行方式
///   （见 `MainlineSettings`）——App Group 做不到跨设备，必须走这里。
///
/// 两者合用一个 `applicationContext` 字典但用不同的 key。**发送时必须把两份都带上**：
/// `updateApplicationContext` 是整字典替换，各自单独发会互相把对方清掉。
/// 因此这里累计「最后一次发出的值」（`latestSnapshot` / `latestSettings`），
/// 而不是只发本次变更的那一份 —— 否则一次只改 Key 的发送会把快照从本机 context 里抹掉，
/// 新装的设备就再也追不回任务数据了。
@MainActor
final class ConnectivityService: NSObject, WCSessionDelegate {
    private let session = WCSession.default
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// 累计值：一旦发过就记住，供后续 payload 拼装。
    private var latestSnapshot: RoutineSnapshot?
    private var latestSettings: MainlineSettings?
    /// 是否有尚未发出的变更。
    private var hasPending = false

    /// 对端数据先到、回调后挂时暂存这里，回调一挂上立即交付。
    private var pendingIncomingSnapshot: RoutineSnapshot?
    private var pendingIncomingSettings: MainlineSettings?

    var onSnapshot: ((RoutineSnapshot) -> Void)? {
        didSet {
            guard let pendingIncomingSnapshot else { return }
            self.pendingIncomingSnapshot = nil
            onSnapshot?(pendingIncomingSnapshot)
        }
    }

    var onSettings: ((MainlineSettings) -> Void)? {
        didSet {
            guard let pendingIncomingSettings else { return }
            self.pendingIncomingSettings = nil
            onSettings?(pendingIncomingSettings)
        }
    }

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    func publish(_ snapshot: RoutineSnapshot) {
        latestSnapshot = snapshot
        hasPending = true
        flush()
    }

    func publish(_ settings: MainlineSettings) {
        latestSettings = settings
        hasPending = true
        flush()
    }

    /// 组装完整载荷；没有可用内容时返回 nil。成功取到即视为「变更已发出」。
    private func makePayload() -> [String: Any]? {
        guard hasPending else { return nil }
        var payload: [String: Any] = [:]
        if let snapshot = latestSnapshot, let data = try? encoder.encode(snapshot) {
            payload["snapshot"] = data
        }
        if let settings = latestSettings, let data = try? encoder.encode(settings) {
            payload["settings"] = data
        }
        guard !payload.isEmpty else {
            hasPending = false
            return nil
        }
        hasPending = false
        return payload
    }

    private func flush() {
        guard session.activationState == .activated, let payload = makePayload() else { return }

        try? session.updateApplicationContext(payload)

        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil) { [weak self] _ in
                self?.session.transferUserInfo(payload)
            }
        } else {
            session.transferUserInfo(payload)
        }
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            self?.flush()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        decode(message)
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        decode(applicationContext)
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        decode(userInfo)
    }

    private nonisolated func decode(_ payload: [String: Any]) {
        let decoder = JSONDecoder()
        let snapshot = (payload["snapshot"] as? Data).flatMap {
            try? decoder.decode(RoutineSnapshot.self, from: $0)
        }
        let settings = (payload["settings"] as? Data).flatMap {
            try? decoder.decode(MainlineSettings.self, from: $0)
        }
        guard snapshot != nil || settings != nil else { return }

        Task { @MainActor [weak self] in
            guard let self else { return }
            if let snapshot {
                if let onSnapshot {
                    onSnapshot(snapshot)
                } else {
                    pendingIncomingSnapshot = snapshot
                }
            }
            if let settings {
                if let onSettings {
                    onSettings(settings)
                } else {
                    pendingIncomingSettings = settings
                }
            }
        }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
    #endif
}
#else
/// 无 WatchConnectivity 的平台用这个空实现占位，行为等价于「没有对端」，
/// 免得调用方到处写 `#if`。
@MainActor
final class ConnectivityService {
    var onSnapshot: ((RoutineSnapshot) -> Void)?
    var onSettings: ((MainlineSettings) -> Void)?
    func publish(_ snapshot: RoutineSnapshot) {}
    func publish(_ settings: MainlineSettings) {}
}
#endif
