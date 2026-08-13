import Foundation

enum DeviceRole: String, Codable, Sendable {
    case phone
    case pad
    case watch
}

enum StepImportance: String, Codable, Sendable {
    case normal
    case hardDeadline
}

enum StepRole: String, Codable, Sendable {
    case task
    case deadline
}

enum ScheduleMode: String, Codable, Sendable {
    /// 从现在开始顺排，适合“先写两小时语文，再写一小时英语”。
    case forward
    /// 从截止时间倒排，适合“8:35 出门”或“9:00 到宜家”。
    case backward
}

enum RoutineRecurrence: String, Codable, CaseIterable, Sendable {
    case once
    case daily

    var title: String {
        switch self {
        case .once: "单次"
        case .daily: "每天"
        }
    }
}

struct RoutineStep: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var title: String
    var prompt: String
    var duration: TimeInterval
    var importance: StepImportance
    var role: StepRole

    init(
        id: UUID = UUID(),
        title: String,
        prompt: String? = nil,
        duration: TimeInterval,
        importance: StepImportance = .normal,
        role: StepRole = .task
    ) {
        self.id = id
        self.title = title
        self.prompt = prompt ?? "现在只做：\(title)"
        self.duration = duration
        self.importance = importance
        self.role = role
    }
}

struct RoutineTemplate: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var name: String
    var symbol: String
    var mode: ScheduleMode
    var deadlineHour: Int?
    var deadlineMinute: Int?
    var buffer: TimeInterval
    /// 可选是为了兼容旧版本已经保存在本机和 iCloud 的任务线。
    var recurrence: RoutineRecurrence?
    var steps: [RoutineStep]

    init(
        id: UUID = UUID(),
        name: String,
        symbol: String,
        mode: ScheduleMode,
        deadlineHour: Int? = nil,
        deadlineMinute: Int? = nil,
        buffer: TimeInterval = 0,
        recurrence: RoutineRecurrence = .once,
        steps: [RoutineStep]
    ) {
        self.id = id
        self.name = name
        self.symbol = symbol
        self.mode = mode
        self.deadlineHour = deadlineHour
        self.deadlineMinute = deadlineMinute
        self.buffer = buffer
        self.recurrence = recurrence
        self.steps = steps
    }

    var effectiveRecurrence: RoutineRecurrence {
        recurrence ?? .once
    }

    var deadlineStep: RoutineStep? {
        steps.first(where: { $0.role == .deadline })
    }

    var taskSteps: [RoutineStep] {
        steps.filter { $0.role == .task }
    }

    var totalTaskDuration: TimeInterval {
        taskSteps.reduce(0) { $0 + $1.duration }
    }

    func deadline(on date: Date, calendar: Calendar = .current) -> Date? {
        guard let deadlineHour, let deadlineMinute else { return nil }
        let today = calendar.date(bySettingHour: deadlineHour, minute: deadlineMinute, second: 0, of: date) ?? date
        // 早晨任务在中午以后启动时，默认给第二天，避免出现“已经过去 5 小时”的假倒计时。
        return today < date.addingTimeInterval(-60) ? calendar.date(byAdding: .day, value: 1, to: today) : today
    }

    static let morning = RoutineTemplate(
        id: UUID(uuidString: "5E43ED14-458A-49CF-8673-A96DCA196001")!,
        name: "上班早晨",
        symbol: "sun.max.fill",
        mode: .backward,
        deadlineHour: 8,
        deadlineMinute: 35,
        buffer: 10 * 60,
        recurrence: .daily,
        steps: [
            RoutineStep(title: "刷牙", prompt: "先刷牙，不开新任务", duration: 3 * 60),
            RoutineStep(title: "洗脸", duration: 5 * 60),
            RoutineStep(title: "弄头发", duration: 10 * 60),
            RoutineStep(title: "装午饭", prompt: "午饭装好就下楼，不再收拾车", duration: 2 * 60),
            RoutineStep(title: "下楼", prompt: "现在下楼，安安的临时需求优先交接", duration: 5 * 60, importance: .hardDeadline),
            RoutineStep(title: "出门", prompt: "不预测路况，现在出门", duration: 0, importance: .hardDeadline, role: .deadline)
        ]
    )

    static let homework = RoutineTemplate(
        id: UUID(uuidString: "5E43ED14-458A-49CF-8673-A96DCA196002")!,
        name: "写作业",
        symbol: "book.closed.fill",
        mode: .forward,
        steps: [
            RoutineStep(title: "语文", prompt: "先做语文，只要开始", duration: 2 * 60 * 60),
            RoutineStep(title: "英语", duration: 60 * 60),
            RoutineStep(title: "数学", duration: 30 * 60)
        ]
    )

    static let ikea = RoutineTemplate(
        id: UUID(uuidString: "5E43ED14-458A-49CF-8673-A96DCA196003")!,
        name: "去宜家",
        symbol: "car.fill",
        mode: .backward,
        deadlineHour: 9,
        deadlineMinute: 0,
        buffer: 15 * 60,
        steps: [
            RoutineStep(title: "洗脸刷牙", duration: 15 * 60),
            RoutineStep(title: "给安安喂早饭", duration: 20 * 60),
            RoutineStep(title: "安安穿衣服", duration: 10 * 60),
            RoutineStep(title: "路上", prompt: "带好必需品，直接出发", duration: 40 * 60),
            RoutineStep(title: "到宜家", prompt: "到达就好，不追求一路完美", duration: 0, importance: .hardDeadline, role: .deadline)
        ]
    )

    static let defaults = [morning, homework, ikea]
}

