import Foundation
import UserNotifications

/// 本地通知排程。**两端（iPhone / Watch）各自独立排一份**，原因见 `replaceNotifications`。
///
/// ⚠️ 文案是**单一来源**：`web/src/core/reminders.ts` 逐字镜像本文件。
/// 改这里的任何一句 title / body，必须同步改那边，否则跨端文案漂移
/// （含全角引号 `“”`、`·`、`：` 这些字符级锚点）。
actor ReminderScheduler {
    static let shared = ReminderScheduler()

    private let center = UNUserNotificationCenter.current()
    private let categoryID = "MORNING_MAINLINE_STEP"
    /// 通勤段出发提醒的独立分类，便于将来挂「晚 5 分钟出发」这类动作。
    private let commuteCategoryID = "MORNING_MAINLINE_COMMUTE"

    /// 所有通知 identifier 的公共前缀。清理旧通知时按它一次性扫。
    private static let identifierRoot = "morning-mainline-"

    /// 普通任务的提前预警量。「到点才提醒」对正在专注的人太晚 ——
    /// 留两分钟收尾，才来得及把手上这件事告一段落再切走。
    static let taskLead: TimeInterval = 2 * 60
    /// 通勤出发提醒的提前量上限。再早提醒反而会被忽略。
    static let commuteLead: TimeInterval = 2 * 60
    /// 超时提醒的**默认**重提间隔（秒）。真值已移到 `OverduePolicy`（用户可配，存 App Group）——
    /// 这个常量只留作「默认策略」的说明性引用，**排程逻辑不再直接用它**，
    /// 免得两处各持一个真值、改了一处没改另一处。
    static let overdueRepeat: TimeInterval = 2 * 60
    /// 超时提醒预排的轮数上限。App 退到后台后 JS 定时器会被挂起，
    /// 只有系统排期的通知才响得起来 —— 所以必须一次排好一串。
    /// 排太多会在用户早已处理完后继续骚扰，故设上限；回到前台会重排。
    static let overdueRepeatCount = 30

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

    /// 重排该会话的全部通知。
    ///
    /// **两端都排**：iOS 与 watchOS 的通知中心彼此独立，各自排一份才能在
    /// 「手机不在身边」或「手表没戴」时仍然到点提醒。为避免同一件事在同一台设备上
    /// 并列两条，两端使用不同的 identifier 前缀但**相同的 threadIdentifier**，
    /// 让系统折叠成一组。
    ///
    /// ⚠️ **只给「当前那一项」排提醒，不是给所有未完成项排**（2026-10-14 修 bug）。
    /// 原来遍历全部未完成 task，于是「上一项还没结束、下一项已到点」时会弹出下一项 ——
    /// 用户被从手头这件事拽走，而真正该做的恰恰是先把手头这项收尾。提醒的语义是
    /// 「现在做这个」，完整排期由 App 内的时间线表达。与 `web/src/core/reminders.ts`
    /// 的 `focusedTask` 严格同语义，改动必须同步。
    ///
    /// - Parameter role: 当前排程设备。只用于区分 identifier 前缀。
    func replaceNotifications(session: RoutineSession?, role: DeviceRole) async {
        // 清掉本机所有旧通知。**按公共根前缀扫**，而不是按本设备前缀 ——
        // 前缀是这次新增的，旧版本装的通知只有 `morning-mainline-`，
        // 只扫新前缀会把它们留成幽灵提醒。本机通知中心里只有本机排的，清理范围安全。
        let existing = await center.pendingNotificationRequests()
        let stale = existing.map(\.identifier).filter { $0.hasPrefix(Self.identifierRoot) }
        center.removePendingNotificationRequests(withIdentifiers: stale)

        guard let session, session.state == .running else { return }
        let now = Date()
        let prefix = Self.identifierPrefix(for: role)
        let incomplete = session.progress.filter(\.state.isIncomplete)

        if let focused = Self.focusedTask(in: session) {
            if isCommute(focused) {
                await scheduleCommuteDepart(focused, session: session, prefix: prefix, now: now)
            } else {
                await scheduleTask(focused, session: session, prefix: prefix, now: now)
            }
            // 超时循环提醒：一次排好一串（后台 JS 停摆后只有系统通知响得起来）。
            await scheduleOverdueRepeats(focused, session: session, prefix: prefix, now: now)
        }

        await scheduleDeadlineMilestones(session: session, incomplete: incomplete, prefix: prefix, now: now)
    }

    /// **此刻唯一该被提醒的那一项**：优先「正在进行」的，其次「第一个未完成的任务」。
    ///
    /// 同 `web/src/core/reminders.ts:focusedTask`。回落「第一个未完成 task」是必要的 ——
    /// 否则「用户没点开始就忘了」这种情况会彻底收不到提醒。
    static func focusedTask(in session: RoutineSession) -> StepProgress? {
        if let active = session.progress.first(where: {
            $0.id == session.activeProgressID && $0.state == .active
        }) {
            return active
        }
        return session.progress.first {
            $0.step.role == .task && $0.state.isIncomplete
        }
    }

    // MARK: - 普通任务：提前预警 + 到点

    private func scheduleTask(
        _ progress: StepProgress,
        session: RoutineSession,
        prefix: String,
        now: Date
    ) async {
        let thread = "morning-mainline-task-\(progress.id.uuidString)"
        let advanceAt = progress.dueAt.addingTimeInterval(-Self.taskLead)

        if advanceAt > now {
            let content = UNMutableNotificationContent()
            content.title = "不跑偏 · 还有 2 分钟"
            content.body = "接下来：\(progress.step.title)"
            content.sound = .default
            content.categoryIdentifier = categoryID
            content.threadIdentifier = thread
            content.userInfo = ["progressID": progress.id.uuidString]

            await add(
                content: content,
                identifier: "\(prefix)-\(session.id.uuidString)-\(progress.id.uuidString)-advance",
                fireAt: advanceAt,
                now: now
            )
        }

        guard progress.dueAt > now else { return }
        let content = UNMutableNotificationContent()
        content.title = "不跑偏 · \(progress.step.title)"
        content.body = progress.step.prompt
        content.sound = .default
        content.categoryIdentifier = categoryID
        content.threadIdentifier = thread
        content.userInfo = ["progressID": progress.id.uuidString]

        await add(
            content: content,
            identifier: "\(prefix)-\(session.id.uuidString)-\(progress.id.uuidString)-due",
            fireAt: progress.dueAt,
            now: now
        )
    }

    // MARK: - 通勤段：该出发了

    /// 通勤的「该出发了」。
    ///
    /// 时间基准要分清：通勤项的 `dueAt` 是**到达时间**，`remainingWork` 是**路程时长**，
    /// 因此必须离开的时刻 = `dueAt - remainingWork`。提前量再往前挪一点，让人来得及拿钥匙出门；
    /// 短途按路程一半封顶，免得出发提醒比出发本身还早太多、变成噪音。
    private func scheduleCommuteDepart(
        _ progress: StepProgress,
        session: RoutineSession,
        prefix: String,
        now: Date
    ) async {
        let travel = progress.remainingWork
        let departAt = progress.dueAt.addingTimeInterval(-travel)
        let headsUp = min(Self.commuteLead, travel / 2)
        let fireAt = departAt.addingTimeInterval(-headsUp)
        guard fireAt > now else { return }

        let content = UNMutableNotificationContent()
        content.title = "不跑偏 · 该出发了"
        content.body = progress.step.title
        content.sound = .default
        content.categoryIdentifier = commuteCategoryID
        content.threadIdentifier = "morning-mainline-commute-\(progress.id.uuidString)"
        content.userInfo = ["progressID": progress.id.uuidString]

        await add(
            content: content,
            identifier: "\(prefix)-\(session.id.uuidString)-\(progress.id.uuidString)-depart",
            fireAt: fireAt,
            now: now
        )
    }

    // MARK: - 超时循环提醒

    /// 任务超时后每 2 分钟提醒一次。
    ///
    /// **为什么一次排一串**：App 退到后台后 JS 定时器被系统挂起，页内弹窗通道停摆；
    /// 而 `UNTimeIntervalNotificationTrigger(repeats: true)` 只在「固定间隔、不发散」时可用，
    /// 我们还需要「文案里的超时分钟数随轮次递增」，所以只能逐条排。
    ///
    /// 时间基准的选取很关键：超时从 `startedAt + step.duration` 起算
    /// （与界面 `TimelineCard.overdueSeconds`、TS 侧 `overdueSecondsOf` 同口径），
    /// **不是** `dueAt` —— `dueAt` 在某些动作里会被前推，会造成「界面已显示超时、
    /// 通知却说不超时」的矛盾。
    ///
    /// 第 0 轮不动：`dueAt` 那一刻已经由 `scheduleTask` 的到点通知响过了
    /// （`dueAt == startedAt + duration`），再从第 0 秒起算会在同一秒弹两条。
    ///
    /// ⚠️ 间隔由用户在个人中心配置（`OverduePolicy`，两阶段，存 App Group）。
    /// 与 JS 侧 `web/src/core/reminders.ts:overdueFireOffsets` **同口径**，改动要两边同步。
    /// 每次排程现读 App Group：改完设置会立刻重排（`RoutineStore.setOverduePolicy`
    /// → `rescheduleIfNeeded`），用户不需要重开会话或重启 App。
    private func scheduleOverdueRepeats(
        _ progress: StepProgress,
        session: RoutineSession,
        prefix: String,
        now: Date
    ) async {
        guard progress.state == .active, let startedAt = progress.startedAt else { return }

        let overdueFrom = startedAt.addingTimeInterval(progress.step.duration)
        let thread = "morning-mainline-overdue-\(progress.id.uuidString)"
        let offsets = SharedSettingsStore.current.overduePolicy
            .fireOffsets(limit: Self.overdueRepeatCount)

        for (round, offset) in offsets.enumerated() {
            let fireAt = overdueFrom.addingTimeInterval(offset)
            guard fireAt > now else { continue }

            // 🔴 超时分钟数一律 `floor`，**权威来源是界面 `TimelineCard.overdueText`**。
            // 原实现用 `.rounded(.up)`（= ceil）：在 2 分钟整倍数网格上恰好等价，
            // 但一旦间隔被用户改成奇数分钟，ceil 就会让播报比页面多 1 分钟。
            let minutes = max(1, Int(offset / 60))
            let content = UNMutableNotificationContent()
            content.title = "不跑偏 · 超时了"
            content.body = "“\(progress.step.title)”已经超了 \(minutes) 分钟，先把它收尾。"
            content.sound = overdueSound
            content.categoryIdentifier = categoryID
            content.threadIdentifier = thread
            content.interruptionLevel = .timeSensitive
            content.userInfo = ["progressID": progress.id.uuidString]

            await add(
                content: content,
                identifier: "\(prefix)-\(session.id.uuidString)-\(progress.id.uuidString)-overdue-\(round)",
                fireAt: fireAt,
                now: now
            )
        }
    }

    // MARK: - 最终 Deadline 密集提醒

    private func scheduleDeadlineMilestones(
        session: RoutineSession,
        incomplete: [StepProgress],
        prefix: String,
        now: Date
    ) async {
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
        let currentTitle = session.progress.first(where: {
            $0.id == session.activeProgressID && $0.state == .active
        })?.step.title

        for milestone in milestones {
            let fireAt = targetDeadline.addingTimeInterval(TimeInterval(milestone.minuteOffset * 60))
            guard fireAt > now else { continue }

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

            await add(
                content: content,
                identifier: "\(prefix)-\(session.id.uuidString)-deadline-milestone-\(milestone.minuteOffset)",
                fireAt: fireAt,
                now: now
            )
        }
    }

    // MARK: - 内部

    /// identifier 前缀。两端必须不同，否则同一台手表上会互相覆盖。
    private static func identifierPrefix(for role: DeviceRole) -> String {
        switch role {
        case .phone: "\(identifierRoot)phone"
        case .pad: "\(identifierRoot)pad"
        case .watch: "\(identifierRoot)watch"
        }
    }

    private func add(
        content: UNMutableNotificationContent,
        identifier: String,
        fireAt: Date,
        now: Date
    ) async {
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: max(1, fireAt.timeIntervalSince(now)),
            repeats: false
        )
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
    }

    /// 通勤项判定：显式带路线，或标题是「通勤到X」。
    /// 与 `web/src/views/session/destinationGroups.ts:isCommuteStep` 同口径。
    private func isCommute(_ progress: StepProgress) -> Bool {
        progress.step.commute != nil || progress.step.title.hasPrefix("通勤到")
    }
}
