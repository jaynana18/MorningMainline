import Foundation
import SwiftUI

@MainActor
final class RoutineStore: ObservableObject {
    @Published private(set) var snapshot: RoutineSnapshot
    /// 跨设备共用的轻量设置（高德 Key、出行方式）。
    /// 手表靠它拿到 iPhone 上填的高德 Key —— App Group 跨不了设备，走 WCSession 同步。
    @Published private(set) var settings: MainlineSettings

    let deviceRole: DeviceRole
    /// 供 WebView 宿主（`iOS/WebHost.swift`）读取的稳定设备 id。
    /// **必须与私有 `deviceID` 同源**：JS 侧会把 `device.info` 的 id 当作自己的 `originID`，
    /// 一旦两边不一致，`apply(_:)` 的 `originID != deviceID` 过滤就会失效 → 同步自激。
    var deviceId: String { deviceID.uuidString }
    /// App Group 里的设置以本机 deviceID 为来源标记，用于丢弃自己发出的回声。
    var deviceUUID: UUID { deviceID }
    private let localKey = "morning-mainline.local-snapshot.v2"
    private let deviceID: UUID
    private let connectivity = ConnectivityService()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(deviceRole: DeviceRole) {
        self.deviceRole = deviceRole
        let deviceIDKey = "morning-mainline.device-id"
        if let value = UserDefaults.standard.string(forKey: deviceIDKey),
           let id = UUID(uuidString: value) {
            deviceID = id
        } else {
            let id = UUID()
            deviceID = id
            UserDefaults.standard.set(id.uuidString, forKey: deviceIDKey)
        }

        if let data = UserDefaults.standard.data(forKey: localKey),
           let saved = try? decoder.decode(RoutineSnapshot.self, from: data) {
            snapshot = saved
        } else {
            snapshot = .initial
        }

        // 先读本机 App Group 里的设置（App 与 Widget 共用同一份），再让 WCSession 覆盖。
        settings = SharedSettingsStore.current

        connectivity.onSnapshot = { [weak self] incoming in self?.apply(incoming) }
        connectivity.onSettings = { [weak self] incoming in self?.adoptSettings(incoming) }
        // 新安装或重新打开任一端时，也要把本机已有进度与设置补发给另一端。
        // 设置先打上本机来源标记，对方收到后据 `originID` 判断是不是自己的回声。
        var outgoing = settings
        outgoing.originID = deviceID
        connectivity.publish(snapshot)
        connectivity.publish(outgoing)

        Task { await ReminderScheduler.shared.requestAuthorization() }
    }

    var session: RoutineSession? { snapshot.activeSession }

    var currentProgress: StepProgress? {
        guard let session,
              session.state == .running,
              let activeProgressID = session.activeProgressID
        else { return nil }
        return session.progress.first {
            $0.id == activeProgressID && $0.state == .active
        }
    }

    var nextProgress: [StepProgress] {
        guard let session else { return [] }
        return session.progress.filter { $0.state.isIncomplete }
    }

    func template(with id: UUID) -> RoutineTemplate? {
        snapshot.templates.first(where: { $0.id == id })
    }

    // MARK: - 跨设备设置

    /// 写入高德 Key，落本机 App Group 并广播给对端（手表就是靠这一步拿到手机上的 Key）。
    func setAmapKey(_ value: String) {
        var next = SharedSettingsStore.updateAmapKey(value)
        next.originID = deviceID
        settings = next
        connectivity.publish(next)
    }

    /// 记住上次用的出行方式，让两端默认值一致。
    func setTravelMode(_ mode: TravelMode) {
        var next = SharedSettingsStore.updateTravelMode(mode)
        next.originID = deviceID
        settings = next
        connectivity.publish(next)
    }

    /// 开关 App 内语音播报。落本机 App Group 并广播，两端保持一致。
    func setSpeechEnabled(_ enabled: Bool) {
        var next = SharedSettingsStore.updateSpeechEnabled(enabled)
        next.originID = deviceID
        settings = next
        connectivity.publish(next)
    }

