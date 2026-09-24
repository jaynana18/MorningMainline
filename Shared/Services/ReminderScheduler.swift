import Foundation
import UserNotifications

actor ReminderScheduler {
    static let shared = ReminderScheduler()

    private let center = UNUserNotificationCenter.current()
    private let categoryID = "MORNING_MAINLINE_STEP"
    private var overdueSound: UNNotificationSound {
        #if os(watchOS)
        // watchOS 不支持自定义通知音，手表使用系统声音和触感；语音由 iPhone 播放。
        return .default
        #else
        return UNNotificationSound(named: UNNotificationSoundName("deadline-overdue.aiff"))
        #endif
    }

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
        let now = Date()
        let incomplete = session.progress.filter(\.state.isIncomplete)

        // 普通任务只在各自的计划完成时间提醒一次。
        for progress in incomplete
        where progress.step.role == .task && progress.dueAt > now {
            let content = UNMutableNotificationContent()
            content.title = "不跑偏 · \(progress.step.title)"
            content.body = progress.step.prompt
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.userInfo = ["progressID": progress.id.uuidString]

            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, progress.dueAt.timeIntervalSinceNow),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "morning-mainline-\(session.id.uuidString)-\(progress.id.uuidString)-due",
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }

        // 只有整条计划的最终 Deadline 使用密集提醒。
        guard let targetDeadline = session.targetDeadline,
              incomplete.contains(where: { $0.step.role == .task || $0.step.role == .deadline })
        else { return }

        let milestones: [(minuteOffset: Int, label: String)] = [
            (-10, "还剩 10 分钟"),
            (-5, "还剩 5 分钟"),
            (-3, "还剩 3 分钟"),
            (-1, "还剩 1 分钟"),
            (0, "计划时间到了"),
            (2, "已延误 2 分钟"),
            (4, "已延误 4 分钟"),
            (6, "已延误 6 分钟")
        ]

        for milestone in milestones {
            let fireAt = targetDeadline.addingTimeInterval(TimeInterval(milestone.minuteOffset * 60))
            guard fireAt > now else { continue }

            let currentTitle = session.progress.first(where: {
                $0.id == session.activeProgressID && $0.state == .active
            })?.step.title
            let content = UNMutableNotificationContent()
            if milestone.minuteOffset < 0 {
                content.title = "不跑偏 · 距离 Deadline \(milestone.label)"
                content.body = currentTitle.map { "当前任务：\($0)" } ?? "请确认最重要的任务正在推进。"
                content.sound = .default
            } else if milestone.minuteOffset == 0 {
                content.title = "⏰ Deadline 到了"
                content.body = currentTitle.map { "当前任务“\($0)”还没完成，请先回到主线。" }
                    ?? "计划还没有完成，请先回到主线。"
                content.sound = overdueSound
            } else {
                content.title = "🚨 Deadline \(milestone.label)"
                content.body = currentTitle.map { "当前任务“\($0)”仍未完成，请先把它收尾。" }
                    ?? "计划仍未完成，请立即回到主线。"
                content.sound = overdueSound
            }
            content.categoryIdentifier = categoryID
            content.threadIdentifier = "morning-mainline-deadline"
            content.interruptionLevel = .timeSensitive
            content.userInfo = [
                "sessionID": session.id.uuidString,
                "minuteOffset": milestone.minuteOffset
            ]

            let trigger = UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, fireAt.timeIntervalSinceNow),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "morning-mainline-\(session.id.uuidString)-deadline-milestone-\(milestone.minuteOffset)",
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
    }
}
