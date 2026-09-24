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

    func testPassedDeadlineRollsOnlyDailyTemplateToTomorrow() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 14, hour: 12))
        )
        let dailyDeadline = try XCTUnwrap(RoutineTemplate.morning.deadline(on: now, calendar: calendar))
        var oneTime = RoutineTemplate.morning
        oneTime.recurrence = .once
        let oneTimeDeadline = try XCTUnwrap(oneTime.deadline(on: now, calendar: calendar))

        XCTAssertEqual(calendar.component(.day, from: dailyDeadline), 15)
        XCTAssertEqual(calendar.component(.day, from: oneTimeDeadline), 14)
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

    func testOverdueSessionKeepsDeadlineLastAndEstimatesCompletion() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let target = now.addingTimeInterval(-10 * 60)
        let first = StepProgress(
            step: RoutineStep(title: "当前任务", duration: 5 * 60),
            dueAt: target
        )
        let second = StepProgress(
            step: RoutineStep(title: "后续任务", duration: 5 * 60),
            dueAt: target.addingTimeInterval(5 * 60)
        )
        let deadline = StepProgress(
            step: RoutineStep(
                title: "完成",
                duration: 0,
                importance: .hardDeadline,
                role: .deadline
            ),
            dueAt: target.addingTimeInterval(5 * 60)
        )
        let session = RoutineSession(
            id: UUID(),
            templateID: UUID(),
            templateName: "测试",
            templateSymbol: "checkmark",
            startedAt: target,
            plannedStartAt: target,
            targetDeadline: target,
            state: .running,
            primaryDevice: .phone,
            progress: [first, second, deadline],
            remainingBuffer: 0,
            updatedAt: target,
            revision: 1
        )

        let estimates = session.estimatedDueDates(at: now)
        let expectedCompletion = try XCTUnwrap(session.estimatedCompletion(at: now))

        XCTAssertEqual(estimates[first.id], now.addingTimeInterval(5 * 60))
        XCTAssertEqual(estimates[second.id], now.addingTimeInterval(10 * 60))
        XCTAssertEqual(expectedCompletion, now.addingTimeInterval(10 * 60))
        XCTAssertTrue(session.isLate(at: now))
    }

    func testOldProgressWithoutNewTimingFieldsStillDecodes() throws {
        let dueAt = Date(timeIntervalSince1970: 20_000)
        let progress = StepProgress(
            step: RoutineStep(title: "旧任务", duration: 5 * 60),
            dueAt: dueAt
        )
        let data = try JSONEncoder().encode(progress)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "plannedDueAt")
        object.removeValue(forKey: "remainingDuration")
        object.removeValue(forKey: "startedAt")
        let oldData = try JSONSerialization.data(withJSONObject: object)
        let decoded = try JSONDecoder().decode(StepProgress.self, from: oldData)

        XCTAssertEqual(decoded.originalDueAt, dueAt)
        XCTAssertEqual(decoded.remainingWork, 5 * 60)
        XCTAssertEqual(decoded.state, .pending)
    }

    // MARK: - 规则覆盖度

    func testRuleOutcomeIsCompleteWhenEveryDurationIsConsumed() {
        let outcome = QuickRoutineParser.analyze(from: "博兴任务20分钟  去厕所5分钟")

        XCTAssertEqual(outcome.steps.map(\.title), ["博兴任务", "去厕所"])
        XCTAssertTrue(outcome.leftover.isEmpty)
        XCTAssertTrue(outcome.isComplete)
    }

    func testRuleOutcomeReportsLeftoverWhenSomethingIsNotUnderstood() {
        let outcome = QuickRoutineParser.analyze(from: "去厕所5分钟 别忘了倒垃圾")

        XCTAssertEqual(outcome.steps.map(\.title), ["去厕所"])
        XCTAssertEqual(outcome.leftover, "别忘了倒垃圾")
        XCTAssertFalse(outcome.isComplete)
    }

    func testDeadlineExpressionIsNotCountedAsLeftover() {
        let outcome = QuickRoutineParser.analyze(from: "去厕所5分钟 截止时间18点10分")

        XCTAssertEqual(outcome.steps.map(\.title), ["去厕所"])
        XCTAssertTrue(outcome.leftover.isEmpty)
        XCTAssertNotNil(outcome.deadline)
    }

    func testTimeAnchorWordsAreNotCountedAsLeftover() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 6, minute: 0))
        )
        let outcome = QuickRoutineParser.analyze(from: "去厕所5分钟 8点出门", relativeTo: now, calendar: calendar)

        XCTAssertEqual(outcome.steps.map(\.title), ["去厕所"])
        XCTAssertTrue(outcome.leftover.isEmpty)
        // 时间在前的写法（锚点词在时刻之后）也要读得出；分钟缺省按 0 分。
        let deadline = try XCTUnwrap(outcome.deadline, "「8点出门」这类时间在前的写法本机也必须能读出")
        XCTAssertEqual(calendar.component(.hour, from: deadline), 8)
        XCTAssertEqual(calendar.component(.minute, from: deadline), 0)
    }

    /// 规范示例端到端回归：规则一条龙读全——3 个任务 + 时间在前的截止时间。
    /// 它同时覆盖了「规则误判读全（leftover 为空）而 deadline 被静默吞掉」这个真 bug：
    /// 修好前 `leftover.isEmpty` 会因锚点清理逻辑误判为完整，却拿不到 18:30。
    func testRuleReadsTrailingDeadlineFromCanonicalExample() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 12, minute: 0))
        )
        let outcome = QuickRoutineParser.analyze(
            from: "18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟",
            relativeTo: now,
            calendar: calendar
        )

        XCTAssertEqual(outcome.steps.map(\.title), ["去厕所", "刷杯子", "买水果"])
        XCTAssertTrue(outcome.isComplete, "截止时间表达不该被当成没读懂的内容")
        let deadline = try XCTUnwrap(outcome.deadline, "「18点30结束」这类时间在前的写法本机也必须能读出")
        XCTAssertEqual(calendar.component(.hour, from: deadline), 18)
        XCTAssertEqual(calendar.component(.minute, from: deadline), 30)
    }

    /// 规范示例走完整管线（无大模型）时必须直接拿到截止时间，不依赖增强路径兜底。
    func testPipelineResolvesCanonicalDeadlineWithoutEnhancedPath() async throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 12, minute: 0))
        )
        let result = await RoutineParsingPipeline().parse(
            "18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟",
            now: now
        )

        let deadline = try XCTUnwrap(result?.deadline, "纯规则模式下也要能读出时间在前的截止时间")
        XCTAssertEqual(calendar.component(.hour, from: deadline), 18)
        XCTAssertEqual(calendar.component(.minute, from: deadline), 30)
        XCTAssertEqual(result?.steps.count, 3, "截止时间表达不能吃掉任务，也不能多出一个任务")
    }

    // MARK: - Deadline 时刻表达的语序与「半」

    /// 复用同一份解析，断言「输入 → 期望 h:mm」，失败时打印实际值，便于定位。
    private func assertDeadline(
        _ input: String,
        equals expected: String?,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 12, minute: 0)),
            file: file,
            line: line
        )
        let deadline = QuickRoutineParser.inferredDeadline(from: input, relativeTo: now, calendar: calendar)

        guard let expected else {
            XCTAssertNil(deadline, "「\(input)」不应被识别为截止时间，实际 \(String(describing: deadline))", file: file, line: line)
            return
        }
        let resolved = try XCTUnwrap(deadline, "「\(input)」应当被识别为截止时间", file: file, line: line)
        let actual = String(format: "%d:%02d", calendar.component(.hour, from: resolved), calendar.component(.minute, from: resolved))
        XCTAssertEqual(actual, expected, "「\(input)」解析结果不符", file: file, line: line)
    }

    /// 「半」必须算成 30 分。此前分钟捕获组只吃数字，「10点半」被截成 10:00（静默给错值），
    /// 「8点半出门 / 18点半结束」则整体匹配失败返回 nil。四种语序都要覆盖。
    func testInferredDeadlineUnderstandsHalfHour() throws {
        try assertDeadline("出门10点半", equals: "10:30")
        try assertDeadline("结束8点半", equals: "8:30")
        try assertDeadline("8点半出门", equals: "8:30")
        try assertDeadline("18点半结束", equals: "18:30")
    }

    /// 回归：锚点在前 / 时间在前两种语序的常规写法都不能被改坏。
    func testInferredDeadlineRegressionCoversBothWordOrders() throws {
        // 锚点在前
        try assertDeadline("结束18:10", equals: "18:10")
        try assertDeadline("结束 18:10", equals: "18:10")
        try assertDeadline("截止8:35", equals: "8:35")
        try assertDeadline("结束18点10分", equals: "18:10")
        try assertDeadline("出门10点", equals: "10:00")
        try assertDeadline("去厕所5分钟 结束8:35", equals: "8:35")
        // 时间在前
        try assertDeadline("18点30结束，去厕所5分钟", equals: "18:30")
        try assertDeadline("8点出门", equals: "8:00")
        try assertDeadline("18:30结束", equals: "18:30")
        try assertDeadline("18点30分结束", equals: "18:30")
        try assertDeadline("18点结束", equals: "18:00")
    }

    /// 边界：普通任务时长不能被误当作截止时间（否则会凭空多出一个倒推节点）。
    func testInferredDeadlineIgnoresPlainTaskDurations() throws {
        try assertDeadline("买水果10分钟", equals: nil)
        try assertDeadline("去厕所5分钟 刷杯子2分钟", equals: nil)
        try assertDeadline("7点起床，洗脸5分钟", equals: nil)
    }

    func testPipelineSkipsEnhancedServiceWhenRuleIsComplete() async {
        let recorder = RecordingParsingService()
        var pipeline = RoutineParsingPipeline()
        pipeline.enhanced = recorder

        let result = await pipeline.parse("去厕所5分钟")

        XCTAssertEqual(result?.source, RoutineParseSource.rule)
        XCTAssertEqual(recorder.callCount, 0, "规则已完整命中时不应该产生任何模型调用")
    }

    func testPipelineFallsBackToRuleWhenEnhancedThrows() async {
        var pipeline = RoutineParsingPipeline()
        pipeline.enhanced = StubParsingService(result: nil, shouldThrow: true)

        let result = await pipeline.parse("去厕所5分钟 别忘了倒垃圾")

        XCTAssertEqual(result?.source, RoutineParseSource.rule)
        XCTAssertEqual(result?.steps.map(\.title), ["去厕所"])
    }

    func testPipelineAdoptsEnhancedResultWhenItFindsMoreSteps() async {
        let better = RoutineParseResult(
            steps: [
                RoutineStep(title: "去厕所", duration: 5 * 60),
                RoutineStep(title: "倒垃圾", duration: 2 * 60)
            ],
            deadline: nil,
            source: .enhanced,
            leftover: ""
        )
        var pipeline = RoutineParsingPipeline()
        pipeline.enhanced = StubParsingService(result: better)

        let result = await pipeline.parse("去厕所5分钟 别忘了倒垃圾")

        XCTAssertEqual(result?.source, RoutineParseSource.enhanced)
        XCTAssertEqual(result?.steps.map(\.title), ["去厕所", "倒垃圾"])
    }

    func testPipelineKeepsRuleResultWhenEnhancedFindsNoMoreSteps() async {
        let noBetter = RoutineParseResult(
            steps: [RoutineStep(title: "别的", duration: 60)],
            deadline: nil,
            source: .enhanced,
            leftover: ""
        )
        var pipeline = RoutineParsingPipeline()
        pipeline.enhanced = StubParsingService(result: noBetter)

        let result = await pipeline.parse("去厕所5分钟 别忘了倒垃圾")

        XCTAssertEqual(result?.source, RoutineParseSource.rule)
        XCTAssertEqual(result?.steps.map(\.title), ["去厕所"])
    }

    /// 任务数持平、但模型读出了规则读不出的截止时间时，要吸收该 deadline 并保留规则步骤。
    /// 覆盖「18点30结束」这类时间在前的写法：规则锚点词正则要求锚点在前，读不出，只有模型能。
    func testPipelineAbsorbsEnhancedDeadlineWhenStepCountTies() async throws {
        let calendar = Calendar(identifier: .gregorian)
        let deadline = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 18, minute: 30))
        )
        let withDeadline = RoutineParseResult(
            steps: [RoutineStep(title: "去厕所", duration: 5 * 60)],
            deadline: deadline,
            source: .enhanced,
            leftover: ""
        )
        var pipeline = RoutineParsingPipeline()
        pipeline.enhanced = StubParsingService(result: withDeadline)

        let result = await pipeline.parse("去厕所5分钟 别忘了倒垃圾")

        XCTAssertEqual(result?.source, RoutineParseSource.enhanced)
        XCTAssertEqual(result?.steps.map(\.title), ["去厕所"], "任务数持平时仍应保留规则那份更确定的步骤")
        XCTAssertEqual(result?.deadline, deadline, "规则读不出的截止时间必须由模型补上")
    }

    func testRemotePayloadDecodesPlainJSON() throws {
        let payload = try XCTUnwrap(
            RemoteRoutineParsingService.decodePayload(
                from: #"{"steps":[{"title":"去厕所","durationMinutes":5}],"deadlineHour":8,"deadlineMinute":35}"#
            )
        )

        XCTAssertEqual(payload.steps.map(\.title), ["去厕所"])
        XCTAssertEqual(payload.steps.first?.minutes, 5)
        XCTAssertEqual(payload.deadlineHour, 8)
        XCTAssertEqual(payload.deadlineMinute, 35)
    }

    func testRemotePayloadSurvivesMarkdownFenceAndExtraPreamble() throws {
        let content = """
        好的，这是解析结果：
        ```json
        {"steps":[{"title":"刷牙","durationMinutes":3}],"deadlineHour":null,"deadlineMinute":null}
        ```
        需要我调整吗？
        """

        let payload = try XCTUnwrap(RemoteRoutineParsingService.decodePayload(from: content))

        XCTAssertEqual(payload.steps.map(\.title), ["刷牙"])
        XCTAssertNil(payload.deadlineHour)
    }

    func testRemotePayloadAcceptsDurationAsString() throws {
        let payload = try XCTUnwrap(
            RemoteRoutineParsingService.decodePayload(
                from: #"{"steps":[{"title":"洗脸","durationMinutes":"5"}]}"#
            )
        )

        XCTAssertEqual(payload.steps.first?.minutes, 5)
    }

    /// 实测返回：提示词里的结构示例不够醒目时，网关会自创一套字段名。
    /// 这条是回归测试——严格解码在这种情况下会整条失败，让增强路径静默失效。
    func testRemotePayloadAcceptsInventedFieldNamesFromRealResponse() throws {
        let content = #"""
        {"tasks":[{"name":"去厕所","duration_minutes":5},{"name":"刷杯子","duration_minutes":2},{"name":"出门","time":"08:30"}]}
        """#

        let payload = try XCTUnwrap(RemoteRoutineParsingService.decodePayload(from: content))

        XCTAssertEqual(payload.steps.map(\.title), ["去厕所", "刷杯子"])
        XCTAssertEqual(payload.steps.map(\.minutes), [5, 2])
        XCTAssertEqual(payload.deadlineHour, 8)
        XCTAssertEqual(payload.deadlineMinute, 30)
        XCTAssertEqual(
            payload.steps.count, 2,
            "只给时刻不给时长的末项是截止节点（「八点半出门」），不该变成一项 5 分钟的任务"
        )
    }

    func testRemotePayloadAcceptsBareArrayRoot() throws {
        let payload = try XCTUnwrap(
            RemoteRoutineParsingService.decodePayload(
                from: #"[{"title":"刷牙","durationMinutes":3}]"#
            )
        )

        XCTAssertEqual(payload.steps.map(\.title), ["刷牙"])
    }

    func testRemotePayloadTreatsTrailingClockOnlyItemAsDeadline() throws {
        let content = #"{"steps":[{"title":"洗脸","durationMinutes":5},{"title":"出门","time":"8点半"}]}"#

        let payload = try XCTUnwrap(RemoteRoutineParsingService.decodePayload(from: content))

        XCTAssertEqual(payload.steps.map(\.title), ["洗脸"])
        XCTAssertEqual(payload.deadlineHour, 8)
        XCTAssertEqual(payload.deadlineMinute, 30, "「半」应当补成 30 分")
    }

    func testRemoteDeadlineAcceptsMergedClockFieldOnRoot() throws {
        let content = #"{"steps":[{"title":"洗脸","durationMinutes":5}],"deadline":"08:30"}"#

        let payload = try XCTUnwrap(RemoteRoutineParsingService.decodePayload(from: content))

        XCTAssertEqual(payload.deadlineHour, 8)
        XCTAssertEqual(payload.deadlineMinute, 30, "顶层把时刻合成一个字段时也要认出来")
    }

    func testRemotePayloadWithoutAnyTaskFallsBackToRules() {
        XCTAssertNil(
            RemoteRoutineParsingService.decodePayload(from: #"{"steps":[{"title":"出门","time":"8点半"}]}"#),
            "只有截止时刻、没有任何任务时应当回退规则，而不是产出一个空模板"
        )
    }

    func testRemotePayloadKeepsMidListTaskThatCarriesAClock() throws {
        let content = #"{"steps":[{"title":"7点起床","time":"7:00"},{"title":"洗脸","durationMinutes":5}]}"#

        let payload = try XCTUnwrap(RemoteRoutineParsingService.decodePayload(from: content))

        XCTAssertEqual(
            payload.steps.map(\.title), ["7点起床", "洗脸"],
            "夹在中间的时刻只是描述，对应的任务不该被当成截止节点丢掉"
        )
    }

    func testRemotePayloadKeepsTaskWithoutDurationUsingFallback() throws {
        let payload = try XCTUnwrap(
            RemoteRoutineParsingService.decodePayload(
                from: #"{"steps":[{"title":"倒垃圾"},{"title":"洗脸","durationMinutes":5}]}"#
            )
        )

        XCTAssertEqual(payload.steps.map(\.title), ["倒垃圾", "洗脸"])
        XCTAssertEqual(payload.steps.first?.minutes, RemoteRoutineParsingService.fallbackMinutes)
    }

    func testRemotePayloadRejectsEmptyStepList() {
        XCTAssertNil(
            RemoteRoutineParsingService.decodePayload(from: #"{"steps":[]}"#),
            "一段任务都没解析出来时应当回退规则，而不是返回空模板"
        )
    }

    func testRemotePayloadRejectsGarbage() {
        XCTAssertNil(RemoteRoutineParsingService.decodePayload(from: "我不知道该怎么拆"))
        XCTAssertNil(RemoteRoutineParsingService.decodePayload(from: ""))
    }

    func testDurationStringUnitsAreHonoured() {
        XCTAssertEqual(RemoteRoutineParsingService.minutes(from: "5分钟"), 5)
        XCTAssertEqual(RemoteRoutineParsingService.minutes(from: "2小时"), 120)
        XCTAssertEqual(RemoteRoutineParsingService.minutes(from: "90秒"), 1.5)
        XCTAssertEqual(RemoteRoutineParsingService.minutes(from: "30min"), 30)
        XCTAssertNil(RemoteRoutineParsingService.minutes(from: "没写"))
    }

    func testRemoteDeadlineIgnoresOutOfRangeValues() {
        let now = Date()

        XCTAssertNil(RemoteRoutineParsingService.makeDeadline(hour: 25, minute: 0, on: now))
        XCTAssertNil(RemoteRoutineParsingService.makeDeadline(hour: 8, minute: 70, on: now))
        XCTAssertNil(RemoteRoutineParsingService.makeDeadline(hour: nil, minute: 30, on: now))
        XCTAssertNotNil(RemoteRoutineParsingService.makeDeadline(hour: 8, minute: nil, on: now))
    }

    // MARK: - 网关地址与降级重试

    func testChatCompletionsURLNormalizesBaseURL() {
        let normalize = RemoteRoutineParsingService.Configuration.chatCompletionsURL(from:)

        XCTAssertEqual(
            normalize("https://gpt.cosmoplat.com/v1").absoluteString,
            "https://gpt.cosmoplat.com/v1/chat/completions"
        )
        XCTAssertEqual(
            normalize("https://gpt.cosmoplat.com/v1/").absoluteString,
            "https://gpt.cosmoplat.com/v1/chat/completions",
            "base URL 末尾多一个斜杠不应该拼出双斜杠"
        )
        XCTAssertEqual(
            normalize("https://gpt.cosmoplat.com/v1/chat/completions").absoluteString,
            "https://gpt.cosmoplat.com/v1/chat/completions",
            "已经是完整路径时不应该重复拼接"
        )
    }

    func testCosmoMindConfigurationTargetsInternalGateway() {
        let configuration = RemoteRoutineParsingService.Configuration.cosmoMind(apiKey: "sk-test")

        XCTAssertEqual(
            configuration.endpoint.absoluteString,
            "https://gpt.cosmoplat.com/v1/chat/completions"
        )
        XCTAssertEqual(configuration.model, "cosmo-mind-coder")
        XCTAssertTrue(configuration.usesJSONMode)
        XCTAssertTrue(configuration.retriesWithoutOptionalFields)
        XCTAssertEqual(
            configuration.thinkingDisable, .none,
            "网关已实测忽略 enable_thinking，默认不带任何可能被拒的字段"
        )
    }

    func testThinkingDisableStylesProduceDistinctFields() {
        let styles = RemoteRoutineParsingService.ThinkingDisableStyle.allCases

        XCTAssertTrue(styles.contains(.enableThinking))
        XCTAssertTrue(styles.contains(.chatTemplateKwargs))
        XCTAssertTrue(styles.contains(.thinkingTypeDisabled))
        XCTAssertTrue(
            RemoteRoutineParsingService.ThinkingDisableStyle.none.bodyEntries.isEmpty,
            ".none 必须写不出任何字段，否则降级链的第一档就等于没降"
        )
    }

    func testOnlyRequestShapeErrorsTriggerDegradedRetry() {
        XCTAssertTrue(RemoteRoutineParsingService.isRejectedRequest(400))
        XCTAssertTrue(RemoteRoutineParsingService.isRejectedRequest(422))

        XCTAssertFalse(
            RemoteRoutineParsingService.isRejectedRequest(401),
            "鉴权失败时去掉附加字段重试也没有意义，应直接回退规则"
        )
        XCTAssertFalse(RemoteRoutineParsingService.isRejectedRequest(429))
        XCTAssertFalse(RemoteRoutineParsingService.isRejectedRequest(500))
    }

    func testBodyVariantsShrinkFromFullestToSimplest() {
        let configuration = RemoteRoutineParsingService.Configuration(
            endpoint: URL(string: "https://example.com/v1/chat/completions")!,
            apiKey: nil,
            model: "test",
            usesJSONMode: true,
            thinkingDisable: .chatTemplateKwargs
        )

        XCTAssertEqual(
            configuration.bodyVariants,
            [
                .init(usesJSONMode: true, thinkingDisable: .chatTemplateKwargs),
                .init(usesJSONMode: true, thinkingDisable: .none),
                .init(usesJSONMode: false, thinkingDisable: .chatTemplateKwargs),
                .init(usesJSONMode: false, thinkingDisable: .none)
            ],
            "最简变体必须排在最后，保证一定能落到「只有提示词约束」这一档"
        )
    }

    func testBodyVariantsSkipThinkingWhenNotEnabled() {
        let configuration = RemoteRoutineParsingService.Configuration(
            endpoint: URL(string: "https://example.com/v1/chat/completions")!,
            apiKey: nil,
            model: "test",
            usesJSONMode: true,
            thinkingDisable: .none
        )

        XCTAssertEqual(
            configuration.bodyVariants,
            [
                .init(usesJSONMode: true, thinkingDisable: .none),
                .init(usesJSONMode: false, thinkingDisable: .none)
            ]
        )
    }

    func testBodyVariantsAlwaysIncludeMinimalFallback() {
        let neither = RemoteRoutineParsingService.Configuration(
            endpoint: URL(string: "https://example.com/v1/chat/completions")!,
            apiKey: nil,
            model: "test",
            usesJSONMode: false,
            thinkingDisable: .none
        )

        XCTAssertEqual(neither.bodyVariants, [.init(usesJSONMode: false, thinkingDisable: .none)],
                       "两个开关都关时只有一个变体，不应产生重复请求")
    }
}

private final class RecordingParsingService: RoutineParsingService {
    let source: RoutineParseSource = .enhanced
    private(set) var callCount = 0
    var result: RoutineParseResult?

    func parse(_ input: String, now: Date) async throws -> RoutineParseResult? {
        callCount += 1
        return result
    }
}

private struct StubParsingService: RoutineParsingService {
    let source: RoutineParseSource = .enhanced
    var result: RoutineParseResult?
    var shouldThrow = false

    enum StubError: Error { case unavailable }

    func parse(_ input: String, now: Date) async throws -> RoutineParseResult? {
        if shouldThrow { throw StubError.unavailable }
        return result
    }
}