    /// 采纳对端同步来的设置。丢弃自己的回声，否则两端会互相覆盖。
    private func adoptSettings(_ incoming: MainlineSettings) {
        guard SharedSettingsStore.adopt(incoming, localDeviceID: deviceID) else { return }
        settings = SharedSettingsStore.current
    }

    func addTemplate(_ template: RoutineTemplate) {
        snapshot.templates.insert(template, at: 0)
        commit()
    }

    func start(
        _ template: RoutineTemplate,
        deadlineOverride: Date? = nil,
        bufferOverride: TimeInterval? = nil,
        now: Date = Date()
    ) {
        let deadline = template.mode == .backward
            ? (deadlineOverride ?? template.deadline(on: now))
            : nil
        let selectedBuffer = max(0, bufferOverride ?? template.buffer)
        let plannedStart = deadline.map {
            $0.addingTimeInterval(-template.totalTaskDuration - selectedBuffer)
        } ?? now
        var cursor = template.mode == .backward
            ? plannedStart
            : now
        let availableSlack = deadline.map { $0.timeIntervalSince(now) - template.totalTaskDuration }
        // 缓冲是计划的固定安全垫，不会被后续延误消耗。
        let remainingBuffer = selectedBuffer
        let deadlineOverrun = max(0, -(availableSlack ?? 0))
        var progress: [StepProgress] = []

        for step in template.steps {
            if step.role == .deadline, let deadline {
                progress.append(
                    StepProgress(
                        step: step,
                        dueAt: deadline.addingTimeInterval(deadlineOverrun),
                        plannedDueAt: deadline
                    )
                )
                continue
            }
            cursor = cursor.addingTimeInterval(step.duration)
            progress.append(
                StepProgress(
                    step: step,
                    dueAt: cursor,
                    plannedDueAt: cursor,
                    remainingDuration: step.duration
                )
            )
        }

        snapshot.activeSession = RoutineSession(
            id: UUID(),
            templateID: template.id,
            templateName: template.name,
            templateSymbol: template.symbol,
            startedAt: now,
            plannedStartAt: plannedStart,
            targetDeadline: deadline,
            state: .running,
            primaryDevice: deviceRole,
            progress: progress,
            remainingBuffer: remainingBuffer,
            updatedAt: now,
            revision: 1
        )
        commit()
    }

    /// 进入任务线不等于开始任务；只有点击某一项“开始”后，它才成为当前任务。
    func start(_ progress: StepProgress, now: Date = Date()) {
        guard var session = snapshot.activeSession,
              session.state == .running,
              progress.step.role == .task,
              progress.state.isIncomplete,
              session.progress.contains(where: { $0.id == progress.id })
        else { return }

        activate(progress.id, in: &session, at: now, suspendingCurrent: true)
        session.revision += 1
        session.updatedAt = now
        snapshot.activeSession = session
        commit()
    }

    func complete(_ progress: StepProgress) {
        guard var session = snapshot.activeSession,
              let index = session.progress.firstIndex(where: { $0.id == progress.id })
        else { return }

        let now = Date()
        let wasActive = session.activeProgressID == progress.id
        session.progress[index].state = .completed
        session.progress[index].completedAt = now
        session.progress[index].startedAt = nil
        session.progress[index].remainingDuration = 0
        if wasActive {
            session.activeProgressID = nil
        }

        let onlyDeadlineRemains = progress.step.role == .task
            && session.progress.allSatisfy {
                !$0.state.isIncomplete || $0.step.role == .deadline
            }
        if onlyDeadlineRemains {
            // 最后一项实际任务完成即代表整条任务线完成；末尾 Deadline 只保留为计划锚点，不再要求二次确认。
            for deadlineIndex in session.progress.indices
            where session.progress[deadlineIndex].step.role == .deadline
                && session.progress[deadlineIndex].state.isIncomplete {
                session.progress[deadlineIndex].state = .completed
                session.progress[deadlineIndex].completedAt = now
                session.progress[deadlineIndex].remainingDuration = 0
            }
            session.state = .completed
        } else {
            resumeMostRecentTaskIfNeeded(in: &session, at: now)
            startNextTaskIfNeeded(in: &session, at: now)
            recalculateExpectedSchedule(in: &session, now: now)
        }
        session.revision += 1
        session.updatedAt = now
        if session.progress.allSatisfy({ !$0.state.isIncomplete }) {
            session.state = .completed
        }
        snapshot.activeSession = session
        commit()
    }

