//
// main.swift — 跨端交叉验证 Swift harness
//
// 目的：用 **真实 Swift 运行时** 产出字节，供 TS 实现交叉比对。
//
// 关键约束：本文件与 `Shared/Models/RoutineModels.swift` {@b 原文件一起编译}，
// 不复制粘贴任何模型代码（复制会引入偏差、失去验证意义）。编译命令见 README.md。
//
// 用法：
//   harness emit      # 用默认 JSONEncoder 编码固定快照 → 打印 JSON 到 stdout
//   harness truth     # 打印同一快照的「绝对时刻(unix ms) + 标量」真值表（JSON）到 stdout
//   harness nilcheck  # 构造含 nil optional 的实例 → 打印原始 JSON 字节（判定省略键 vs null）
//   harness decode    # 从 stdin 读 JSON，JSONDecoder 解码 RoutineSnapshot 后再编码 → 打印 JSON
//
import Foundation

// ---------------------------------------------------------------------------
// 固定 UUID（确定性，便于跨端逐字段比对）
// ---------------------------------------------------------------------------
func uuid(_ s: String) -> UUID { UUID(uuidString: s)! }

let snapshotOriginID = uuid("AAAAAAAA-BBBB-CCCC-DDDD-000000000001")
let morningTemplateID = uuid("5E43ED14-458A-49CF-8673-A96DCA196001")
let homeworkTemplateID = uuid("5E43ED14-458A-49CF-8673-A96DCA196002")
let legacyTemplateID = uuid("AAAAAAAA-BBBB-CCCC-DDDD-0000000000AA")

// 固定绝对时刻基准（与机器时区无关：用 Unix 秒构造）。
let baseUnix: TimeInterval = 1_700_000_000 // 2023-11-14T22:13:20Z
func at(_ offset: TimeInterval) -> Date { Date(timeIntervalSince1970: baseUnix + offset) }

// 步骤固定 UUID
let stepTask1 = uuid("10000000-0000-0000-0000-000000000001")
let stepTask2 = uuid("10000000-0000-0000-0000-000000000002")
let stepTask3 = uuid("10000000-0000-0000-0000-000000000003")
let stepDeadline = uuid("10000000-0000-0000-0000-000000000004")
let stepLegacy = uuid("10000000-0000-0000-0000-000000000005")

// 进度固定 UUID
let progressActive = uuid("20000000-0000-0000-0000-000000000001")
let progressPending = uuid("20000000-0000-0000-0000-000000000002")
let progressSuspended = uuid("20000000-0000-0000-0000-000000000003")
let progressCompleted = uuid("20000000-0000-0000-0000-000000000004")
let progressDeadline = uuid("20000000-0000-0000-0000-000000000005")

let sessionID = uuid("30000000-0000-0000-0000-000000000001")

// ---------------------------------------------------------------------------
// 固定 RoutineSnapshot
// ---------------------------------------------------------------------------

func makeStepsMorning() -> [RoutineStep] {
    [
        RoutineStep(id: stepTask1, title: "刷牙", prompt: "先刷牙，不开新任务", duration: 180, importance: .normal, role: .task),
        RoutineStep(id: stepTask2, title: "洗脸", prompt: "现在只做：洗脸", duration: 300, importance: .normal, role: .task),
        RoutineStep(id: stepTask3, title: "下楼", prompt: "现在下楼", duration: 300, importance: .hardDeadline, role: .task),
        RoutineStep(id: stepDeadline, title: "出门", prompt: "不预测路况，现在出门", duration: 0, importance: .hardDeadline, role: .deadline),
    ]
}

