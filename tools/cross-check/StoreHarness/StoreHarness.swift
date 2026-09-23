//
// StoreHarness.swift — RoutineStore 状态机交叉验证 harness
//
// 与 RoutineModels.swift / RoutineStore.swift / ConnectivityService.swift /
// AppGroupSharedStore.swift / ReminderScheduler.swift / MainlineWidgetShared.swift 一起编译。
//
// 运行 `store_harness`：用固定 now 真跑 RoutineStore.start(RoutineTemplate.morning)，
// 打印生成的 session.progress 全部字段（绝对时刻 unix ms），供 TS 逐项比对。
//
import Foundation

func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

@main
struct StoreHarness {
    @MainActor
    static func main() {
        // 固定 now：2026-08-13 07:00:00 +08:00（用 TZ=Asia/Shanghai 运行以保证 Calendar.current 一致）
        let fixedNow = Date(timeIntervalSince1970: 1_786_575_600)

        let store = RoutineStore(deviceRole: .phone)
        let template = RoutineTemplate.morning
        store.start(template, now: fixedNow)

        guard let session = store.session else {
            print("{\"error\":\"NO_SESSION\"}")
            exit(3)
        }

        let progressArray: [[String: Any]] = session.progress.map { p in
            [
                "title": p.step.title,
                "role": p.step.role.rawValue,
                "importance": p.step.importance.rawValue,
                "stepDuration": p.step.duration,
                "state": p.state.rawValue,
                "dueAt": ms(p.dueAt),
                "plannedDueAt": p.plannedDueAt.map { ms($0) as Any } ?? NSNull(),
                "remainingDuration": p.remainingDuration.map { $0 as Any } ?? NSNull(),
                "snoozeCount": p.snoozeCount,
                "isTemporary": p.isTemporary,
                "startedAt": p.startedAt.map { ms($0) as Any } ?? NSNull(),
                "completedAt": p.completedAt.map { ms($0) as Any } ?? NSNull(),
            ]
        }

        let result: [String: Any] = [
            "timeZone": TimeZone.current.identifier,
            "now": ms(fixedNow),
            "templateMode": template.mode.rawValue,
            "templateDeadlineHour": template.deadlineHour.map { $0 as Any } ?? NSNull(),
            "templateDeadlineMinute": template.deadlineMinute.map { $0 as Any } ?? NSNull(),
            "templateBuffer": template.buffer,
            "totalTaskDuration": template.totalTaskDuration,
            "sessionState": session.state.rawValue,
            "targetDeadline": session.targetDeadline.map { ms($0) as Any } ?? NSNull(),
            "plannedStartAt": ms(session.plannedStartAt),
            "remainingBuffer": session.remainingBuffer,
            "revision": session.revision,
            "activeProgressIDIsNil": session.activeProgressID == nil,
            "suspendedProgressIDsIsNil": session.suspendedProgressIDs == nil,
            "progress": progressArray,
        ]

        let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    }
}
