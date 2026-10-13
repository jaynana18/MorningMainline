import Foundation

/// 云端解析实现：任何兼容 OpenAI Chat Completions 字段格式的网关都能用。
///
/// 当前接的是公司内网网关 `https://gpt.cosmoplat.com/v1`（模型 `cosmo-mind-coder`），
/// 也支持阿里云百炼的 qwen 系列。见 `Configuration.cosmoMind` / `Configuration.dashScope`。
///
/// 接入方式：在 App 启动时配置 `RoutineParsing.current.enhanced`。
/// 未配置时管线自动停留在纯规则模式，不影响任何现有功能。
///
/// 关于 API Key：不要写死在源码里。优先走 `Configuration.apiKeyFromEnvironment()`，
/// 由 Xcode scheme 的环境变量注入，避免随 git 泄漏。
struct RemoteRoutineParsingService: RoutineParsingService {
    /// 关闭思考链的字段写法。各家网关不统一，需要逐个试。
    ///
    /// 实测公司网关（`cosmo-mind-coder` → `deepseek-flash`）**忽略** `enable_thinking: false`：
    /// 发过去不报错，但 `reasoning_tokens` 依旧是输出量的九成以上。所以要留出别的写法。
    enum ThinkingDisableStyle: String, CaseIterable {
        /// 不发送任何关闭思考的字段，接受默认行为。
        case none
        /// `"enable_thinking": false`。部分通义系网关认这个。
        case enableThinking
        /// `"chat_template_kwargs": {"enable_thinking": false}`。vLLM 原生写法。
        case chatTemplateKwargs
        /// `"thinking": {"type": "disabled"}`。部分 DeepSeek 系网关认这个。
        case thinkingTypeDisabled

        /// 写进请求体的字段（键 → 值）。
        var bodyEntries: [String: Any] {
            switch self {
            case .none:
                return [:]
            case .enableThinking:
                return ["enable_thinking": false]
            case .chatTemplateKwargs:
                return ["chat_template_kwargs": ["enable_thinking": false]]
            case .thinkingTypeDisabled:
                return ["thinking": ["type": "disabled"]]
            }
        }
    }

    struct Configuration {
        /// 完整的 chat completions 地址（不是 base URL）。
        var endpoint: URL
        /// 为 nil 表示由反向代理注入凭据，App 内不持有 Key。
        var apiKey: String?
        var model: String
        /// 超时即回退规则，宁可慢一步也不能卡住创建流程。
        var timeout: TimeInterval
        /// 是否发送 `response_format: {"type":"json_object"}`。
        ///
        /// 这是服务端能力，不是所有网关都支持。留 false 则完全依赖提示词约束，
        /// 配合 `extractJSONObject` 的宽松解析照样能跑。
        var usesJSONMode: Bool
        /// 用哪种写法关掉思考链。
        ///
        /// 这不是 OpenAI 标准字段，不同网关认不同写法，所以做成可选项。
        /// 默认 `.none`：不带任何可能被拒的字段，保证当前已验证可用的路径稳定。
        /// 想省掉九成的输出 token，改这里并在 Xcode 控制台看 `reasoning_tokens` 是否归零。
        var thinkingDisable: ThinkingDisableStyle
        /// 当服务端拒绝请求（400/422）时，逐级去掉额外字段重试。
        /// 内网网关常见「严格校验未知字段」，开启后无需事先确认服务端能力。
        var retriesWithoutOptionalFields: Bool

        init(
            endpoint: URL,
            apiKey: String?,
            model: String,
            timeout: TimeInterval = 8,
            usesJSONMode: Bool = true,
            thinkingDisable: ThinkingDisableStyle = .none,
            retriesWithoutOptionalFields: Bool = true
        ) {
            self.endpoint = endpoint
            self.apiKey = apiKey
            self.model = model
            self.timeout = timeout
            self.usesJSONMode = usesJSONMode
            self.thinkingDisable = thinkingDisable
            self.retriesWithoutOptionalFields = retriesWithoutOptionalFields
        }