func makeSnapshot() -> RoutineSnapshot {
    // 模板 1：backward + daily + 有 deadline（全字段非空）
    let t1 = RoutineTemplate(
        id: morningTemplateID,
        name: "上班早晨",
        symbol: "sun.max.fill",
        mode: .backward,
        deadlineHour: 8,
        deadlineMinute: 35,
        buffer: 600,
        recurrence: .daily,
        steps: makeStepsMorning()
    )

    // 模板 2：forward + once + deadlineHour/Minute 均为 nil（测试 optional nil 编码）
    let t2 = RoutineTemplate(
        id: homeworkTemplateID,
        name: "写作业",
        symbol: "book.closed.fill",
        mode: .forward,
        deadlineHour: nil,
        deadlineMinute: nil,
        buffer: 0,
        recurrence: .once,
        steps: [
            RoutineStep(id: stepLegacy, title: "语文", prompt: "先做语文，只要开始", duration: 7200, importance: .normal, role: .task),
        ]
    )

    // 模板 3：recurrence 显式置 nil（测试旧数据缺 recurrence 键的编码行为）
    var t3 = RoutineTemplate(
        id: legacyTemplateID,
        name: "旧模板",
        symbol: "list.bullet.clipboard.fill",
        mode: .forward,
        deadlineHour: nil,
        deadlineMinute: nil,
        buffer: 0,
        recurrence: .once,
        steps: [
            RoutineStep(id: stepLegacy, title: "旧任务", prompt: "现在只做：旧任务", duration: 300, importance: .normal, role: .task),
        ]
    )
    t3.recurrence = nil

    // 活跃会话：包含 active / pending / suspended / completed / deadline 五种进度
    let pActive = StepProgress(
        id: progressActive,
        step: RoutineStep(id: stepTask2, title: "洗脸", prompt: "现在只做：洗脸", duration: 300, importance: .normal, role: .task),
        dueAt: at(600),
        state: .active,
        snoozeCount: 0,
        completedAt: nil,
        isTemporary: false,
        plannedDueAt: at(600),
        remainingDuration: 300,
        startedAt: at(100)
    )
    let pPending = StepProgress(
        id: progressPending,
        step: RoutineStep(id: stepTask1, title: "刷牙", prompt: "先刷牙，不开新任务", duration: 180, importance: .normal, role: .task),
        dueAt: at(300),
        state: .pending,
        snoozeCount: 2,
        completedAt: nil,
        isTemporary: false,
        plannedDueAt: at(300),
        remainingDuration: 180,
        startedAt: nil
    )
    let pSuspended = StepProgress(
        id: progressSuspended,
        step: RoutineStep(id: stepTask3, title: "下楼", prompt: "现在下楼", duration: 300, importance: .hardDeadline, role: .task),
        dueAt: at(900),
        state: .suspended,
        snoozeCount: 1,
        completedAt: nil,
        isTemporary: false,
        plannedDueAt: at(900),
        remainingDuration: 120,
        startedAt: nil
    )
    let pCompleted = StepProgress(
        id: progressCompleted,
        step: RoutineStep(id: stepTask1, title: "已完成项", prompt: "现在只做：已完成项", duration: 60, importance: .normal, role: .task),
        dueAt: at(200),
        state: .completed,
        snoozeCount: 0,
        completedAt: at(210),
        isTemporary: false,
        plannedDueAt: at(200),
        remainingDuration: 0,
        startedAt: at(150)
    )
    let pDeadline = StepProgress(
        id: progressDeadline,
        step: RoutineStep(id: stepDeadline, title: "出门", prompt: "不预测路况，现在出门", duration: 0, importance: .hardDeadline, role: .deadline),
        dueAt: at(1000),
        state: .pending,
        snoozeCount: 0,
        completedAt: nil,
        isTemporary: false,
        plannedDueAt: at(1000),
        remainingDuration: nil,
        startedAt: nil
    )

    let session = RoutineSession(
        id: sessionID,
        templateID: morningTemplateID,
        templateName: "上班早晨",
        templateSymbol: "sun.max.fill",
        startedAt: at(0),
        plannedStartAt: at(-600),
        targetDeadline: at(1200),
        state: .running,
        primaryDevice: .phone,
        progress: [pActive, pPending, pSuspended, pCompleted, pDeadline],
        remainingBuffer: 600,
        updatedAt: at(0),
        revision: 3,
        activeProgressID: progressActive,
        suspendedProgressIDs: [progressSuspended]
    )

    return RoutineSnapshot(
        templates: [t1, t2, t3],
        activeSession: session,
        updatedAt: at(-10),
        originID: snapshotOriginID
    )
}

