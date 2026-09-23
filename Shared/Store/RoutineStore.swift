import Foundation
import SwiftUI

@MainActor
final class RoutineStore: ObservableObject {
    @Published private(set) var snapshot: RoutineSnapshot

    let deviceRole: DeviceRole
    /// 供 WebView 宿主（`iOS/WebHost.swift`）读取的稳定设备 id。
    /// **必须与私有 `deviceID` 同源**：JS 侧会把 `device.info` 的 id 当作自己的 `originID`，
    /// 一旦两边不一致，`apply(_:)` 的 `originID != deviceID` 过滤就会失效 → 同步自激。
    var deviceId: String { deviceID.uuidString }
    private let localKey = "morning-mainline.local-snapshot.v2"
    private let deviceID: UUID
    private let cloud = CloudSnapshotStore()
    private let connectivity = ConnectivityService()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(deviceRole: DeviceRole) {
        self.deviceRole = deviceRole
        let deviceIDKey = "morning-mainline.device-id"
        if let value = UserDefaults.standard.string(forKey: deviceIDKey),
           let id = UUID(uuidString: value) {
            deviceID = id
        } else {
            let id = UUID()
            deviceID = id
            UserDefaults.standard.set(id.uuidString, forKey: deviceIDKey)
        }

        if let data = UserDefaults.standard.data(forKey: localKey),
           let saved = try? decoder.decode(RoutineSnapshot.self, from: data) {
            snapshot = saved
        } else {
            snapshot = .initial
        }

        cloud.onSnapshot = { [weak self] incoming in self?.apply(incoming) }
        connectivity.onSnapshot = { [weak self] incoming in self?.apply(incoming) }
        cloud.readRemote()

        Task { await ReminderScheduler.shared.requestAuthorization() }
    }

    var session: RoutineSession? { snapshot.activeSession }

    var currentProgress: StepProgress? {
        guard let session, session.state == .running else { return nil }
        return session.progress
            .filter { $0.state == .pending }
            .min { $0.dueAt < $1.dueAt }
    }

    var nextProgress: [StepProgress] {
        guard let session else { return [] }
        return session.progress
            .filter { $0.state == .pending }
            .sorted { $0.dueAt < $1.dueAt }
    }

    func template(with id: UUID) -> RoutineTemplate? {
        snapshot.templates.first(where: { $0.id == id })
    }

    func addTemplate(_ template: RoutineTemplate) {
        snapshot.templates.insert(template, at: 0)
        commit()
    }

    func start(
        _ template: RoutineTemplate,
        deadlineOverride: Date? = nil,
        now: Date = Date()
    ) {
        let deadline = template.mode == .backward
            ? (deadlineOverride ?? template.deadline(on: now))
            : nil
        let plannedStart = deadline.map { $0.addingTimeInterval(-template.totalTaskDuration - template.buffer) } ?? now
        var cursor = now
        let availableSlack = deadline.map { $0.timeIntervalSince(now) - template.totalTaskDuration }
        let remainingBuffer = max(0, availableSlack ?? template.buffer)
        let deadlineOverrun = max(0, -(availableSlack ?? 0))
        var progress: [StepProgress] = []

        for step in template.steps {
            if step.role == .deadline, let deadline {
                progress.append(StepProgress(step: step, dueAt: deadline.addingTimeInterval(deadlineOverrun)))
                continue
            }
            cursor = cursor.addingTimeInterval(step.duration)
            progress.append(StepProgress(step: step, dueAt: cursor))
        }

        snapshot.activeSession = RoutineSession(
            id: UUID(),
            templateID: template.id,
            templateName: template.name,
            templateSymbol: template.symbol,
            startedAt: now,
            plannedStartAt: plannedStart,
            targetDeadline: deadline,
            state: .running,
            primaryDevice: deviceRole,
            progress: progress,
            remainingBuffer: remainingBuffer,
            updatedAt: now,
            revision: 1
        )
        commit()
    }

    func complete(_ progress: StepProgress) {
        mutateProgress(progress.id) { item in
            item.state = .completed
            item.completedAt = Date()
        }
    }

    /// “两分钟后再提醒”不是单纯隐藏通知，而是把真实计划向后推。
    func snoozeCurrent(by seconds: TimeInterval = 2 * 60) {
        guard let currentProgress else { return }
        applyDelay(after: currentProgress.id, by: seconds, incrementSnooze: true)
    }

