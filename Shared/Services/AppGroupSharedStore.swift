import Foundation
import WidgetKit

/// App Group 共享容器：让 iOS / watchOS App 与 Widget 扩展读取同一份快照。
enum AppGroupSharedStore {
    /// 必须与工程里启用的 App Group 一致。
    static let appGroupID = "group.com.jaynana.MorningMainline"

    /// Widget 只共享展示所需的精简数据，避免扩展依赖完整业务模型。
    static let widgetSnapshotKey = "morning-mainline.widget-snapshot.v1"

    static var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    static func readWidgetSnapshot() -> MainlineWidgetSnapshot? {
        guard let defaults = sharedDefaults,
              let data = defaults.data(forKey: widgetSnapshotKey)
        else { return nil }
        return try? JSONDecoder().decode(MainlineWidgetSnapshot.self, from: data)
    }

    static func write(_ snapshot: MainlineWidgetSnapshot) {
        guard let defaults = sharedDefaults,
              let data = try? JSONEncoder().encode(snapshot)
        else { return }
        defaults.set(data, forKey: widgetSnapshotKey)
        WidgetCenter.shared.reloadAllTimelines()
    }
}
