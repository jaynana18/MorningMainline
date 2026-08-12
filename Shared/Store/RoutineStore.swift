import Foundation
import SwiftUI

@MainActor
final class RoutineStore: ObservableObject {
    @Published private(set) var snapshot: RoutineSnapshot

    let deviceRole: DeviceRole
    private let localKey = "morning-mainline.local-snapshot.v1"
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

    var currentStep: RoutineStep? {
        guard let session else { return nil }
        return snapshot.template.steps
            .filter { session.progress(for: $0)?.state == .pending }
            .min { lhs, rhs in
                let left = session.progress(for: lhs)?.dueAt ?? .distantFuture
                let right = session.progress(for: rhs)?.dueAt ?? .distantFuture
                return left < right
            }
    }

    func startToday(now: Date = Date()) {
        let progress = snapshot.template.steps.map { step in
            StepProgress(
                stepID: step.id,
                dueAt: step.dueDate(startedAt: now),
                state: .pending,
                snoozeCount: 0,
                completedAt: nil
            )
        }
        snapshot.activeSession = RoutineSession(
            id: UUID(),
            templateID: snapshot.template.id,
            startedAt: now,
            state: .running,
            primaryDevice: deviceRole,
            progress: progress,
            updatedAt: now,
            revision: 1
        )
        commit()
    }

    func complete(_ step: RoutineStep) {
        mutateProgress(step) { progress in
            progress.state = .completed
            progress.completedAt = Date()
        }
    }

    func snooze(_ step: RoutineStep) {
        guard let session,
              let progress = session.progress(for: step),
              progress.snoozeCount < step.maxSnoozeCount
        else { return }
        mutateProgress(step) { progress in
            progress.dueAt = Date().addingTimeInterval(step.snoozeSeconds)
            progress.snoozeCount += 1
        }
    }

    func cancel() {
        snapshot.activeSession?.state = .cancelled
        commit()
    }

    func finish() {
        snapshot.activeSession?.state = .completed
        commit()
    }

    private func mutateProgress(_ step: RoutineStep, update: (inout StepProgress) -> Void) {
        guard
            var session = snapshot.activeSession,
            let index = session.progress.firstIndex(where: { $0.stepID == step.id })
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

    private func saveLocally() {
        guard let data = try? encoder.encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: localKey)
    }

    private func rescheduleIfNeeded() {
        let shouldSchedule = snapshot.activeSession?.primaryDevice == deviceRole
            || deviceRole == .phone
        Task {
            await ReminderScheduler.shared.replaceNotifications(
                template: snapshot.template,
                session: shouldSchedule ? snapshot.activeSession : nil
            )
        }
    }
}