    /// “两分钟后再提醒”不是单纯隐藏通知，而是把真实计划向后推。
    func snoozeCurrent(by seconds: TimeInterval = 2 * 60) {
        guard let currentProgress else { return }
        applyDelay(after: currentProgress.id, by: seconds, incrementSnooze: true)
    }

    func addTemporaryTask(
        title: String,
        minutes: Int,
        placement: TemporaryTaskPlacement
    ) {
        guard var session = snapshot.activeSession,
              minutes > 0
        else { return }

        let duration = TimeInterval(minutes * 60)
        let temporary = RoutineStep(
            title: title,
            prompt: "这是临时插入的事，做完立刻回主线",
            duration: duration
        )

        let now = Date()
        let temporaryProgress = StepProgress(
            step: temporary,
            dueAt: now.addingTimeInterval(duration),
            state: placement == .now ? .active : .pending,
            isTemporary: true,
            plannedDueAt: now.addingTimeInterval(duration),
            remainingDuration: duration,
            startedAt: placement == .now ? now : nil
        )

        if placement == .now {
            suspendCurrentTask(in: &session, at: now)
            session.progress.insert(temporaryProgress, at: 0)
            session.activeProgressID = temporaryProgress.id
            consumeDelay(in: &session, startingAt: 1, seconds: duration)
        } else {
            let currentIndex = session.activeProgressID.flatMap { activeID in
                session.progress.firstIndex(where: { $0.id == activeID })
            }
            let insertionIndex = currentIndex.map { min($0 + 1, session.progress.count) } ?? 0
            session.progress.insert(temporaryProgress, at: insertionIndex)
            consumeDelay(in: &session, startingAt: insertionIndex + 1, seconds: duration)
        }

        recalculateExpectedSchedule(in: &session, now: now)
        session.revision += 1
        session.updatedAt = now
        snapshot.activeSession = session
        commit()
    }

    func reorderPendingTasks(ids: [UUID]) {
        guard var session = snapshot.activeSession else { return }

        let reorderable = session.progress.filter {
            $0.state.isIncomplete
                && $0.step.role == .task
                && $0.id != session.activeProgressID
        }
        guard Set(ids) == Set(reorderable.map(\.id)) else { return }
        let byID = Dictionary(uniqueKeysWithValues: reorderable.map { ($0.id, $0) })
        var ordered = ids.compactMap { byID[$0] }.makeIterator()

        for index in session.progress.indices
        where session.progress[index].state.isIncomplete
            && session.progress[index].step.role == .task
            && session.progress[index].id != session.activeProgressID {
            if let replacement = ordered.next() {
                session.progress[index] = replacement
            }
        }

        recalculateExpectedSchedule(in: &session)
        session.revision += 1
        session.updatedAt = Date()
        snapshot.activeSession = session
        commit()
    }

    /// 只删除当前这次执行里的任务，不修改任务线模板。
    func deleteFromCurrentSession(_ progress: StepProgress, now: Date = Date()) {
        guard var session = snapshot.activeSession,
              progress.step.role == .task,
              let index = session.progress.firstIndex(where: { $0.id == progress.id })
        else { return }

        let wasActive = session.activeProgressID == progress.id
        session.progress.remove(at: index)
        session.suspendedProgressIDs?.removeAll(where: { $0 == progress.id })
        if wasActive {
            session.activeProgressID = nil
            resumeMostRecentTaskIfNeeded(in: &session, at: now)
            startNextTaskIfNeeded(in: &session, at: now)
        }

        recalculateExpectedSchedule(in: &session, now: now)
        session.revision += 1
        session.updatedAt = now
        if session.progress.allSatisfy({ !$0.state.isIncomplete }) {
            session.state = .completed
        }
        snapshot.activeSession = session
        commit()
    }

    func cancel() {
        snapshot.activeSession?.state = .cancelled
        commit()
    }

    func finish() {
        snapshot.activeSession?.state = .completed
        commit()
    }