enum StepState: String, Codable, Sendable {
    case pending
    case completed
    case skipped
}

struct StepProgress: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var step: RoutineStep
    var dueAt: Date
    var state: StepState
    var snoozeCount: Int
    var completedAt: Date?
    var isTemporary: Bool

    init(
        id: UUID = UUID(),
        step: RoutineStep,
        dueAt: Date,
        state: StepState = .pending,
        snoozeCount: Int = 0,
        completedAt: Date? = nil,
        isTemporary: Bool = false
    ) {
        self.id = id
        self.step = step
        self.dueAt = dueAt
        self.state = state
        self.snoozeCount = snoozeCount
        self.completedAt = completedAt
        self.isTemporary = isTemporary
    }
}

enum SessionState: String, Codable, Sendable {
    case running
    case completed
    case cancelled
}

struct RoutineSession: Identifiable, Codable, Sendable {
    let id: UUID
    let templateID: UUID
    let templateName: String
    let templateSymbol: String
    let startedAt: Date
    let plannedStartAt: Date
    var targetDeadline: Date?
    var state: SessionState
    var primaryDevice: DeviceRole
    var progress: [StepProgress]
    var remainingBuffer: TimeInterval
    var updatedAt: Date
    var revision: Int

    var deadlineProgress: StepProgress? {
        progress.first(where: { $0.step.role == .deadline })
    }

    var expectedDeadline: Date? {
        deadlineProgress?.dueAt ?? targetDeadline
    }

    var isLate: Bool {
        guard let targetDeadline, let expectedDeadline else { return false }
        return expectedDeadline > targetDeadline
    }
}

struct RoutineSnapshot: Codable, Sendable {
    var templates: [RoutineTemplate]
    var activeSession: RoutineSession?
    var updatedAt: Date
    var originID: UUID

    static let initial = RoutineSnapshot(
        templates: RoutineTemplate.defaults,
        activeSession: nil,
        updatedAt: .distantPast,
        originID: UUID()
    )
}

enum QuickRoutineParser {
    /// 一句话只解析“任务名称 + 时长”。截止时间和重复方式由明确控件提供。
    static func makeSteps(from input: String) -> [RoutineStep] {
        let compact = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return [] }

        var source = replacing(
            pattern: "(?:截止时间|截止|完成时间|到期时间)?\\s*\\d{1,2}\\s*(?:点|:|：)\\s*\\d{0,2}\\s*分?",
            in: compact,
            with: "|"
        )
        source = source
            .replacingOccurrences(of: "；", with: "|")
            .replacingOccurrences(of: "，", with: "|")
            .replacingOccurrences(of: "。", with: "|")
            .replacingOccurrences(of: "、", with: "|")

        let pattern = "([^|\\d]+?)\\s*(\\d+(?:\\.5)?)\\s*(小时|h|H|分钟|分)"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let results = regex.matches(in: source, range: NSRange(source.startIndex..., in: source))

        return results.compactMap { result -> RoutineStep? in
            guard result.numberOfRanges == 4,
                  let titleRange = Range(result.range(at: 1), in: source),
                  let numberRange = Range(result.range(at: 2), in: source),
                  let unitRange = Range(result.range(at: 3), in: source),
                  let number = Double(source[numberRange])
            else { return nil }

            let title = String(source[titleRange])
                .replacingOccurrences(of: "然后", with: "")
                .replacingOccurrences(of: "再", with: "")
                .replacingOccurrences(of: "先", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "|")))
            let unit = String(source[unitRange])
            let duration = unit == "小时" || unit.lowercased() == "h" ? number * 3600 : number * 60
            guard duration > 0, !title.isEmpty else { return nil }
            return RoutineStep(title: title, duration: duration)
        }
    }

    static func makeTemplate(
        from input: String,
        deadline: Date?,
        recurrence: RoutineRecurrence,
        calendar: Calendar = .current
    ) -> RoutineTemplate? {
        let steps = makeSteps(from: input)
        guard !steps.isEmpty else { return nil }

        let firstTitle = steps[0].title
        let name = steps.count == 1 ? firstTitle : "\(firstTitle)等 \(steps.count) 项"

        guard let deadline else {
            return RoutineTemplate(
                name: name,
                symbol: "list.bullet.clipboard.fill",
                mode: .forward,
                recurrence: recurrence,
                steps: steps
            )
        }

        let deadlineStep = RoutineStep(
            title: "完成",
            prompt: "按计划完成，不再临时开新任务",
            duration: 0,
            importance: .hardDeadline,
            role: .deadline
        )

        return RoutineTemplate(
            name: name,
            symbol: "list.bullet.clipboard.fill",
            mode: .backward,
            deadlineHour: calendar.component(.hour, from: deadline),
            deadlineMinute: calendar.component(.minute, from: deadline),
            recurrence: recurrence,
            steps: steps + [deadlineStep]
        )
    }

    private static func replacing(pattern: String, in text: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..., in: text),
            withTemplate: replacement
        )
    }

}
