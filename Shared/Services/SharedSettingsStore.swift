import Foundation

/// 需要跨设备共用的轻量设置（目前只有高德 Web 服务 Key 与出行方式）。
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
    /// 写入这份设置的设备 id。用于识别「自己的回声」——若不做这一步，
    /// 两端会各自把对方的旧值再发回去，形成来回覆盖。
    var originID: UUID?

    init(amapKey: String = "", travelMode: String = TravelMode.driving.rawValue, originID: UUID? = nil) {
        self.amapKey = amapKey
        self.travelMode = travelMode
        self.originID = originID
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

    /// 接受对端同步来的设置。**自己发出的回声必须丢掉**，否则会和对方的写入互相打架。
    /// 返回是否真的采纳了。
    @discardableResult
    static func adopt(_ incoming: MainlineSettings, localDeviceID: UUID) -> Bool {
        guard incoming.originID != localDeviceID else { return false }
        current = incoming
        return true
    }
}