    func addTemporaryTask(title: String, minutes: Int) {
        guard var session = snapshot.activeSession,
              let current = currentProgress,
              minutes > 0
        else { return }

        let duration = TimeInterval(minutes * 60)
        let temporary = RoutineStep(
            title: title,
            prompt: "这是临时插入的事，做完立刻回主线",
            duration: duration
        )
        applyDelay(after: current.id, by: duration, incrementSnooze: false)
        guard var updated = snapshot.activeSession,
              let insertionIndex = updated.progress.firstIndex(where: { $0.id == current.id })
        else { return }
        let dueAt = Date().addingTimeInterval(duration)
        updated.progress.insert(
            StepProgress(step: temporary, dueAt: dueAt, isTemporary: true),
            at: insertionIndex
        )
        updated.revision += 1
        updated.updatedAt = Date()
        session = updated
        snapshot.activeSession = session
        commit()
    }

    func cancel() {
        snapshot.activeSession?.state = .cancelled
        commit()
    }

    func finish() {
        snapshot.activeSession?.state = .completed
        commit()
    }

    private func applyDelay(after progressID: UUID, by seconds: TimeInterval, incrementSnooze: Bool) {
        guard var session = snapshot.activeSession,
              let index = session.progress.firstIndex(where: { $0.id == progressID })
        else { return }

        let bufferUsed = min(session.remainingBuffer, seconds)
        let overrun = max(0, seconds - session.remainingBuffer)
        session.remainingBuffer = max(0, session.remainingBuffer - bufferUsed)

        for itemIndex in session.progress.indices where itemIndex >= index && session.progress[itemIndex].state == .pending {
            if session.progress[itemIndex].step.role == .deadline {
                session.progress[itemIndex].dueAt = session.progress[itemIndex].dueAt.addingTimeInterval(overrun)
            } else {
                session.progress[itemIndex].dueAt = session.progress[itemIndex].dueAt.addingTimeInterval(seconds)
            }
        }
        if incrementSnooze {
            session.progress[index].snoozeCount += 1
        }

        session.revision += 1
        session.updatedAt = Date()
        snapshot.activeSession = session
        commit()
    }

    private func mutateProgress(_ progressID: UUID, update: (inout StepProgress) -> Void) {
        guard var session = snapshot.activeSession,
              let index = session.progress.firstIndex(where: { $0.id == progressID })
        else { return }

        update(&session.progress[index])
        session.revision += 1
        session.updatedAt = Date()
        if session.progress.allSatisfy({ $0.state != .pending }) {
            session.state = .completed
        }
        snapshot.activeSession = session
        commit()
    }

    private func commit() {
        snapshot.updatedAt = Date()
        snapshot.originID = deviceID
        saveLocally()
        cloud.publish(snapshot)
        connectivity.publish(snapshot)
        rescheduleIfNeeded()
    }

    private func apply(_ incoming: RoutineSnapshot) {
        guard incoming.originID != deviceID else { return }
        let incomingRevision = incoming.activeSession?.revision ?? 0
        let currentRevision = snapshot.activeSession?.revision ?? 0
        guard incomingRevision > currentRevision || incoming.updatedAt > snapshot.updatedAt else { return }

        snapshot = incoming
        saveLocally()
        rescheduleIfNeeded()
    }

    /// 用 WebView 宿主（JS 侧已自行完成状态机运算与冲突裁决）传来的快照替换本机快照。
    ///
    /// 与 `apply(_:)` 的区别：`apply` 是「对端推来的，需裁决」；本方法是「本机 UI 层的权威快照，
    /// 直接采纳」。**因此不改写 `updatedAt` / `originID` / `revision`** —— 那些由 JS 侧权威维护，
    /// 原生改了会和 JS 的裁决逻辑互相打架。`commit()` 顺带做的广播与重排通知在这里照做。
    func adoptFromWebView(_ incoming: RoutineSnapshot) {
        snapshot = incoming
        saveLocally()
        connectivity.publish(snapshot)
        rescheduleIfNeeded()
    }

    private func saveLocally() {
        guard let data = try? encoder.encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: localKey)
    }

    private func rescheduleIfNeeded() {
        let shouldSchedule = snapshot.activeSession?.primaryDevice == deviceRole || deviceRole == .phone
        Task {
            await ReminderScheduler.shared.replaceNotifications(
                session: shouldSchedule ? snapshot.activeSession : nil
            )
        }
    }
}