func encodeJSON(_ snapshot: RoutineSnapshot) -> String {
    let encoder = JSONEncoder() // 默认配置：Date = Apple 参考秒
    let data = try! encoder.encode(snapshot)
    return String(data: data, encoding: .utf8)!
}

// ---------------------------------------------------------------------------
// 真值表：把 Swift 侧的绝对时刻(unix ms)与标量，导出成 JSON 供 Node 比对
// ---------------------------------------------------------------------------

func ms(_ date: Date) -> Double { date.timeIntervalSince1970 * 1000 }

func truthOfSnapshot(_ snapshot: RoutineSnapshot) -> [String: Any] {
    var root: [String: Any] = [
        "updatedAt": ms(snapshot.updatedAt),
        "originID": snapshot.originID.uuidString,
    ]

    root["templates"] = snapshot.templates.map { (t: RoutineTemplate) -> [String: Any] in
        var dict: [String: Any] = [
            "id": t.id.uuidString,
            "name": t.name,
            "symbol": t.symbol,
            "mode": t.mode.rawValue,
            "buffer": t.buffer,
        ]
        dict["deadlineHour"] = t.deadlineHour.map { $0 as Any } ?? NSNull()
        dict["deadlineMinute"] = t.deadlineMinute.map { $0 as Any } ?? NSNull()
        dict["recurrence"] = t.recurrence.map { $0.rawValue as Any } ?? NSNull()
        dict["steps"] = t.steps.map { (s: RoutineStep) -> [String: Any] in
            [
                "id": s.id.uuidString,
                "title": s.title,
                "prompt": s.prompt,
                "duration": s.duration,
                "importance": s.importance.rawValue,
                "role": s.role.rawValue,
            ]
        }
        return dict
    }

    if let s = snapshot.activeSession {
        var sd: [String: Any] = [
            "id": s.id.uuidString,
            "templateID": s.templateID.uuidString,
            "templateName": s.templateName,
            "templateSymbol": s.templateSymbol,
            "startedAt": ms(s.startedAt),
            "plannedStartAt": ms(s.plannedStartAt),
            "targetDeadline": s.targetDeadline.map { ms($0) as Any } ?? NSNull(),
            "state": s.state.rawValue,
            "primaryDevice": s.primaryDevice.rawValue,
            "remainingBuffer": s.remainingBuffer,
            "updatedAt": ms(s.updatedAt),
            "revision": s.revision,
            "activeProgressID": s.activeProgressID.map { $0.uuidString as Any } ?? NSNull(),
            "suspendedProgressIDs": s.suspendedProgressIDs.map { $0.map { $0.uuidString as Any } } ?? NSNull(),
        ]
        sd["progress"] = s.progress.map { (p: StepProgress) -> [String: Any] in
            [
                "id": p.id.uuidString,
                "dueAt": ms(p.dueAt),
                "state": p.state.rawValue,
                "snoozeCount": p.snoozeCount,
                "completedAt": p.completedAt.map { ms($0) as Any } ?? NSNull(),
                "isTemporary": p.isTemporary,
                "plannedDueAt": p.plannedDueAt.map { ms($0) as Any } ?? NSNull(),
                "remainingDuration": p.remainingDuration.map { $0 as Any } ?? NSNull(),
                "startedAt": p.startedAt.map { ms($0) as Any } ?? NSNull(),
                "stepID": p.step.id.uuidString,
            ]
        }
        root["activeSession"] = sd
    } else {
        root["activeSession"] = NSNull()
    }
    return root
}

// ---------------------------------------------------------------------------
// nilcheck：含 nil optional 的实例，打印原始 JSON 字节
// ---------------------------------------------------------------------------

