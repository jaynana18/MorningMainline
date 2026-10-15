import Foundation

/// 超时提醒的间隔策略（单位：分钟），**分两阶段**：拖得越久、催得越紧。
///
/// 与 JS 侧 `web/src/core/reminders.ts` 的 `OverduePolicy` **同名同义、字段同名** ——
/// 这是 TS ↔ Swift 的逐字镜像约束的一部分（与 `ReminderScheduler` 的文案镜像同源），
/// 改动必须两边同步，否则同一个设置在两端算出不同的提醒节奏。
///
/// ⚠️ 默认值刻意是「两阶段同值（全程 2 分钟）」：老用户升级后行为**完全不变**，
/// 想「越拖越密」得自己去个人中心开。不擅自改变既有的提醒节奏。
struct OverduePolicy: Codable, Hashable, Sendable {
    /// 阶段一的间隔（分钟）。
    var earlyInterval: Int
    /// 从超时第几分钟起切换到阶段二。
    var switchAfter: Int
    /// 阶段二的间隔（分钟）。
    var lateInterval: Int

    static let intervalRange = 1...10
    static let switchRange = 1...60

    init(earlyInterval: Int = 2, switchAfter: Int = 10, lateInterval: Int = 2) {
        self.earlyInterval = earlyInterval
        self.switchAfter = switchAfter
        self.lateInterval = lateInterval
    }

    /// 手写解码：这份值会经 App Group / WCSession 两道持久化，任何一道留下脏值
    /// （缺键、越界、类型不对）都不该让**整份设置**解码失败 —— 那会连带丢掉用户的高德 Key。
    /// 逐字段 `decodeIfPresent` + 夹取，坏的那项回落默认，其余照常还原。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        earlyInterval = Self.clamp(
            try? container.decodeIfPresent(Int.self, forKey: .earlyInterval),
            in: Self.intervalRange,
            fallback: 2
        )
        switchAfter = Self.clamp(
            try? container.decodeIfPresent(Int.self, forKey: .switchAfter),
            in: Self.switchRange,
            fallback: 10
        )
        lateInterval = Self.clamp(
            try? container.decodeIfPresent(Int.self, forKey: .lateInterval),
            in: Self.intervalRange,
            fallback: 2
        )
    }

    private enum CodingKeys: String, CodingKey {
        case earlyInterval, switchAfter, lateInterval
    }

    private static func clamp(_ value: Int?, in range: ClosedRange<Int>, fallback: Int) -> Int {
        guard let value else { return fallback }
        return min(range.upperBound, max(range.lowerBound, value))
    }

    /// 夹到合法范围的新实例。用于写入前兜底（UI 已限制范围，但不能只靠 UI）。
    var normalized: OverduePolicy {
        OverduePolicy(
            earlyInterval: Self.clamp(earlyInterval, in: Self.intervalRange, fallback: 2),
            switchAfter: Self.clamp(switchAfter, in: Self.switchRange, fallback: 10),
            lateInterval: Self.clamp(lateInterval, in: Self.intervalRange, fallback: 2)
        )
    }

    /// 按策略算出各轮的触发偏移（秒），升序；第 i 项即第 i 轮。
    ///
    /// 与 JS 侧 `overdueFireOffsets` **同口径**：阶段一是「严格早于切换点」的整倍数，
    /// 阶段二**从切换点本身起**按 `lateInterval` 递推 —— 这样两阶段无缝衔接，
    /// 不会出现「9 分钟响过之后要等到 12 分钟」的空档。
    ///
    /// 第 0 轮不是超时那一刻，而是「超时满 `earlyInterval` 分钟」：`dueAt` 那一刻
    /// 已经由到点通知响过了，从第 0 秒起算会在同一秒弹两条。
    func fireOffsets(limit: Int) -> [TimeInterval] {
        let policy = normalized
        let early = TimeInterval(policy.earlyInterval * 60)
        let late = TimeInterval(policy.lateInterval * 60)
        let switchAt = TimeInterval(policy.switchAfter * 60)
        var offsets: [TimeInterval] = []
        var t = early
        while t < switchAt && offsets.count < limit {
            offsets.append(t)
            t += early
        }
        t = switchAt
        while offsets.count < limit {
            offsets.append(t)
            t += late
        }
        return offsets
    }
}

/// 需要跨设备共用的轻量设置（高德 Web 服务 Key、出行方式、播报开关、超时提醒间隔）。
///
/// **为什么不能只靠 App Group**：App Group 解决的是「同一设备内 App 与其扩展共享容器」
/// （iPhone App ↔ iOS Widget、Watch App ↔ 表盘复杂功能）。iPhone 与 Watch 是两台设备、
/// 两个独立容器，即便 App Group 标识符完全相同也读不到对方的数据。
/// 因此本结构的同步路径是：iPhone 写入 App Group → 经 `ConnectivityService`（WCSession）
/// 送到手表 → 手表写入**自己设备上**的 App Group，供手表 App 与表盘复杂功能共用。
struct MainlineSettings: Codable, Hashable, Sendable {
    /// 高德 Web 服务 Key。与任务数据分离存放，**不进 RoutineSnapshot** ——
    /// 快照会经由 iCloud/WCSession 多处落盘，而 Key 是凭据，不该跟着业务数据到处飘。
    var amapKey: String
    /// 上次使用的出行方式。手表与手机保持一致，省得每端各选一次。
    var travelMode: String
    /// App 内语音播报开关，默认开。关掉只影响「念不念」，弹窗照常显示。
    ///
    /// ⚠️ 与系统「播报通知」（设置 → Siri 与搜索）无关：那条只在锁屏/熄屏生效，
    /// 本开关管的只是 App 自己念的那一路（亮屏也响）。两者互不影响。
    var speechEnabled: Bool
    /// 超时提醒的间隔策略（两阶段）。与播报开关同性质：属于「账号级的定制化偏好」，
    /// 跟着设置一起跨设备走（App Group → WCSession → 对端 App Group）。
    var overduePolicy: OverduePolicy
    /// 写入这份设置的设备 id。用于识别「自己的回声」——若不做这一步，
    /// 两端会各自把对方的旧值再发回去，形成来回覆盖。
    var originID: UUID?

