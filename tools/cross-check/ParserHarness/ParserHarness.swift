//
// ParserHarness.swift — 解析层交叉验证 harness（M5–M12 / M27）
//
// 与 RoutineModels.swift / RoutineParsingService.swift / RemoteRoutineParsingService.swift
// 一起编译（三者均只 import Foundation）。用固定 anchor + TZ=Asia/Shanghai 运行。
//
import Foundation

func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

let deadlineInputs = [
    "出门10点半", "结束8点半", "8点半出门", "18点半结束",
    "结束18:10", "结束 18:10", "截止8:35", "结束18点10分", "出门10点",
    "去厕所5分钟 结束8:35", "18点30结束，去厕所5分钟", "8点出门",
    "18:30结束", "18点30分结束", "18点结束",
    "买水果10分钟", "去厕所5分钟 刷杯子2分钟", "7点起床，洗脸5分钟",
]

let stepInputs = [
    "博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分",
    "语文2小时 英语1小时 数学30分钟",
    "去厕所5分钟 别忘了倒垃圾",
    "18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟",
]

let analyzeInputs = [
    "博兴任务20分钟  去厕所5分钟",
    "去厕所5分钟 别忘了倒垃圾",
    "去厕所5分钟 截止时间18点10分",
    "去厕所5分钟 8点出门",
]

let remoteInputs = [
    "{\"steps\":[{\"title\":\"去厕所\",\"durationMinutes\":5}],\"deadlineHour\":8,\"deadlineMinute\":35}",
    "好的，这是解析结果：\n```json\n{\"steps\":[{\"title\":\"刷牙\",\"durationMinutes\":3}],\"deadlineHour\":null,\"deadlineMinute\":null}\n```\n需要我调整吗？",
    "{\"steps\":[{\"title\":\"洗脸\",\"durationMinutes\":\"5\"}]}",
    "{\"tasks\":[{\"name\":\"去厕所\",\"duration_minutes\":5},{\"name\":\"刷杯子\",\"duration_minutes\":2},{\"name\":\"出门\",\"time\":\"08:30\"}]}",
    "[{\"title\":\"刷牙\",\"durationMinutes\":3}]",
    "{\"steps\":[{\"title\":\"洗脸\",\"durationMinutes\":5},{\"title\":\"出门\",\"time\":\"8点半\"}]}",
    "{\"steps\":[{\"title\":\"洗脸\",\"durationMinutes\":5}],\"deadline\":\"08:30\"}",
    "{\"steps\":[{\"title\":\"出门\",\"time\":\"8点半\"}]}",
    "{\"steps\":[{\"title\":\"7点起床\",\"time\":\"7:00\"},{\"title\":\"洗脸\",\"durationMinutes\":5}]}",
    "{\"steps\":[{\"title\":\"倒垃圾\"},{\"title\":\"洗脸\",\"durationMinutes\":5}]}",
    "{\"steps\":[]}",
    "我不知道该怎么拆",
    "",
]

@main
struct ParserHarness {
    static func main() {
        let tz = TimeZone(identifier: "Asia/Shanghai") ?? TimeZone.current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz
        // 2026-08-13 12:00 +08:00（与规格 assertDeadline 锚点一致）
        let anchor = Date(timeIntervalSince1970: 1_786_593_600)

        var deadlineMap: [String: Any] = [:]
        for input in deadlineInputs {
            let deadline = QuickRoutineParser.inferredDeadline(from: input, relativeTo: anchor, calendar: calendar)
            deadlineMap[input] = deadline.map { ms($0) as Any } ?? NSNull()
        }

        var stepsMap: [String: Any] = [:]
        for input in stepInputs {
            let steps = QuickRoutineParser.makeSteps(from: input)
            stepsMap[input] = steps.map { ["title": $0.title, "duration": $0.duration, "role": $0.role.rawValue] }
        }

        var analyzeMap: [String: Any] = [:]
        for input in analyzeInputs {
            let outcome = QuickRoutineParser.analyze(from: input, relativeTo: anchor, calendar: calendar)
            analyzeMap[input] = [
                "titles": outcome.steps.map { $0.title },
                "leftover": outcome.leftover,
                "isComplete": outcome.isComplete,
                "deadline": outcome.deadline.map { ms($0) as Any } ?? NSNull(),
            ]
        }

        var remoteMap: [String: Any] = [:]
        for content in remoteInputs {
            if let payload = RemoteRoutineParsingService.decodePayload(from: content) {
                remoteMap[content] = [
                    "steps": payload.steps.map { ["title": $0.title, "minutes": $0.minutes] },
                    "deadlineHour": payload.deadlineHour.map { $0 as Any } ?? NSNull(),
                    "deadlineMinute": payload.deadlineMinute.map { $0 as Any } ?? NSNull(),
                ]
            } else {
                remoteMap[content] = NSNull()
            }
        }

        let root: [String: Any] = [
            "anchor": ms(anchor),
            "deadline": deadlineMap,
            "steps": stepsMap,
            "analyze": analyzeMap,
            "remote": remoteMap,
        ]
        let data = try! JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    }
}