        /// 按「字段最全 → 逐级精简」排列的请求体变体。
        ///
        /// 服务端不认某个额外字段时会返回 400/422，这里逐级去掉再试，
        /// 最后一定能落到「只有提示词约束」这一档，不会因为字段不被支持而彻底失败。
        var bodyVariants: [BodyVariant] {
            var variants: [BodyVariant] = []
            func append(_ variant: BodyVariant) {
                if !variants.contains(variant) { variants.append(variant) }
            }

            if usesJSONMode {
                append(BodyVariant(usesJSONMode: true, thinkingDisable: thinkingDisable))
                // 同时带多个额外字段被拒时，无法判断是哪个的问题。
                // 优先保住已验证可用的 response_format，先只去掉思考开关。
                append(BodyVariant(usesJSONMode: true, thinkingDisable: .none))
            }
            append(BodyVariant(usesJSONMode: false, thinkingDisable: thinkingDisable))
            append(BodyVariant(usesJSONMode: false, thinkingDisable: .none))
            return variants
        }

        /// 公司内网网关（cosmo-mind-coder，实测底层模型为 deepseek-flash）。
        ///
        /// 已知事实：支持 `response_format: json_object`（返回纯 JSON 无 markdown 围栏）；
        /// 忽略 `enable_thinking: false`；默认开思考链，输出 token 九成以上是思考。
        static func cosmoMind(
            apiKey: String?,
            model: String = "cosmo-mind-coder",
            baseURL: String = "https://gpt.cosmoplat.com/v1",
            thinkingDisable: ThinkingDisableStyle = .none
        ) -> Configuration {
            Configuration(
                endpoint: chatCompletionsURL(from: baseURL),
                apiKey: apiKey,
                model: model,
                thinkingDisable: thinkingDisable
            )
        }

        /// 阿里云百炼（DashScope）的 qwen 系列。原生支持 json_object 模式。
        static func dashScope(apiKey: String, model: String = "qwen-flash") -> Configuration {
            Configuration(
                endpoint: chatCompletionsURL(from: "https://dashscope.aliyuncs.com/compatible-mode/v1"),
                apiKey: apiKey,
                model: model
            )
        }

