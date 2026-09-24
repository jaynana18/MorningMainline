import Foundation

/// 解析来源。用于界面上区分「本机秒出」和「走了大模型」，也方便日后统计命中率与费用。
enum RoutineParseSource: String, Sendable {
    case rule
    case enhanced

    var title: String {
        switch self {
        case .rule: "本机识别"
        case .enhanced: "智能识别"
        }
    }
}

/// 一句话创建的解析结果。
struct RoutineParseResult: Sendable {
    var steps: [RoutineStep]
    var deadline: Date?
    var source: RoutineParseSource
    /// 规则解析未能归入任何任务的残余文本。非空说明这段输入只被读懂了一部分。
    var leftover: String

    var hasSteps: Bool { !steps.isEmpty }
    /// 规则完整吃下了输入，不需要再走大模型。
    var isComplete: Bool { leftover.isEmpty }
}

/// 一句话创建的解析入口。本机规则、端侧模型、云端模型都实现这一层，
/// 界面只依赖协议，换渠道或加渠道都不用动 UI。
protocol RoutineParsingService {
    var source: RoutineParseSource { get }
    func parse(_ input: String, now: Date) async throws -> RoutineParseResult?
}

/// 本机正则解析。毫秒级、零成本、离线可用。
/// 它是所有输入的第一道，也是任何大模型不可用时的最后一道兜底。
struct RuleRoutineParsingService: RoutineParsingService {
    let source: RoutineParseSource = .rule

    func parse(_ input: String, now: Date) async throws -> RoutineParseResult? {
        let outcome = QuickRoutineParser.analyze(from: input, relativeTo: now)
        guard outcome.hasSteps else { return nil }
        return RoutineParseResult(
            steps: outcome.steps,
            deadline: outcome.deadline,
            source: .rule,
            leftover: outcome.leftover
        )
    }
}

/// 规则优先、大模型补位的解析管线。
///
/// - 规则完整吃下输入：直接返回。不发任何请求，一分钱不花。
/// - 规则只读懂一部分（`leftover` 非空）：交给 `enhanced`，任务数以「严格多于」
///   为准择优——模型多读出了任务才整体采用它，数量持平说明模型没多读出东西，
///   就保留规则那份更快、更确定的步骤，避免模型把规则已经识别对的步骤改坏。
/// - 数量持平且规则没读出截止时间时，额外吸收模型解析出的 `deadline`（见 `parse`）。
///   两个来源互补：规则正则覆盖有限，模型能读懂更自由的口语表达（如「午饭前弄完」），
///   补齐规则读不出的截止时间，同时不拿模型去覆盖规则已经识别对的步骤。
/// - `enhanced` 未接入、超时或报错：始终回退到规则结果，绝不让创建流程卡住。
struct RoutineParsingPipeline {
    var rule: any RoutineParsingService = RuleRoutineParsingService()
    /// 后续接入的大模型实现（云端或端侧）。留空即纯规则模式。
    var enhanced: (any RoutineParsingService)?

    /// 是否已接入慢速通道。界面据此决定要不要显示加载态，
    /// 避免纯规则模式下出现无意义的转圈闪烁。
    var hasEnhancedPath: Bool { enhanced != nil }

    func parse(_ input: String, now: Date = Date()) async -> RoutineParseResult? {
        let fast = try? await rule.parse(input, now: now)

        if let fast, fast.isComplete { return fast }

        let better = await enhancedResult(input: input, now: now)

        guard let fast else { return better }
        guard let better else { return fast }

        if better.steps.count > fast.steps.count { return better }

        // 任务数没增加，说明模型没多读出任务，保留规则那份更确定的步骤。
        // 但截止时间要互补：规则正则覆盖有限，模型能读懂更自由的口语表达，
        // 在规则没给出截止时间时用模型的补齐，同时不拿模型覆盖规则已识别对的步骤。
        guard fast.deadline == nil, let betterDeadline = better.deadline else { return fast }

        return RoutineParseResult(
            steps: fast.steps,
            deadline: betterDeadline,
            source: .enhanced,
            leftover: fast.leftover
        )
    }

    private func enhancedResult(input: String, now: Date) async -> RoutineParseResult? {
        guard let enhanced else { return nil }
        return try? await enhanced.parse(input, now: now)
    }
}

/// 全局解析入口。接入大模型时只改这一处（给 `current.enhanced` 赋值），
/// iPhone / iPad / Watch 的创建页会一起生效，不必逐个页面改。
enum RoutineParsing {
    static var current = RoutineParsingPipeline()
}
