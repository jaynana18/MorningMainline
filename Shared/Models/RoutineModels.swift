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

enum TemporaryTaskPlacement: String, CaseIterable, Identifiable, Sendable {
    case now
    case afterCurrent

    var id: Self { self }

    var title: String {
        switch self {
        case .now: "立即做"
        case .afterCurrent: "当前任务后"
        }
    }

    var detail: String {
        switch self {
        case .now: "先暂停当前任务，做完马上回到主线。"
        case .afterCurrent: "先完成正在做的事，再执行这项临时任务。"
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

/// 路线附属信息，仅用于预览和跳转，不参与任务时间线计算。Key 不持久化。
struct CommuteInfo: Codable, Hashable, Sendable {
    var address: String
    var location: String
    var origin: String
    var mode: String
    var seconds: TimeInterval
    var polyline: String
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
    var commute: CommuteInfo? = nil

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
        guard today < date else { return today }
        // 每天任务会自然进入下一次执行；单次任务保留过期状态，避免悄悄改成明天。
        return effectiveRecurrence == .daily
            ? calendar.date(byAdding: .day, value: 1, to: today)
            : today
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
    case active
    case suspended
    case completed
    case skipped

    var isIncomplete: Bool {
        switch self {
        case .pending, .active, .suspended:
            true
        case .completed, .skipped:
            false
        }
    }
}

struct StepProgress: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    var step: RoutineStep
    var dueAt: Date
    var state: StepState
    var snoozeCount: Int
    var completedAt: Date?
    var isTemporary: Bool
    /// 第一次生成计划时的完成时间，之后不随延误改写。
    var plannedDueAt: Date?
    /// 挂起后尚未完成的时长；为空时使用任务原始时长。
    var remainingDuration: TimeInterval?
    var startedAt: Date?

    init(
        id: UUID = UUID(),
        step: RoutineStep,
        dueAt: Date,
        state: StepState = .pending,
        snoozeCount: Int = 0,
        completedAt: Date? = nil,
        isTemporary: Bool = false,
        plannedDueAt: Date? = nil,
        remainingDuration: TimeInterval? = nil,
        startedAt: Date? = nil
    ) {
        self.id = id
        self.step = step
        self.dueAt = dueAt
        self.state = state
        self.snoozeCount = snoozeCount
        self.completedAt = completedAt
        self.isTemporary = isTemporary
        self.plannedDueAt = plannedDueAt
        self.remainingDuration = remainingDuration
        self.startedAt = startedAt
    }


    var originalDueAt: Date { plannedDueAt ?? dueAt }

    var remainingWork: TimeInterval {
        max(0, remainingDuration ?? step.duration)
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
    /// 只有点击某一项的“开始”后才会有当前任务。
    var activeProgressID: UUID? = nil
    /// 临时插入或切换任务时，用栈记录需要返回的挂起任务。
    var suspendedProgressIDs: [UUID]? = nil

    var deadlineProgress: StepProgress? {
        progress.first(where: { $0.step.role == .deadline })
    }

    var expectedDeadline: Date? {
        deadlineProgress?.dueAt ?? targetDeadline
    }

    var isLate: Bool {
        isLate(at: Date())
    }

    func estimatedDueDates(at date: Date) -> [UUID: Date] {
        var result: [UUID: Date] = [:]
        var cursor = date

        for item in orderedIncompleteTasks {
            let estimated: Date
            if item.state == .active {
                estimated = max(item.dueAt, date)
            } else {
                estimated = cursor.addingTimeInterval(item.remainingWork)
            }
            result[item.id] = estimated
            cursor = estimated
        }

        if let deadline = progress.first(where: { $0.state.isIncomplete && $0.step.role == .deadline }) {
            // Deadline 是对比基准；预计完成时间必须随实际推进而变化，不能被原计划时间卡住。
            result[deadline.id] = max(cursor, date)
        }
        return result
    }

    func estimatedCompletion(at date: Date) -> Date? {
        let estimates = estimatedDueDates(at: date)
        if let deadline = progress.first(where: { $0.state.isIncomplete && $0.step.role == .deadline }) {
            return estimates[deadline.id]
        }
        return progress
            .filter { $0.state.isIncomplete && $0.step.role == .task }
            .compactMap { estimates[$0.id] }
            .last
    }

    func isLate(at date: Date) -> Bool {
        guard let targetDeadline, let estimated = estimatedCompletion(at: date) else { return false }
        return estimated > targetDeadline
    }

    private var orderedIncompleteTasks: [StepProgress] {
        let tasks = progress.filter { $0.state.isIncomplete && $0.step.role == .task }
        guard let activeProgressID,
              let active = tasks.first(where: { $0.id == activeProgressID })
        else { return tasks }
        return [active] + tasks.filter { $0.id != activeProgressID }
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
    /// 规则解析的全部产物。除了任务与截止时间，还带上“没读懂的部分”，
    /// 供上层判断是否需要交给大模型补位。
    struct ParseOutcome: Sendable {
        var steps: [RoutineStep]
        var deadline: Date?
        /// 未能归入任何任务的残余文本。为空说明这段输入被规则完整吃下了。
        var leftover: String

        var hasSteps: Bool { !steps.isEmpty }
        var isComplete: Bool { leftover.isEmpty }
    }

    /// 「任务名 + 时长」的匹配式，解析与残余计算共用同一份，避免两套规则跑偏。
    private static let stepPattern = "([^|\\d]+?)\\s*(\\d+(?:\\.5)?)\\s*(小时|h|H|分钟|分)"

    /// 识别“结束 18:10”“18点30结束”“出门 10 点”“出门10点半”等最终节点时间，不把普通任务时长误当作 Deadline。
    ///
    /// 两种语序都必须认：锚点词在前（「结束 18:10」）与时间在前（「18点30结束」）。
    /// 只认前一种会漏读中文里非常常见的后置说法，而且这种漏读是静默的——
    /// 时间表达会被 `leftoverText` 的锚点清理逻辑一并吞掉，规则据此误判「读全了」，
    /// 既不下发大模型（`isComplete == true` 短路），也拿不到截止时间。
    static func inferredDeadline(
        from input: String,
        relativeTo date: Date = Date(),
        calendar: Calendar = .current
    ) -> Date? {
        // 「半」在正则里难表达，先归一成显式分钟：`10点半` → `10点30`、`8点半出门` → `8点30出门`。
        // 只替换「点半」这个固定组合，不影响任务名里其他位置的「半」（如「买半个西瓜」）。
        // 归一后长度会增加，因此后续匹配与取值必须统一使用 `normalized`，一旦混用 `input` 会 Range 错位。
        let normalized = input.replacingOccurrences(of: "点半", with: "点30")

        let anchor = "结束|出门|截止|完成|到期"
        // 组 1/2 = 锚点在前写法（「结束 18:10」「出门 10 点」）；组 3/4 = 时间在前写法（「18点30结束」「8点出门」）。
        // 后者的小时后必须跟「点/: /：」才能与任务时长（「2分钟」）区分，分钟允许缺省（「8点出门」）。
        let pattern = "(?:\(anchor))(?:时间)?\\s*(\\d{1,2})(?:\\s*(?:点|:|：)\\s*(\\d{1,2}))?\\s*分?"
            + "|(\\d{1,2})\\s*(?:点|:|：)\\s*(\\d{0,2})\\s*分?\\s*(?:\(anchor))"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: normalized, range: NSRange(normalized.startIndex..., in: normalized))
        else { return nil }

        let hour: Int
        let minute: Int

        if let hourRange = Range(match.range(at: 1), in: normalized), let parsedHour = Int(normalized[hourRange]) {
            hour = parsedHour
            minute = Range(match.range(at: 2), in: normalized).flatMap { Int(normalized[$0]) } ?? 0
        } else if let hourRange = Range(match.range(at: 3), in: normalized), let parsedHour = Int(normalized[hourRange]) {
            hour = parsedHour
            minute = Range(match.range(at: 4), in: normalized).flatMap { Int(normalized[$0]) } ?? 0
        } else {
            return nil
        }

        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: date)
    }

    /// 一次拿到任务、截止时间与残余文本。上层据此决定「本机直接出」还是「交给大模型」。
    static func analyze(
        from input: String,
        relativeTo date: Date = Date(),
        calendar: Calendar = .current
    ) -> ParseOutcome {
        ParseOutcome(
            steps: makeSteps(from: input),
            deadline: inferredDeadline(from: input, relativeTo: date, calendar: calendar),
            leftover: leftoverText(from: input)
        )
    }

    /// 一句话只解析“任务名称 + 时长”。截止时间和重复方式由明确控件提供。
    static func makeSteps(from input: String) -> [RoutineStep] {
        let compact = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return [] }

        let source = normalizedSource(from: compact)
        guard let regex = try? NSRegularExpression(pattern: stepPattern) else { return [] }
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

    /// 把“任务名 + 时长”与截止时间表达统一规整成用 `|` 分段的中间文本。
    private static func normalizedSource(from compact: String) -> String {
        let normalizedDurations = replacingChineseDurationNumerals(in: compact)
        var source = replacing(
            pattern: "(?:截止时间|截止|完成时间|到期时间)?\\s*\\d{1,2}\\s*(?:点|:|：)\\s*\\d{0,2}\\s*分?",
            in: normalizedDurations,
            with: "|"
        )
        source = source
            .replacingOccurrences(of: "；", with: "|")
            .replacingOccurrences(of: "，", with: "|")
            .replacingOccurrences(of: ",", with: "|")
            .replacingOccurrences(of: "。", with: "|")
            .replacingOccurrences(of: "、", with: "|")
        return source
    }

    /// 去掉所有已被“任务名 + 时长”吃掉的片段，剩下的就是规则没读懂的内容。
    private static func leftoverText(from input: String) -> String {
        let compact = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return "" }

        var residue = replacing(pattern: stepPattern, in: normalizedSource(from: compact), with: "")
        residue = residue.replacingOccurrences(of: "|", with: "")
        // 「结束 8:35」「8 点出门」这类时间锚点不是任务，被切碎后不该算作没读懂。
        for anchor in ["结束", "出门", "截止", "完成", "到期"] {
            residue = residue.replacingOccurrences(of: anchor, with: "")
        }
        return residue
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "，,。；;、|")))
    }

    /// 由文本直接生成任务线：先解析，再交给下面的重载组装。
    static func makeTemplate(
        from input: String,
        deadline: Date?,
        recurrence: RoutineRecurrence,
        calendar: Calendar = .current
    ) -> RoutineTemplate? {
        makeTemplate(
            steps: makeSteps(from: input),
            deadline: deadline ?? inferredDeadline(from: input, calendar: calendar),
            recurrence: recurrence,
            calendar: calendar
        )
    }

    /// 由已解析好的步骤组装任务线。模板形状（截止节点、倒推模式、命名）只在这里定义一处，
    /// 无论步骤来自本机规则还是大模型，都不会跑出两套结构。
    static func makeTemplate(
        steps rawSteps: [RoutineStep],
        deadline: Date?,
        recurrence: RoutineRecurrence,
        calendar: Calendar = .current
    ) -> RoutineTemplate? {
        let steps = rawSteps.filter { $0.role == .task }
        guard let firstStep = steps.first else { return nil }

        let name = steps.count == 1 ? firstStep.title : "\(firstStep.title)等 \(steps.count) 项"

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

    /// 只转换紧挨着时长单位的中文数字，避免误改任务名称里的中文数字。
    private static func replacingChineseDurationNumerals(in text: String) -> String {
        let pattern = "([零〇一二三四五六七八九十两]+)\\s*(?:个)?\\s*(小时|分钟|分)"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }

        var result = text
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        for match in matches.reversed() {
            guard let fullRange = Range(match.range, in: result),
                  let numberRange = Range(match.range(at: 1), in: text),
                  let unitRange = Range(match.range(at: 2), in: text),
                  let value = chineseNumber(String(text[numberRange]))
            else { continue }
            result.replaceSubrange(fullRange, with: "\(value)\(text[unitRange])")
        }
        return result
    }

    private static func chineseNumber(_ text: String) -> Int? {
        let digits: [Character: Int] = [
            "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
            "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
        ]
        var total = 0
        var current = 0

        for character in text {
            if let digit = digits[character] {
                current = digit
            } else if character == "十" {
                total += max(1, current) * 10
                current = 0
            } else {
                return nil
            }
        }
        return total + current
    }

}