        /// 容忍 base URL 末尾带不带斜杠，也容忍调用方直接给完整路径。
        static func chatCompletionsURL(from base: String) -> URL {
            var text = base.trimmingCharacters(in: .whitespacesAndNewlines)
            while text.hasSuffix("/") { text.removeLast() }
            if !text.hasSuffix("/chat/completions") {
                text += "/chat/completions"
            }
            // 地址写错时宁可回落到达摩院公开地址，也不要在启动时崩掉。
            return URL(string: text)
                ?? URL(string: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")!
        }

        /// 按「环境变量 → Info.plist」的顺序取 Key，两者都没有时返回 nil。
        ///
        /// 环境变量优先，方便在 Xcode scheme 里调试而不必把 Key 写进任何提交进版本库的文件。
        /// 生产环境应让 `apiKey` 保持 nil，改由反向代理注入凭据。
        static func apiKeyFromEnvironment(
            environmentKey: String = "COSMO_MIND_API_KEY",
            infoPlistKey: String = "CosmoMindAPIKey"
        ) -> String? {
            if let value = ProcessInfo.processInfo.environment[environmentKey],
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return value
            }
            if let value = Bundle.main.object(forInfoDictionaryKey: infoPlistKey) as? String,
               !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return value
            }
            return nil
        }
    }

    let source: RoutineParseSource = .enhanced
    let configuration: Configuration

    /// 模型没给出时长时的兜底值：宁可留一项待用户改，也不要丢掉这个任务。
    static let fallbackMinutes: Double = 5

    init(configuration: Configuration) {
        self.configuration = configuration
    }

    func parse(_ input: String, now: Date) async throws -> RoutineParseResult? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 没取到 Key 时给出可操作的提示。否则请求会被判未授权，顶层又只看到「回退规则」，
        // 排查起来会绕远路——最常见的原因就是没有从 Xcode Run 启动。
        if (configuration.apiKey?.isEmpty ?? true) && configuration.endpoint.host != "47.104.95.146" {
            Self.log("未取到 API Key，请求会因未授权失败。检查是否从 Xcode Run 启动（scheme 环境变量只在 Run 时注入）。")
        }

        let content = try await requestCompletion(for: trimmed)
        guard let payload = Self.decodePayload(from: content) else {
            Self.log("模型返回无法解析为任务列表，已回退本机规则")
            return nil
        }

        let steps = payload.steps.map { item in
            RoutineStep(title: item.title, duration: item.minutes * 60)
        }
        guard !steps.isEmpty else { return nil }

        return RoutineParseResult(
            steps: steps,
            deadline: Self.makeDeadline(
                hour: payload.deadlineHour,
                minute: payload.deadlineMinute,
                on: now
            ),
            source: .enhanced,
            leftover: ""
        )
    }

    // MARK: - 请求

    /// 请求体里可选的附加字段。按「最全 → 最简」逐级尝试。
    struct BodyVariant: Equatable {
        var usesJSONMode: Bool
        var thinkingDisable: ThinkingDisableStyle
    }

    /// 逐级降级地发请求：服务端不认某个额外字段（400/422）就去掉它再试。
    ///
    /// 只有「请求形状不对」才值得重试。401 / 429 / 5xx 去掉字段也解决不了，
    /// 直接抛错交回上层回退本机规则，比多绕一轮更快。
    private func requestCompletion(for input: String) async throws -> String {
        var variants = configuration.bodyVariants
        if !configuration.retriesWithoutOptionalFields {
            variants = Array(variants.prefix(1))
        }

        var lastError: Error = RemoteParsingError.invalidResponse

        for (index, variant) in variants.enumerated() {
            do {
                return try await performRequest(for: input, variant: variant)
            } catch RemoteParsingError.httpStatus(let code) where Self.isRejectedRequest(code) {
                lastError = RemoteParsingError.httpStatus(code)
                Self.log("服务端拒绝请求（\(code)），降级到下一个请求体变体")
                // 还有更简的变体就继续，否则让错误冒出去。
                if index == variants.indices.last { throw lastError }
            }
        }
        throw lastError
    }

    /// 400 / 422 表示请求本身被服务端判为不合法，通常就是多了它不认识的字段。
    static func isRejectedRequest(_ statusCode: Int) -> Bool {
        statusCode == 400 || statusCode == 422
    }

    private func performRequest(for input: String, variant: BodyVariant) async throws -> String {
        let (data, response) = try await URLSession.shared.data(
            for: try makeRequest(for: input, variant: variant)
        )

        guard let http = response as? HTTPURLResponse else {
            throw RemoteParsingError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw RemoteParsingError.httpStatus(http.statusCode)
        }

        let decoded = try JSONDecoder().decode(ChatCompletion.self, from: data)
        Self.logUsage(decoded.usage, variant: variant)

        // 思考内容走 reasoning_content，与 content 分开，这里只取 content。
        guard let content = decoded.choices.first?.message.content, !content.isEmpty else {
            throw RemoteParsingError.emptyContent
        }
        return content
    }

    private func makeRequest(for input: String, variant: BodyVariant) throws -> URLRequest {
        var request = URLRequest(url: configuration.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = configuration.timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let apiKey = configuration.apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }

        // 用字典手工拼请求体，而不是固定结构的 Codable 类型：
        // 关闭思考链的字段各家写法不同，键名必须是动态的。
        var body: [String: Any] = [
            "model": configuration.model,
            "messages": [
                ["role": "system", "content": Self.systemPrompt],
                ["role": "user", "content": input]
            ],
            // 抽取任务不需要随机性，固定成 0 让同一段输入稳定出同一份结果。
            "temperature": 0
        ]
        if variant.usesJSONMode {
            body["response_format"] = ["type": "json_object"]
        }
        for (key, value) in variant.thinkingDisable.bodyEntries {
            body[key] = value
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    /// 提示词里必须出现 “JSON” 字样。这是 OpenAI 系 json_object 模式的硬性要求，
    /// 百炼同样如此，去掉会直接报错。
    ///
    /// 本网关已实测会拦：消息里没有 “json” 时返回
    /// `400 invalid_request_error: Prompt must contain the word 'json' in some form`。
    /// 所以改动下面这段提示词时，必须保留第一行的“并以 JSON 返回”。
    /// 万一哪天被误删，`bodyVariants` 的 400 降级会去掉 `response_format` 再试，不至于彻底失效，
    /// 但会白白多绕一轮请求。
    static let systemPrompt = """
    你是任务拆解器。把用户口述的日程拆成按顺序排列的任务列表，并以 JSON 返回。

    规则：
    - 只提取用户明确说出的任务。不要补充、不要推测、不要替用户安排他没提的任务。
    - 任务名沿用用户的原始说法，不要改写、不要加书名号、不要补全动词。
    - 时长统一换算成分钟。用户说“半小时”就是 30，“一小时”就是 60，“一个半”就是 90。
    - 用户没给某个任务的时长时，填 5。
    - 用户提到截止、结束、出门、到期时间时，把小时填进 deadlineHour、分钟填进 deadlineMinute（24 小时制）。
      只给了“8点”这种小时没给分钟的，分钟填 0。
    - 没有提到任何截止时间时，deadlineHour 与 deadlineMinute 都填 null。

    返回的 JSON 结构：
    {"steps":[{"title":"任务名","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}
    """
}

// MARK: - 传输结构

private struct ChatCompletion: Decodable {
    struct Choice: Decodable {
        struct Message: Decodable {
            let content: String?
        }
        let message: Message
    }

    struct Usage: Decodable {
        struct Details: Decodable {
            let reasoningTokens: Int?

            enum CodingKeys: String, CodingKey {
                case reasoningTokens = "reasoning_tokens"
            }
        }

        let completionTokens: Int?
        let details: Details?

        enum CodingKeys: String, CodingKey {
            case completionTokens = "completion_tokens"
            case details = "completion_tokens_details"
        }
    }

    let choices: [Choice]
    let usage: Usage?
}

// MARK: - 宽松解析与校验

extension RemoteRoutineParsingService {
    /// 模型返回的业务载荷。步骤里的时长已经解析并兜底过，消费方直接可用。
    struct ParsedRoutinePayload: Equatable {
        struct Item: Equatable {
            var title: String
            var minutes: Double
        }

        var steps: [Item]
        var deadlineHour: Int?
        var deadlineMinute: Int?
    }

    /// 把模型返回的文本解析成任务与截止时间。
    ///
    /// 刻意做得比「按固定 schema 解码」宽松得多。实测同一个网关，只要提示词里的结构
    /// 示例不够醒目，模型就会自创一套字段（`tasks` / `name` / `duration_minutes` / `time`），
    /// 此时严格解码会直接失败，整条增强路径静默失效——用户看到的是「模型不生效」。
    ///
    /// 所以这里不认死字段名：容器名、任务名字段、时长字段、时间字段都按候选列表逐个试，
    /// 且键名比较时忽略大小写与下划线（`duration_minutes` 与 `durationMinutes` 等价）。
    static func decodePayload(from content: String) -> ParsedRoutinePayload? {
        guard let json = extractJSONObject(from: content),
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data)
        else { return nil }

        return payload(from: object)
    }

    /// 容器字段的候选名（比较前会归一化，见 `normalize(key:)`）。
    private static let containerKeys = [
        "steps", "tasks", "items", "tasklist", "list", "routine", "plan", "计划", "任务列表", "任务"
    ]
    private static let titleKeys = [
        "title", "name", "task", "action", "label", "activity", "content", "任务", "任务名", "名称", "描述"
    ]
    private static let minuteKeys = [
        "durationminutes", "durationmin", "minutes", "minute", "mins", "min", "duration", "时长"
    ]
    private static let secondKeys = [
        "durationseconds", "durationsec", "seconds", "second", "sec", "秒数"
    ]
    private static let clockKeys = [
        "time", "at", "deadline", "deadlinetime", "starttime", "clock", "时间", "时刻"
    ]
    private static let hourKeys = [
        "deadlinehour", "hour", "deadlineh", "时", "小时"
    ]
    private static let minuteOfClockKeys = [
        "deadlineminute", "minute", "deadlinemin", "分", "分钟数"
    ]

    static func payload(from object: Any) -> ParsedRoutinePayload? {
        let root = object as? [String: Any]
        let items = itemDictionaries(from: object)
        guard !items.isEmpty else { return nil }

        var resolved: [ParsedRoutinePayload.Item] = []
        /// 末项携带的时刻当作最终节点。见下面的判断说明。
        var deadlineFromItems: (hour: Int, minute: Int)?

        for (index, item) in items.enumerated() {
            let title = string(in: item, keys: titleKeys)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let title, !title.isEmpty else { continue }

            let minutes = durationMinutes(in: item)
            let isLast = index == items.count - 1

            // 只有**末项**的时刻才当最终节点：「八点半出门」里的「出门」是截止时刻，
            // 不该变成一项 5 分钟的活儿。夹在中间的时刻（如「7点起床，洗脸5分钟」）
            // 只是对任务的描述，该任务照常保留，避免丢任务。
            if isLast, let clock = clockComponents(in: item) {
                deadlineFromItems = clock
                if minutes == nil { continue }
            }

            resolved.append(.init(title: title, minutes: minutes ?? fallbackMinutes))
        }

        guard !resolved.isEmpty else { return nil }

        // 顶层显式给出的截止时间优先，其次才用末项的时刻。
        // 顶层既可能是拆开的 {"deadlineHour":8,"deadlineMinute":30}，
        // 也可能是合成一个字段的 {"deadline":"08:30"}，两种都要认。
        let explicitClock = clockComponents(in: root ?? [:])
        let hour = explicitClock?.hour
            ?? integer(in: root, keys: hourKeys)
            ?? deadlineFromItems?.hour
        let minute = explicitClock?.minute
            ?? integer(in: root, keys: minuteOfClockKeys)
            ?? deadlineFromItems?.minute

        return ParsedRoutinePayload(
            steps: resolved,
            deadlineHour: hour,
            deadlineMinute: minute
        )
    }

    /// 取出任务数组：可能是根对象下的某个键，也可能根就是数组。
    private static func itemDictionaries(from object: Any) -> [[String: Any]] {
        if let array = object as? [[String: Any]] {
            return array
        }
        guard let root = object as? [String: Any] else { return [] }
        for key in containerKeys {
            if let array = value(in: root, keys: [key]) as? [[String: Any]] {
                return array
            }
        }
        return []
    }

    /// 归一化键名：忽略大小写与下划线、连字符，让 snake_case 与 camelCase 等价。
    static func normalize(key: String) -> String {
        key.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    private static func value(in dictionary: [String: Any]?, keys: [String]) -> Any? {
        guard let dictionary else { return nil }
        let wanted = Set(keys.map(normalize(key:)))
        for (key, value) in dictionary where wanted.contains(normalize(key: key)) {
            return value
        }
        return nil
    }

    private static func string(in dictionary: [String: Any], keys: [String]) -> String? {
        guard let raw = value(in: dictionary, keys: keys) else { return nil }
        if let text = raw as? String { return text }
        if let number = raw as? NSNumber { return number.stringValue }
        return nil
    }

    private static func integer(in dictionary: [String: Any]?, keys: [String]) -> Int? {
        guard let raw = value(in: dictionary, keys: keys) else { return nil }
        if let number = doubleValue(raw) { return Int(number) }
        // 字段里塞了完整时刻（"8:30"）时取小时部分，别把 30 当小时用。
        if let text = raw as? String, let clock = clock(from: text) { return clock.hour }
        return nil
    }

    private static func durationMinutes(in item: [String: Any]) -> Double? {
        if let raw = value(in: item, keys: minuteKeys), let minutes = minutes(from: raw) {
            return minutes
        }
        if let raw = value(in: item, keys: secondKeys), let seconds = doubleValue(raw) {
            let minutes = seconds / 60
            return minutes > 0 ? minutes : nil
        }
        return nil
    }

    /// 时长允许是数字、数字字符串，或带单位的中文串（"5分钟"、"2小时"、"90秒"）。
    static func minutes(from value: Any) -> Double? {
        if let number = doubleValue(value) {
            return number > 0 ? number : nil
        }
        guard let text = value as? String, let number = firstNumber(in: text) else { return nil }

        let lowered = text.lowercased()
        if text.contains("秒") || lowered.contains("sec") {
            let minutes = number / 60
            return minutes > 0 ? minutes : nil
        }
        if text.contains("小时") || text.contains("时") || lowered.contains("hour") || lowered.hasSuffix("h") {
            return number * 60
        }
        return number > 0 ? number : nil
    }

    static func doubleValue(_ value: Any) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String {
            return Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    static func firstNumber(in text: String) -> Double? {
        guard let range = text.range(of: #"\d+(?:\.\d+)?"#, options: .regularExpression) else {
            return nil
        }
        return Double(text[range])
    }

    /// 解析步骤里的时间点，返回时分。识别 "08:30"、"8:30"、"8点30"、"8点半"、
    /// 数字 830，以及 `{"hour": 8, "minute": 30}` 这类嵌套写法。
    static func clockComponents(in item: [String: Any]) -> (hour: Int, minute: Int)? {
        guard let raw = value(in: item, keys: clockKeys) else { return nil }
        if let text = raw as? String { return clock(from: text) }
        if let number = doubleValue(raw), let clock = clock(fromNumber: number) { return clock }
        if let dictionary = raw as? [String: Any] {
            guard let hour = integer(in: dictionary, keys: hourKeys) else { return nil }
            let minute = integer(in: dictionary, keys: minuteOfClockKeys) ?? 0
            return valid(hour: hour, minute: minute)
        }
        return nil
    }

    /// 解析 "08:30" / "8点30" / "8点半" / "8点" 这类时刻文本。
    static func clock(from text: String) -> (hour: Int, minute: Int)? {
        let pattern = #"(\d{1,2})\s*(?::|：|点|時|时)\s*(\d{1,2})?"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let hourRange = Range(match.range(at: 1), in: text),
              let hour = Int(text[hourRange])
        else { return nil }

        var minute = Range(match.range(at: 2), in: text).flatMap { Int(text[$0]) } ?? 0
        // "8点半" 没有显式分钟，靠“半”字补 30。
        if match.range(at: 2).location == NSNotFound, text.contains("半") {
            minute = 30
        }
        return valid(hour: hour, minute: minute)
    }

    /// 以整数表示的时刻：0…23 当作小时，100…2359 当作 hhmm（如 830 → 8:30）。
    static func clock(fromNumber number: Double) -> (hour: Int, minute: Int)? {
        let intValue = Int(number)
        if (0...23).contains(intValue) { return (intValue, 0) }
        if (100...2359).contains(intValue) {
            return valid(hour: intValue / 100, minute: intValue % 100)
        }
        return nil
    }

    private static func valid(hour: Int, minute: Int) -> (hour: Int, minute: Int)? {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return (hour, minute)
    }

    /// 从模型输出里抠出 JSON 主体：先剥 markdown 围栏，再截取最外层的结构。
    ///
    /// 对象和数组都可能当根（`{...}` 与 `[{...}]`），取起点更靠前的那个：
    /// 对象内部含数组时对象起点更早，裸数组时数组起点更早。
    static func extractJSONObject(from content: String) -> String? {
        var text = content.trimmingCharacters(in: .whitespacesAndNewlines)

        if text.hasPrefix("```") {
            if let firstNewline = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: firstNewline)...])
            }
            if let closing = text.range(of: "```", options: .backwards) {
                text = String(text[text.startIndex..<closing.lowerBound])
            }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let object = enclosingSubstring(in: text, open: "{", close: "}")
        let array = enclosingSubstring(in: text, open: "[", close: "]")

        switch (object, array) {
        case let (object?, array?):
            return array.start < object.start ? array.text : object.text
        case let (object?, nil):
            return object.text
        case let (nil, array?):
            return array.text
        default:
            return nil
        }
    }

    /// 返回最外层结构的文本**以及它在原串里的起点**。
    ///
    /// 起点是必需的：`{}` 里嵌 `[]` 时，两者的文本都能取到，得靠谁先出现来判断谁是根，
    /// 只比较文本是比不出来的。
    private static func enclosingSubstring(
        in text: String,
        open: Character,
        close: Character
    ) -> (text: String, start: String.Index)? {
        guard let start = text.firstIndex(of: open),
              let end = text.lastIndex(of: close),
              start < end
        else { return nil }
        return (String(text[start...end]), start)
    }

    /// 截止时间只在模型给出了合法时分时才构造。非法值一律当作没提，
    /// 由上层决定用不用 UI 上的截止时间。
    static func makeDeadline(
        hour: Int?,
        minute: Int?,
        on date: Date,
        calendar: Calendar = .current
    ) -> Date? {
        guard let hour, (0...23).contains(hour) else { return nil }
        let resolvedMinute = minute ?? 0
        guard (0...59).contains(resolvedMinute) else { return nil }
        return calendar.date(bySettingHour: hour, minute: resolvedMinute, second: 0, of: date)
    }
}