    private func applyDelay(after progressID: UUID, by seconds: TimeInterval, incrementSnooze: Bool) {
        guard var session = snapshot.activeSession,
              let index = session.progress.firstIndex(where: { $0.id == progressID })
        else { return }

        consumeDelay(in: &session, startingAt: index, seconds: seconds)
        if incrementSnooze {
            session.progress[index].snoozeCount += 1
        }

        session.revision += 1
        session.updatedAt = Date()
        snapshot.activeSession = session
        commit()
    }

    private func consumeDelay(
        in session: inout RoutineSession,
        startingAt index: Int,
        seconds: TimeInterval
    ) {
        guard seconds > 0, index < session.progress.count else { return }
        // 延误代表整条时间线后移；固定缓冲只用于计划展示，不参与扣减。
        for itemIndex in session.progress.indices
        where itemIndex >= index && session.progress[itemIndex].state.isIncomplete {
            session.progress[itemIndex].dueAt = session.progress[itemIndex].dueAt.addingTimeInterval(seconds)
        }
    }

    private func recalculateExpectedSchedule(in session: inout RoutineSession, now: Date = Date()) {
        var cursor = now
        for index in session.progress.indices where session.progress[index].state.isIncomplete {
            if session.progress[index].step.role == .deadline {
                // 最终 Deadline 的原计划保存在 targetDeadline；这里记录的是随实际执行变化的预计完成时间。
                session.progress[index].dueAt = cursor
                continue
            }

            if session.progress[index].state == .active {
                session.progress[index].dueAt = max(session.progress[index].dueAt, now)
            } else {
                session.progress[index].dueAt = cursor.addingTimeInterval(session.progress[index].remainingWork)
            }
            cursor = session.progress[index].dueAt
        }
    }

    private func activate(
        _ progressID: UUID,
        in session: inout RoutineSession,
        at now: Date,
        suspendingCurrent: Bool
    ) {
        if suspendingCurrent, session.activeProgressID != progressID {
            suspendCurrentTask(in: &session, at: now)
        }

        guard let sourceIndex = session.progress.firstIndex(where: { $0.id == progressID }) else { return }
        var selected = session.progress.remove(at: sourceIndex)
        selected.state = .active
        selected.startedAt = now
        selected.dueAt = now.addingTimeInterval(selected.remainingWork)
        session.progress.insert(selected, at: 0)
        session.activeProgressID = selected.id
        session.suspendedProgressIDs?.removeAll(where: { $0 == selected.id })
        recalculateExpectedSchedule(in: &session, now: now)
    }

    private func suspendCurrentTask(in session: inout RoutineSession, at now: Date) {
        guard let activeID = session.activeProgressID,
              let index = session.progress.firstIndex(where: { $0.id == activeID }),
              session.progress[index].state == .active
        else { return }

        session.progress[index].remainingDuration = max(0, session.progress[index].dueAt.timeIntervalSince(now))
        session.progress[index].state = .suspended
        session.progress[index].startedAt = nil
        var stack = session.suspendedProgressIDs ?? []
        stack.removeAll(where: { $0 == activeID })
        stack.append(activeID)
        session.suspendedProgressIDs = stack
        session.activeProgressID = nil
    }

    private func resumeMostRecentTaskIfNeeded(in session: inout RoutineSession, at now: Date) {
        guard session.activeProgressID == nil else { return }
        var stack = session.suspendedProgressIDs ?? []
        while let candidate = stack.popLast() {
            guard let progress = session.progress.first(where: { $0.id == candidate }),
                  progress.state == .suspended
            else { continue }
            session.suspendedProgressIDs = stack
            activate(candidate, in: &session, at: now, suspendingCurrent: false)
            return
        }
        session.suspendedProgressIDs = stack
    }

    /// 当前任务完成且没有需要恢复的挂起任务时，按列表顺序自动开始下一项。
    private func startNextTaskIfNeeded(in session: inout RoutineSession, at now: Date) {
        guard session.activeProgressID == nil,
              let next = session.progress.first(where: {
                  $0.step.role == .task && $0.state.isIncomplete
              })
        else { return }

        activate(next.id, in: &session, at: now, suspendingCurrent: false)
    }

