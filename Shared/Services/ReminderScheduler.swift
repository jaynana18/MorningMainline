import Foundation
import UserNotifications

actor ReminderScheduler {
    static let shared = ReminderScheduler()

    private let center = UNUserNotificationCenter.current()
    private let categoryID = "MORNING_MAINLINE_STEP"

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func replaceNotifications(template: RoutineTemplate, session: RoutineSession?) async {
        let existing = await center.pendingNotificationRequests()
        let identifiers = existing
            .map(\.identifier)
            .filter { $0.hasPrefix("morning-mainline-") }
        center.removePendingNotificationRequests(withIdentifiers: identifiers)

        guard let session, session.state == .running else { return }

        for step in template.steps {
            guard
                let progress = session.progress(for: step),
                progress.state == .pending,
                progress.dueAt > Date()
            else { continue }

            let content = UNMutableNotificationContent()
            content.title = step.importance == .hardDeadline ? "🚨 \(step.title)" : "早上主线 · \(step.title)"
            content.body = step.prompt
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.userInfo = ["stepID": step.id.uuidString]

            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, progress.dueAt.timeIntervalSinceNow),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "morning-mainline-\(session.id.uuidString)-\(step.id.uuidString)",
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
    }
}

