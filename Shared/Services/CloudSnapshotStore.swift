import Foundation

@MainActor
final class CloudSnapshotStore {
    private let cloud = NSUbiquitousKeyValueStore.default
    private let key = "morning-mainline.snapshot.v1"
    private var observer: NSObjectProtocol?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    var onSnapshot: ((RoutineSnapshot) -> Void)?

    init() {
        observer = NotificationCenter.default.addObserver(
            forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
            object: cloud,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.readRemote() }
        }
        cloud.synchronize()
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    func publish(_ snapshot: RoutineSnapshot) {
        guard let data = try? encoder.encode(snapshot) else { return }
        cloud.set(data, forKey: key)
        cloud.synchronize()
    }

    func readRemote() {
        guard
            let data = cloud.data(forKey: key),
            let snapshot = try? decoder.decode(RoutineSnapshot.self, from: data)
        else { return }
        onSnapshot?(snapshot)
    }
}

