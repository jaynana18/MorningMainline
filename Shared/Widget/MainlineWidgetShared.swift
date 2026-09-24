import Foundation
import WidgetKit

/// App 与 Widget 之间共享的最小数据，不让扩展依赖完整的 RoutineSnapshot。
struct MainlineWidgetSnapshot: Codable, Sendable {
    /// 生成快照的时间，用于小组件只追加快照之后产生的延误。
    var capturedAt: Date? = nil
    var currentTitle: String?
    var currentDueAt: Date?
    var originalDueAt: Date?
    var isHardDeadline: Bool
    var estimatedCompletion: Date?
    var isLate: Bool
    /// 预计比原计划晚多久；可选以兼容旧版本已写入的共享快照。
    var delayDuration: TimeInterval?
    var hasActiveSession: Bool
    var sessionName: String?

    static let empty = MainlineWidgetSnapshot(
        capturedAt: nil,
        currentTitle: nil,
        currentDueAt: nil,
        originalDueAt: nil,
        isHardDeadline: false,
        estimatedCompletion: nil,
        isLate: false,
        delayDuration: 0,
        hasActiveSession: false,
        sessionName: nil
    )
}

/// 供 Watch 表盘 complication 与 iPhone 主屏 Widget 共用的时间线数据源。
/// 数据来自 App Group 共享容器里的精简快照。
struct MainlineWidgetEntry: TimelineEntry {
    let date: Date
    /// 当前正在执行的任务（若有）。
    var currentTitle: String?
    var currentDueAt: Date?
    var isHardDeadline: Bool
    /// 预计完成时间（倒推任务线）。
    var estimatedCompletion: Date?
    /// 是否已晚于目标截止时间。
    var isLate: Bool
    var delayDuration: TimeInterval
    /// 是否有进行中的任务线。
    var hasActiveSession: Bool
    /// 任务线名称。
    var sessionName: String?

    static func placeholder() -> MainlineWidgetEntry {
        MainlineWidgetEntry(
            date: Date(),
            currentTitle: "刷牙",
            currentDueAt: Date().addingTimeInterval(120),
            isHardDeadline: false,
            estimatedCompletion: Date().addingTimeInterval(20 * 60),
            isLate: false,
            delayDuration: 0,
            hasActiveSession: true,
            sessionName: "上班早晨"
        )
    }
}

enum MainlineWidgetProvider {
    static func entry(for date: Date) -> MainlineWidgetEntry {
        guard let snapshot = AppGroupSharedStore.readWidgetSnapshot(),
              snapshot.hasActiveSession
        else {
            return MainlineWidgetEntry(
                date: date,
                currentTitle: nil,
                currentDueAt: nil,
                isHardDeadline: false,
                estimatedCompletion: nil,
                isLate: false,
                delayDuration: 0,
                hasActiveSession: false,
                sessionName: nil
            )
        }

        let liveOverrun = snapshot.currentDueAt.map {
            max(0, date.timeIntervalSince($0))
        } ?? 0
        let additionalOverrun = snapshot.currentDueAt.map {
            max(0, date.timeIntervalSince(max($0, snapshot.capturedAt ?? $0)))
        } ?? 0
        let liveDelay = max(snapshot.delayDuration ?? 0, liveOverrun)
        let liveEstimatedCompletion = snapshot.estimatedCompletion.map {
            $0.addingTimeInterval(additionalOverrun)
        }

        return MainlineWidgetEntry(
            date: date,
            currentTitle: snapshot.currentTitle,
            currentDueAt: snapshot.currentDueAt,
            isHardDeadline: snapshot.isHardDeadline,
            estimatedCompletion: liveEstimatedCompletion,
            isLate: snapshot.isLate || liveDelay > 0,
            delayDuration: liveDelay,
            hasActiveSession: true,
            sessionName: snapshot.sessionName
        )
    }
}
