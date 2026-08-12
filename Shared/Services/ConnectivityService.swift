import Foundation

#if canImport(WatchConnectivity)
import WatchConnectivity

@MainActor
final class ConnectivityService: NSObject, WCSessionDelegate {
    private let session = WCSession.default
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    var onSnapshot: ((RoutineSnapshot) -> Void)?

    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    func publish(_ snapshot: RoutineSnapshot) {
        guard session.activationState == .activated,
              let data = try? encoder.encode(snapshot)
        else { return }

        let payload: [String: Any] = ["snapshot": data]
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
    ) {}

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
        guard
            let data = payload["snapshot"] as? Data,
            let snapshot = try? JSONDecoder().decode(RoutineSnapshot.self, from: data)
        else { return }
        Task { @MainActor [weak self] in self?.onSnapshot?(snapshot) }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
    #endif
}
#else
@MainActor
final class ConnectivityService {
    var onSnapshot: ((RoutineSnapshot) -> Void)?
    func publish(_ snapshot: RoutineSnapshot) {}
}
#endif