    private func mutateProgress(_ progressID: UUID, update: (inout StepProgress) -> Void) {
        guard var session = snapshot.activeSession,
              let index = session.progress.firstIndex(where: { $0.id == progressID })
        else { return }

        update(&session.progress[index])
        session.revision += 1
        session.updatedAt = Date()
        if session.progress.allSatisfy({ !$0.state.isIncomplete }) {
            session.state = .completed
        }
        snapshot.activeSession = session
        commit()
    }

    private func commit() {
        snapshot.updatedAt = Date()
        snapshot.originID = deviceID
        saveLocally()
        connectivity.publish(snapshot)
        rescheduleIfNeeded()
    }

    private func apply(_ incoming: RoutineSnapshot) {
        guard incoming.originID != deviceID else { return }
        let incomingRevision = incoming.activeSession?.revision ?? 0
        let currentRevision = snapshot.activeSession?.revision ?? 0
        guard incomingRevision > currentRevision || incoming.updatedAt > snapshot.updatedAt else { return }

        snapshot = incoming
        saveLocally()
        rescheduleIfNeeded()
    }

    /// 用 WebView 宿主（JS 侧已自行完成状态机运算与冲突裁决）传来的快照替换本机快照。
    ///
    /// 与 `apply(_:)` 的区别：`apply` 是「对端推来的，需裁决」；本方法是「本机 UI 层的权威快照，
    /// 直接采纳」。**因此不改写 `updatedAt` / `originID` / `revision`** —— 那些由 JS 侧权威维护，
    /// 原生改了会和 JS 的裁决逻辑互相打架。`commit()` 顺带做的广播与重排通知在这里照做。
    func adoptFromWebView(_ incoming: RoutineSnapshot) {
        snapshot = incoming
        saveLocally()
        connectivity.publish(snapshot)
        rescheduleIfNeeded()
    }

    private func saveLocally() {
        guard let data = try? encoder.encode(snapshot) else { return }
        UserDefaults.standard.set(data, forKey: localKey)
        AppGroupSharedStore.write(makeWidgetSnapshot(at: Date()))
    }

    private func makeWidgetSnapshot(at date: Date) -> MainlineWidgetSnapshot {
        guard let session = snapshot.activeSession,
              session.state == .running
        else { return .empty }

        let current = session.progress.first {
            $0.id == session.activeProgressID && $0.state == .active
        }

        let estimatedCompletion = session.estimatedCompletion(at: date)
        let delayDuration: TimeInterval
        if let targetDeadline = session.targetDeadline, let estimatedCompletion {
            delayDuration = max(0, estimatedCompletion.timeIntervalSince(targetDeadline))
        } else if let current {
            delayDuration = max(0, current.dueAt.timeIntervalSince(current.originalDueAt))
        } else {
            delayDuration = 0
        }

        return MainlineWidgetSnapshot(
            capturedAt: date,
            currentTitle: current?.step.title,
            currentDueAt: current?.dueAt,
            originalDueAt: current?.originalDueAt,
            isHardDeadline: current?.step.importance == .hardDeadline,
            estimatedCompletion: estimatedCompletion,
            isLate: delayDuration > 0,
            delayDuration: delayDuration,
            hasActiveSession: true,
            sessionName: session.templateName
        )
    }

    /// 两端各自排一份通知。
    ///
    /// 原规则 `primaryDevice == deviceRole || deviceRole == .phone` 有两个洞：
    /// - **iPhone 启动任务线 → 只有 iPhone 排**：手机放家里、人戴着手表时，到点一条提醒都没有。
    /// - **Watch 启动任务线 → 两端都排但 identifier 完全相同**：iOS 与 watchOS 通知中心互相独立，
    ///   但同一台手表上「手表 App 排的」与「从手机镜像过来的」会撞成同一条，谁后到谁覆盖。
    ///
    /// 现在改为「两端都排 + 各自 identifier 前缀」，并由 `ReminderScheduler` 统一
    /// `threadIdentifier`，让系统把同一件事的两条折叠成一组而不是并列两条。
    private func rescheduleIfNeeded() {
        let role = deviceRole
        let session = snapshot.activeSession
        Task {
            await ReminderScheduler.shared.replaceNotifications(session: session, role: role)
        }
    }
}
