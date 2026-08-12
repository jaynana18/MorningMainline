import Foundation

enum DeviceRole: String, Codable, Sendable {
    case phone
    case pad
    case watch
}

enum StepTiming: Codable, Hashable, Sendable {
    case relative(seconds: TimeInterval)
    case absolute(hour: Int, minute: Int)
}

enum StepImportance: String, Codable, Sendable {
    case normal
    case hardDeadline
}

struct RoutineStep: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var title: String
    var prompt: String
    var timing: StepTiming
    var importance: StepImportance
    var snoozeSeconds: TimeInterval
    var maxSnoozeCount: Int

    init(
        id: UUID = UUID(),
        title: String,
        prompt: String,
        timing: StepTiming,
        importance: StepImportance = .normal,
        snoozeSeconds: TimeInterval = 120,
        maxSnoozeCount: Int = 2
    ) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.timing = timing
        self.importance = importance
        self.snoozeSeconds = snoozeSeconds
        self.maxSnoozeCount = maxSnoozeCount
    }
}

struct RoutineTemplate: Identifiable, Codable, Sendable {
    let id: UUID
    var name: String
    var steps: [RoutineStep]

    static let morning = RoutineTemplate(
        id: UUID(uuidString: "5E43ED14-458A-49CF-8673-A96DCA196001")!,
        name: "早上主线",
        steps: [
            RoutineStep(
                title: "起床",
                prompt: "起床了吗？",
                timing: .relative(seconds: 3 * 60)
            ),
            RoutineStep(
                title: "刷牙",
                prompt: "开始刷牙了吗？",
                timing: .relative(seconds: 5 * 60)
            ),
            RoutineStep(
                title: "确认安安安排",
                prompt: "奶奶到了吗？没到就准备抱安安下楼",
                timing: .absolute(hour: 8, minute: 10)
            ),
            RoutineStep(
                title: "下楼",
                prompt: "停止支线，现在必须下楼",
                timing: .absolute(hour: 8, minute: 20),
                importance: .hardDeadline,
                snoozeSeconds: 60,
                maxSnoozeCount: 3
            ),
            RoutineStep(
                title: "出门",
                prompt: "不预测路况，现在出门",
                timing: .absolute(hour: 8, minute: 35),
                importance: .hardDeadline,
                snoozeSeconds: 60,
                maxSnoozeCount: 3
            )
        ]
    )
}

enum StepState: String, Codable, Sendable {
    case pending
    case completed
    case skipped
}

struct StepProgress: Identifiable, Codable, Sendable {
    var id: UUID { stepID }
    let stepID: UUID
    var dueAt: Date
    var state: StepState
    var snoozeCount: Int
    var completedAt: Date?
}

enum SessionState: String, Codable, Sendable {
    case running
    case completed
    case cancelled
}

struct RoutineSession: Identifiable, Codable, Sendable {
    let id: UUID
    let templateID: UUID
    let startedAt: Date
    var state: SessionState
    var primaryDevice: DeviceRole
    var progress: [StepProgress]
    var updatedAt: Date
    var revision: Int

    func progress(for step: RoutineStep) -> StepProgress? {
        progress.first { $0.stepID == step.id }
    }
}

struct RoutineSnapshot: Codable, Sendable {
    var template: RoutineTemplate
    var activeSession: RoutineSession?
    var updatedAt: Date
    var originID: UUID

    static let initial = RoutineSnapshot(
        template: .morning,
        activeSession: nil,
        updatedAt: .distantPast,
        originID: UUID()
    )
}

extension RoutineStep {
    func dueDate(startedAt: Date, calendar: Calendar = .current) -> Date {
        switch timing {
        case .relative(let seconds):
            return startedAt.addingTimeInterval(seconds)
        case .absolute(let hour, let minute):
            return calendar.date(
                bySettingHour: hour,
                minute: minute,
                second: 0,
                of: startedAt
            ) ?? startedAt
        }
    }
}

