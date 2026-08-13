import Foundation
import UserNotifications

actor ReminderScheduler {
    static let shared = ReminderScheduler()

    private let center = UNUserNotificationCenter.current()
    private let categoryID = "MORNING_MAINLINE_STEP"

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func replaceNotifications(session: RoutineSession?) async {
        let existing = await center.pendingNotificationRequests()
        let identifiers = existing
            .map(\.identifier)
            .filter { $0.hasPrefix("morning-mainline-") }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)

        guard let session, session.state == .running else { return }

        for progress in session.progress where progress.state == .pending && progress.dueAt > Date() {
            let step = progress.step

            let content = UNMutableNotificationContent()
            content.title = step.importance == .hardDeadline ? "🚨 \(step.title)" : "不跑偏 · \(step.title)"
            content.body = step.prompt
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.userInfo = ["progressID": progress.id.uuidString]

            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, progress.dueAt.timeIntervalSinceNow),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "morning-mainline-\(session.id.uuidString)-\(progress.id.uuidString)",
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
    }
}