func makeNilOptionalSnapshot() -> RoutineSnapshot {
    // activeSession = nil；模板 deadlineHour/Minute nil、recurrence nil；
    let template = RoutineTemplate(
        id: homeworkTemplateID,
        name: "全 nil",
        symbol: "x",
        mode: .forward,
        deadlineHour: nil,
        deadlineMinute: nil,
        buffer: 0,
        recurrence: .once,
        steps: [
            RoutineStep(id: stepTask1, title: "任务", prompt: "现在只做：任务", duration: 60, importance: .normal, role: .task),
        ]
    )
    var t = template
    t.recurrence = nil

    // 另建一个 session 测 session 内部 optional nil（单独打印）
    return RoutineSnapshot(
        templates: [t],
        activeSession: nil,
        updatedAt: Date(timeIntervalSince1970: baseUnix),
        originID: snapshotOriginID
    )
}

func makeNilOptionalSessionSnapshot() -> RoutineSnapshot {
    // session 内：activeProgressID=nil、suspendedProgressIDs=nil、progress 各 optional 均 nil
    let p = StepProgress(
        id: progressPending,
        step: RoutineStep(id: stepTask1, title: "裸任务", prompt: "现在只做：裸任务", duration: 60, importance: .normal, role: .task),
        dueAt: Date(timeIntervalSince1970: baseUnix + 60),
        state: .pending,
        snoozeCount: 0,
        completedAt: nil,
        isTemporary: false,
        plannedDueAt: nil,
        remainingDuration: nil,
        startedAt: nil
    )
    let session = RoutineSession(
        id: sessionID,
        templateID: homeworkTemplateID,
        templateName: "裸会话",
        templateSymbol: "x",
        startedAt: Date(timeIntervalSince1970: baseUnix),
        plannedStartAt: Date(timeIntervalSince1970: baseUnix),
        targetDeadline: nil,
        state: .running,
        primaryDevice: .watch,
        progress: [p],
        remainingBuffer: 0,
        updatedAt: Date(timeIntervalSince1970: baseUnix),
        revision: 1,
        activeProgressID: nil,
        suspendedProgressIDs: nil
    )
    return RoutineSnapshot(
        templates: [],
        activeSession: session,
        updatedAt: Date(timeIntervalSince1970: baseUnix),
        originID: snapshotOriginID
    )
}

// ---------------------------------------------------------------------------
// session 计算属性真值（M17/M18/M19 锚点，测试 8）
// ---------------------------------------------------------------------------

func sessionTruth() -> [String: Any] {
    let now = Date(timeIntervalSince1970: 10_000)
    let target = now.addingTimeInterval(-600)

    let firstID = uuid("40000000-0000-0000-0000-000000000001")
    let secondID = uuid("40000000-0000-0000-0000-000000000002")
    let deadlineID = uuid("40000000-0000-0000-0000-000000000003")

    let first = StepProgress(
        id: firstID,
        step: RoutineStep(title: "first", duration: 300),
        dueAt: target,
        state: .pending,
        plannedDueAt: target,
        remainingDuration: 300
    )
    let second = StepProgress(
        id: secondID,
        step: RoutineStep(title: "second", duration: 300),
        dueAt: target.addingTimeInterval(300),
        state: .pending,
        plannedDueAt: target.addingTimeInterval(300),
        remainingDuration: 300
    )
    let deadline = StepProgress(
        id: deadlineID,
        step: RoutineStep(title: "完成", duration: 0, importance: .hardDeadline, role: .deadline),
        dueAt: target.addingTimeInterval(300),
        state: .pending,
        plannedDueAt: target.addingTimeInterval(300)
    )

    let session = RoutineSession(
        id: sessionID,
        templateID: morningTemplateID,
        templateName: "锚点",
        templateSymbol: "x",
        startedAt: target,
        plannedStartAt: target,
        targetDeadline: target,
        state: .running,
        primaryDevice: .phone,
        progress: [first, second, deadline],
        remainingBuffer: 0,
        updatedAt: target,
        revision: 1,
        activeProgressID: nil,
        suspendedProgressIDs: nil
    )

    let estimates = session.estimatedDueDates(at: now)
    return [
        "now": ms(now),
        "targetDeadline": ms(target),
        "estimateFirst": estimates[firstID].map { ms($0) as Any } ?? NSNull(),
        "estimateSecond": estimates[secondID].map { ms($0) as Any } ?? NSNull(),
        "estimateDeadline": estimates[deadlineID].map { ms($0) as Any } ?? NSNull(),
        "estimatedCompletion": session.estimatedCompletion(at: now).map { ms($0) as Any } ?? NSNull(),
        "isLate": session.isLate(at: now),
        "originalDueAtFirst": ms(first.originalDueAt),
        "remainingWorkFirst": first.remainingWork,
        "expectedDeadline": session.expectedDeadline.map { ms($0) as Any } ?? NSNull(),
        "timeZone": TimeZone.current.identifier,
    ]
}

