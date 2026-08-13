import XCTest
@testable import MorningMainline

final class RoutineModelsTests: XCTestCase {
    func testMorningRoutineHasAnActualDepartureDeadline() {
        let departure = RoutineTemplate.morning.deadlineStep
        XCTAssertEqual(departure?.title, "出门")
        XCTAssertEqual(departure?.importance, .hardDeadline)
        XCTAssertEqual(RoutineTemplate.morning.buffer, 10 * 60)
    }

    func testBackwardRoutineCalculatesStartFromDeadlineAndBuffer() {
        let calendar = Calendar(identifier: .gregorian)
        let date = calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 7, minute: 0))!
        let deadline = RoutineTemplate.morning.deadline(on: date, calendar: calendar)!
        let start = deadline.addingTimeInterval(-RoutineTemplate.morning.totalTaskDuration - RoutineTemplate.morning.buffer)

        XCTAssertEqual(calendar.component(.hour, from: deadline), 8)
        XCTAssertEqual(calendar.component(.minute, from: deadline), 35)
        XCTAssertEqual(start.timeIntervalSince(deadline), -(35 * 60))
    }

    func testQuickParserOnlyBuildsTaskSteps() {
        let steps = QuickRoutineParser.makeSteps(
            from: "博兴任务20分钟  去厕所5分钟 App安装5分钟 截止时间18点10分"
        )

        XCTAssertEqual(steps.map(\.title), ["博兴任务", "去厕所", "App安装"])
        XCTAssertEqual(steps.map(\.duration), [20 * 60, 5 * 60, 5 * 60])
        XCTAssertTrue(steps.allSatisfy { $0.role == .task })
    }

    func testOldTemplateWithoutRecurrenceDefaultsToOnce() throws {
        let template = RoutineTemplate.homework
        let data = try JSONEncoder().encode(template)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "recurrence")
        let oldData = try JSONSerialization.data(withJSONObject: object)
        let decoded = try JSONDecoder().decode(RoutineTemplate.self, from: oldData)

        XCTAssertEqual(decoded.effectiveRecurrence, .once)
    }

    func testQuickTemplateUsesExplicitDeadlineAndRecurrence() throws {
        let calendar = Calendar(identifier: .gregorian)
        let deadline = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 18, minute: 10))
        )
        let template = try XCTUnwrap(
            QuickRoutineParser.makeTemplate(
                from: "博兴任务20分钟 去厕所5分钟 App安装5分钟",
                deadline: deadline,
                recurrence: .daily,
                calendar: calendar
            )
        )

        XCTAssertEqual(template.deadlineHour, 18)
        XCTAssertEqual(template.deadlineMinute, 10)
        XCTAssertEqual(template.effectiveRecurrence, .daily)
        XCTAssertEqual(template.taskSteps.count, 3)
        XCTAssertEqual(template.deadlineStep?.title, "完成")
    }

    func testQuickTemplateWithoutDeadlineUsesForwardTiming() throws {
        let template = try XCTUnwrap(
            QuickRoutineParser.makeTemplate(
                from: "语文2小时 英语1小时 数学30分钟",
                deadline: nil,
                recurrence: .once
            )
        )

        XCTAssertEqual(template.mode, .forward)
        XCTAssertNil(template.deadlineHour)
        XCTAssertNil(template.deadlineMinute)
        XCTAssertNil(template.deadlineStep)
        XCTAssertEqual(template.taskSteps.map(\.title), ["语文", "英语", "数学"])
    }
}