    init(
        amapKey: String = "",
        travelMode: String = TravelMode.driving.rawValue,
        speechEnabled: Bool = true,
        overduePolicy: OverduePolicy = OverduePolicy(),
        originID: UUID? = nil
    ) {
        self.amapKey = amapKey
        self.travelMode = travelMode
        self.speechEnabled = speechEnabled
        self.overduePolicy = overduePolicy
        self.originID = originID
    }

    /// 🔴 手写解码，**必须**如此：`speechEnabled` 是后加的字段，而 App Group / WCSession
    /// 里可能还躺着旧版本写下的数据。`JSONDecoder` 对「非可选字段缺失」会**整体抛错**，
    /// 那样 `SharedSettingsStore.current` 的 `try?` 会走到 `catch` 分支、返回一份全新的
    /// 默认设置 —— 用户填好的高德 Key 会**静默丢失**，且只表现为「怎么又要重填一次」。
    ///
    /// 用 `decodeIfPresent` 逐字段兜底：缺失的键取默认值，其余字段照常还原。
    /// 对端是旧版本 App 时（WCSession 推来的设置同样没有新键）也靠这里保住兼容。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        amapKey = try container.decodeIfPresent(String.self, forKey: .amapKey) ?? ""
        travelMode = try container.decodeIfPresent(String.self, forKey: .travelMode)
            ?? TravelMode.driving.rawValue
        // 旧数据没有这个键 → 取 true（默认开），而不是 false。
        speechEnabled = try container.decodeIfPresent(Bool.self, forKey: .speechEnabled) ?? true
        // ⚠️ 这里必须包 `try?`：`OverduePolicy` 是嵌套结构，若它内部出现类型不符
        // （对端是未来版本、塞了字符串之类），`decodeIfPresent` 会**抛错**，
        // 而那一抛会把整份 `MainlineSettings` 一起带走 → 用户的高德 Key 静默丢失。
        // 包成 `try?` 后退化成「这一项回落默认」，代价可控。
        overduePolicy = (try? container.decodeIfPresent(OverduePolicy.self, forKey: .overduePolicy))
            ?? OverduePolicy()
        originID = try container.decodeIfPresent(UUID.self, forKey: .originID)
    }

    /// 显式声明，与手写的 `init(from:)` 配套。键名即落盘 JSON 的键名，
    /// **改动会破坏已存数据的兼容性**，不要重命名。
    private enum CodingKeys: String, CodingKey {
        case amapKey, travelMode, speechEnabled, overduePolicy, originID
    }

    var mode: TravelMode { TravelMode(rawValue: travelMode) ?? .driving }
    var hasKey: Bool { !amapKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// 本机（当前设备）的共享设置存取。落在 App Group 容器的 UserDefaults 里，
/// 于是同一台设备上的 App 与其 Widget/复杂功能扩展读到的是同一份。
enum SharedSettingsStore {
    private static let key = "morning-mainline.settings.v1"

    static var current: MainlineSettings {
        get {
            guard let defaults = AppGroupSharedStore.sharedDefaults,
                  let data = defaults.data(forKey: key),
                  let settings = try? JSONDecoder().decode(MainlineSettings.self, from: data)
            else { return MainlineSettings() }
            return settings
        }
        set {
            guard let defaults = AppGroupSharedStore.sharedDefaults,
                  let data = try? JSONEncoder().encode(newValue)
            else { return }
            defaults.set(data, forKey: key)
        }
    }

    /// 只改高德 Key，保留其余字段。返回更新后的完整设置，便于直接广播出去。
    @discardableResult
    static func updateAmapKey(_ value: String) -> MainlineSettings {
        var settings = current
        settings.amapKey = value
        current = settings
        return settings
    }

    /// 只改出行方式，保留其余字段。
    @discardableResult
    static func updateTravelMode(_ mode: TravelMode) -> MainlineSettings {
        var settings = current
        settings.travelMode = mode.rawValue
        current = settings
        return settings
    }

    /// 只改播报开关，保留其余字段（尤其是高德 Key）。
    @discardableResult
    static func updateSpeechEnabled(_ enabled: Bool) -> MainlineSettings {
        var settings = current
        settings.speechEnabled = enabled
        current = settings
        return settings
    }

    /// 只改超时提醒间隔策略，保留其余字段。写入前夹到合法范围。
    @discardableResult
    static func updateOverduePolicy(_ policy: OverduePolicy) -> MainlineSettings {
        var settings = current
        settings.overduePolicy = policy.normalized
        current = settings
        return settings
    }

    /// 接受对端同步来的设置。**自己发出的回声必须丢掉**，否则会和对方的写入互相打架。
    /// 返回是否真的采纳了。
    @discardableResult
    static func adopt(_ incoming: MainlineSettings, localDeviceID: UUID) -> Bool {
        guard incoming.originID != localDeviceID else { return false }
        current = incoming
        return true
    }
}
