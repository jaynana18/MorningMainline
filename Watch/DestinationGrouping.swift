import Foundation

/// 把扁平的任务列表折叠成「目的地组」。
///
/// 这是 `web/src/views/session/destinationGroups.ts:buildDestinationGroups` 的 Swift 移植，
/// 只取 Watch 需要的**只读**部分：分组、组名、通勤时长。
/// 手机版那套「拖动重排 + 通勤重算 + 草稿预览」在手表上不做（表盘太小，且排序结果会从
/// 手机同步过来），因此这里刻意不移植 `replanCommutes` / `applyDraftOrder`。
///
/// 分组不变量与 web 版一致：组内恒为「先通勤、后活动」，因为「先到达、再做事」是事实。
enum DestinationGrouping {
    /// 一个目的地组。
    struct Group: Identifiable {
        var id: String
        /// 组内通勤项；纯任务组为 nil。
        var commute: StepProgress?
        /// 组内活动项，恒在通勤之后。
        var activities: [StepProgress]
        /// 目的地名，用于「公司」这类组标题。
        var placeName: String

        /// 组标题：优先活动首项（形如 `公司 · 上班`），无活动时回落通勤项标题。
        var title: String {
            activities.first?.step.title ?? commute?.step.title ?? placeName
        }

        /// 该组的通勤时长；无通勤为 nil。
        ///
        /// **Watch 上只显示时间、不显示地图** —— 这是本类型存在的主要理由：
        /// 把路线折算成一个「路上要花多久」，让人一眼知道该什么时候动身。
        var commuteDuration: TimeInterval? {
            guard let commute else { return nil }
            // `remainingWork` 在挂起后会变成剩余时长，比原始 duration 更贴近当下。
            let seconds = commute.remainingWork
            return seconds > 0 ? seconds : nil
        }

        /// 该组是否还有未完成的活动项。全完成时整组可以收起来。
        var hasIncompleteActivity: Bool {
            activities.contains { $0.state.isIncomplete }
        }
    }

    /// 通勤项判定：显式带路线，或标题是「通勤到X」（旧数据可能只留标题）。
    static func isCommute(_ step: RoutineStep) -> Bool {
        step.commute != nil || step.title.hasPrefix("通勤到")
    }

    /// 「通勤到公司」→「公司」；非该前缀原样返回。
    static func placeName(fromCommuteTitle title: String) -> String {
        title.hasPrefix("通勤到") ? String(title.dropFirst(3)) : title
    }

    /// 按界面顺序把任务折叠成目的地组。
    ///
    /// 遇到通勤项即开新组，其后不带路线的任务挂进该组；开头（或两组之间）的散任务
    /// 各自独立成组。只处理 `role == .task`，`deadline` 节点不参与分组。
    static func groups(from items: [StepProgress]) -> [Group] {
        var result: [Group] = []
        var key: String?
        var commute: StepProgress?
        var activities: [StepProgress] = []

        // 嵌套函数可直接改写上面的捕获变量，无需 inout。
        // ⚠️ 绑定名必须与外部变量不同：`guard let key` 会**遮蔽**外层 `var key`，
        // 之后 `key = nil` 改的是那个不可变的新常量，编译不过。
        func close() {
            guard let currentKey = key else { return }
            result.append(makeGroup(key: currentKey, commute: commute, activities: activities))
            key = nil
            commute = nil
            activities = []
        }

        for item in items where item.step.role == .task {
            if isCommute(item.step) {
                close()
                key = item.id.uuidString
                commute = item
                continue
            }
            if key == nil {
                key = item.id.uuidString
            }
            activities.append(item)
        }
        close()
        return result
    }

    private static func makeGroup(
        key: String,
        commute: StepProgress?,
        activities: [StepProgress]
    ) -> Group {
        let info = commute?.step.commute
        // 局部变量不能叫 placeName：会遮蔽同名的静态方法，下面那行就变成
        // 「把 String 当函数调用」。用 resolved 命名避开。
        var resolved = info?.address ?? ""
        if resolved.isEmpty, let commute {
            resolved = placeName(fromCommuteTitle: commute.step.title)
        }
        if resolved.isEmpty {
            resolved = activities.first?.step.title ?? "未命名"
        }
        return Group(id: key, commute: commute, activities: activities, placeName: resolved)
    }
}
