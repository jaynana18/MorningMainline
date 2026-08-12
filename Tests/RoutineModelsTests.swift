import XCTest
@testable import MorningMainline

final class RoutineModelsTests: XCTestCase {
    func testRelativeStepUsesSessionStart() {
        let start = Date(timeIntervalSince1970: 1_000)
        let step = RoutineStep(
            title: "刷牙",
            prompt: "开始了吗",
            timing: .relative(seconds: 300)
        )
        XCTAssertEqual(step.dueDate(startedAt: start), start.addingTimeInterval(300))
    }

    func testDefaultRoutineContainsHardDepartureDeadline() {
        let departure = RoutineTemplate.morning.steps.first { $0.title == "出门" }
        XCTAssertEqual(departure?.importance, .hardDeadline)
    }
}