// MARK: - 调试日志

extension RemoteRoutineParsingService {
    /// 把 token 用量打到 Xcode 控制台。
    ///
    /// 存在的唯一理由：确认思考链到底关掉没有。`reasoningTokens` 长期占输出的大头，
    /// 说明网关忽略了关闭字段，该换写法或换渠道——只看返回内容看不出来这件事。
    ///
    /// 参数类型 `ChatCompletion.Usage` 是文件私有的，所以这里也只能是 fileprivate。
    fileprivate static func logUsage(_ usage: ChatCompletion.Usage?, variant: BodyVariant) {
        #if DEBUG
        guard let usage else { return }
        let completion = usage.completionTokens ?? 0
        let reasoning = usage.details?.reasoningTokens ?? 0
        print("""
        [MorningMainline] 云端解析用量：输出 \(completion) token，其中思考 \(reasoning) \
        （response_format: \(variant.usesJSONMode)，thinking: \(variant.thinkingDisable.rawValue)）
        """)
        #endif
    }

    static func log(_ message: String) {
        #if DEBUG
        print("[MorningMainline] \(message)")
        #endif
    }
}

// MARK: - 错误

enum RemoteParsingError: LocalizedError {
    case invalidResponse
    case httpStatus(Int)
    case emptyContent

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "服务返回了无法识别的响应。"
        case .httpStatus(let code):
            "服务返回状态码 \(code)。"
        case .emptyContent:
            "服务返回了空内容。"
        }
    }
}