// ---------------------------------------------------------------------------
// widget 延误真值（复现 web/tests/widget.test.ts 场景；公式同 RoutineStore.makeWidgetSnapshot）
// ---------------------------------------------------------------------------

func widgetTruth() -> [String: Any] {
    let now = Date(timeIntervalSince1970: 10) // 10 秒（对应 TS new Date(10000) 毫秒）
    let target = now.addingTimeInterval(-600)
    let first = StepProgress(
        id: uuid("40000000-0000-0000-0000-000000000011"),
        step: RoutineStep(title: "当前任务", duration: 300),
        dueAt: target,
        state: .pending,
        plannedDueAt: target,
        remainingDuration: 300
    )
    let deadline = StepProgress(
        id: uuid("40000000-0000-0000-0000-000000000012"),
        step: RoutineStep(title: "完成", duration: 0, importance: .hardDeadline, role: .deadline),
        dueAt: target,
        plannedDueAt: target
    )
    let session = RoutineSession(
        id: sessionID,
        templateID: morningTemplateID,
        templateName: "测试",
        templateSymbol: "checkmark",
        startedAt: target,
        plannedStartAt: target,
        targetDeadline: target,
        state: .running,
        primaryDevice: .phone,
        progress: [first, deadline],
        remainingBuffer: 0,
        updatedAt: target,
        revision: 1,
        activeProgressID: nil,
        suspendedProgressIDs: nil
    )
    let completion = session.estimatedCompletion(at: now)!
    let delay = max(0, completion.timeIntervalSince(target))
    return [
        "estimatedCompletion": ms(completion),
        "delayDuration": delay,
        "isLate": delay > 0,
    ]
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "emit"

switch mode {
case "emit":
    print(encodeJSON(makeSnapshot()))

case "truth":
    let obj = truthOfSnapshot(makeSnapshot())
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

case "nilcheck":
    print("=== nil optional (activeSession=nil, recurrence=nil, deadlineHour/Minute=nil) ===")
    print(encodeJSON(makeNilOptionalSnapshot()))
    print("=== nil optional inside session (activeProgressID=nil, suspendedProgressIDs=nil, progress.*=nil) ===")
    print(encodeJSON(makeNilOptionalSessionSnapshot()))

case "decode":
    let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)!
    let decoder = JSONDecoder()
    do {
        let decoded = try decoder.decode(RoutineSnapshot.self, from: Data(input.utf8))
        print("DECODE_OK")
        print(encodeJSON(decoded))
        let truth = truthOfSnapshot(decoded)
        let data = try! JSONSerialization.data(withJSONObject: truth, options: [.sortedKeys])
        print("=== TRUTH ===")
        print(String(data: data, encoding: .utf8)!)
    } catch {
        print("DECODE_FAIL: \(error)")
        exit(2)
    }

case "session":
    let obj = sessionTruth()
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

case "widget":
    let obj = widgetTruth()
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

case "constants":
    let obj: [String: Any] = [
        "distantPastMs": ms(Date.distantPast),
        "distantPastRefSeconds": Date.distantPast.timeIntervalSinceReferenceDate,
        "distantFutureMs": ms(Date.distantFuture),
    ]
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)

default:
    FileHandle.standardError.write(Data("unknown mode: \(mode)\n".utf8))
    exit(1)
}
