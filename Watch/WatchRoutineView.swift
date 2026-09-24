import SwiftUI

struct WatchRoutineView: View {
    @EnvironmentObject private var store: RoutineStore
    @State private var showsQuickCreate = false
    @State private var showsTemporaryTask = false
    @State private var showsEndConfirmation = false
    @State private var taskPendingDeletion: StepProgress?
    @State private var completionResult: WatchCompletionResult?
    @State private var lastPresentedCompletionID: UUID?

    var body: some View {
        ZStack {
            if store.session?.state == .running {
                activeView
            } else {
                taskLinePicker
            }

            if let completionResult {
                WatchCompletionResultOverlay(result: completionResult) {
                    self.completionResult = nil
                }
            }
        }
        .onChange(of: store.session?.state.rawValue) { _, state in
            guard state == SessionState.completed.rawValue,
                  let session = store.session,
                  session.id != lastPresentedCompletionID
            else { return }
            lastPresentedCompletionID = session.id
            completionResult = WatchCompletionResult(session: session)
        }
    }

    private var taskLinePicker: some View {
        List {
            Section {
                Button {
                    showsQuickCreate = true
                } label: {
                    Label("语音创建", systemImage: "mic.fill")
                }
                .tint(.orange)
            }

            Section("选择任务线") {
                ForEach(store.snapshot.templates) { template in
                    Button {
                        store.start(template)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(template.name, systemImage: template.symbol)
                            Text(template.mode == .backward ? deadlineText(template) : "开始后正计时")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(template.effectiveRecurrence.title)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle("不跑偏")
        .sheet(isPresented: $showsQuickCreate) {
            WatchQuickCreateView()
                .environmentObject(store)
        }
    }

    private var activeView: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let current = store.currentProgress {
                    Text(current.step.importance == .hardDeadline ? "硬节点" : "当前主线")
                        .font(.caption2)
                        .foregroundStyle(current.step.importance == .hardDeadline ? .red : .orange)
                    Text(current.step.title)
                        .font(.title3.bold())
                    Text(current.step.prompt)
                        .font(.caption)
                        .multilineTextAlignment(.center)

                    // 保留原有倒计时；仅补充当前任务和预计时间的横排信息。
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = current.dueAt.timeIntervalSince(context.date)
                        Text(seconds >= 0 ? "还有 \(compactTime(seconds))" : "已超时 \(compactTime(-seconds))")
                            .font(.system(size: 26, weight: .bold, design: .monospaced))
                            .foregroundStyle(seconds < 0 ? .red : .primary)
                            .contentTransition(.numericText())
                    }

                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("当前任务").font(.caption2).foregroundStyle(.secondary)
                            Text(current.step.title).font(.caption.bold()).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("预计时间").font(.caption2).foregroundStyle(.secondary)
                            Text(shortTime(current.dueAt)).font(.caption.bold().monospacedDigit())
                        }
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    }

                    Button("完成") { store.complete(current) }
                        .buttonStyle(.borderedProminent)
                        .tint(current.step.importance == .hardDeadline ? .red : .orange)
                    Button("延后 2 分钟") { store.snoozeCurrent() }
                    Button { showsTemporaryTask = true } label: {
                        Label("临时加事", systemImage: "plus.circle.fill")
                    }
                } else {
                    Text("选择一项开始").font(.headline)
                    Text("进入任务线不会自动计时")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if let session = store.session {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let estimates = session.estimatedDueDates(at: context.date)
                        VStack(spacing: 8) {
                            ForEach(session.progress.filter { $0.state.isIncomplete }) { progress in
                                VStack(spacing: 3) {
                                    HStack {
                                        Image(systemName: icon(for: progress))
                                        Text(progress.step.title)
                                            .font(.caption.bold())
                                        Spacer()
                                        if progress.state == .active {
                                            Text("当前")
                                                .font(.caption2.bold())
                                                .foregroundStyle(.orange)
                                        } else if progress.state == .suspended {
                                            Text("挂起")
                                                .font(.caption2.bold())
                                                .foregroundStyle(.red)
                                        }
                                    }
                                    let estimated = estimates[progress.id] ?? progress.dueAt
                                    Text("计划 \(shortTime(progress.originalDueAt)) · 预计 \(shortTime(estimated))")
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(estimated > progress.originalDueAt ? .red : .secondary)
                                    if progress.step.role == .task,
                                       progress.state == .pending || progress.state == .suspended {
                                        Button("开始") {
                                            store.start(progress)
                                        }
                                        .tint(.orange)
                                    }
                                    if progress.step.role == .task {
                                        Button(role: .destructive) {
                                            taskPendingDeletion = progress
                                        } label: {
                                            Label("本次删除", systemImage: "trash")
                                        }
                                        .font(.caption2)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }

                        if session.isLate(at: context.date),
                           let estimated = session.estimatedCompletion(at: context.date) {
                            Text("预计 \(estimated.formatted(date: .omitted, time: .shortened)) 完成")
                                .font(.caption2.bold())
                                .foregroundStyle(.red)
                        }
                    }
                }

                if store.currentProgress == nil {
                    Button {
                        store.cancel()
                    } label: {
                        Label("返回", systemImage: "chevron.backward")
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button(role: .destructive) {
                        showsEndConfirmation = true
                    } label: {
                        Label("结束并退出", systemImage: "xmark.circle.fill")
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
            }
            .multilineTextAlignment(.center)
        }
        .navigationTitle(store.session?.templateName ?? "不跑偏")
        .sheet(isPresented: $showsTemporaryTask) {
            WatchTemporaryTaskView()
                .environmentObject(store)
        }
        .alert("确定结束当前任务线吗？", isPresented: $showsEndConfirmation) {
            Button("结束并退出", role: .destructive) { store.cancel() }
            Button("继续执行", role: .cancel) {}
        } message: {
            Text("当前进度会停止，之后可以重新选择任务线。")
        }
        .confirmationDialog(
            "删除本次任务？",
            isPresented: Binding(
                get: { taskPendingDeletion != nil },
                set: { if !$0 { taskPendingDeletion = nil } }
            ),
            titleVisibility: .visible,
            presenting: taskPendingDeletion
        ) { progress in
            Button("删除“\(progress.step.title)”", role: .destructive) {
                store.deleteFromCurrentSession(progress)
                taskPendingDeletion = nil
            }
            Button("取消", role: .cancel) { taskPendingDeletion = nil }
        } message: { _ in
            Text("只影响本次计划，原任务线不会改变。")
        }
    }

    private func deadlineText(_ template: RoutineTemplate) -> String {
        guard let hour = template.deadlineHour, let minute = template.deadlineMinute else { return "倒推计划" }
        return String(format: "%02d:%02d 前", hour, minute)
    }

    private func compactTime(_ seconds: TimeInterval) -> String {
        let rounded = max(0, Int(seconds.rounded()))
        let minutes = rounded / 60
        let remainder = rounded % 60
        return minutes > 0 ? "\(minutes)分 \(remainder)秒" : "\(remainder)秒"
    }

    private func shortTime(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    private func icon(for progress: StepProgress) -> String {
        if progress.state == .active { return "target" }
        if progress.state == .suspended { return "pause.circle.fill" }
        if progress.step.role == .deadline { return "flag.checkered" }
        return "circle"
    }
}

private struct WatchCompletionResult: Identifiable {
    let id = UUID()
    let targetDeadline: Date?
    let completedAt: Date

    init(session: RoutineSession) {
        targetDeadline = session.targetDeadline
        completedAt = session.progress.compactMap(\.completedAt).max() ?? Date()
    }

    private var offset: TimeInterval? {
        targetDeadline.map { $0.timeIntervalSince(completedAt) }
    }

    var isAhead: Bool { (offset ?? 0) > 0 }

    var headline: String {
        guard let offset else { return "完成啦" }
        if abs(offset) < 60 { return "准时完成" }
        return offset > 0 ? "提前完成" : "本次延误"
    }

    var emphasis: String {
        guard let offset else { return "好棒" }
        if abs(offset) < 60 { return "刚刚好" }
        return "\(max(1, Int(abs(offset) / 60))) 分钟"
    }
}

private struct WatchCompletionResultOverlay: View {
    let result: WatchCompletionResult
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.32)
                .ignoresSafeArea()
                .onTapGesture(perform: dismiss)

            VStack(spacing: 9) {
                Image(systemName: result.isAhead ? "face.smiling.fill" : "heart.text.square.fill")
                    .font(.title2)
                Text(result.headline)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                Text(result.emphasis)
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .foregroundStyle(.red)
                if let target = result.targetDeadline {
                    Text("计划 \(target.formatted(date: .omitted, time: .shortened))")
                        .font(.caption2)
                    Text("完成 \(result.completedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.caption2)
                }
                Button("收下啦", action: dismiss)
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
            }
            .multilineTextAlignment(.center)
            .padding(18)
            .frame(maxWidth: 166)
            .background(.cyan.opacity(0.82), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(.black.opacity(0.65), lineWidth: 2.5)
            }
            .shadow(radius: 10)
        }
        .accessibilityAddTraits(.isModal)
    }
}

private struct WatchTemporaryTaskView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var minutes = 5

    var body: some View {
        NavigationStack {
            Form {
                Section("临时加事") {
                    TextField("说出或输入任务", text: $title)
                    Stepper("\(minutes) 分钟", value: $minutes, in: 1...60)
                }

                Section("执行方式") {
                    Text("立即置顶并开始；当前任务自动挂起，完成后继续原任务。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Button("加入并开始") {
                    store.addTemporaryTask(
                        title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                        minutes: minutes,
                        placement: .now
                    )
                    dismiss()
                }
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .navigationTitle("临时加事")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}

private struct WatchQuickCreateView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var hasDeadline = true
    @State private var deadline = Date()
    @State private var recurrence: RoutineRecurrence = .once

    private var steps: [RoutineStep] {
        QuickRoutineParser.makeSteps(from: input)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("任务和时长") {
                    TextField("点这里说话", text: $input, axis: .vertical)
                    Text("例如：刷牙3分钟 洗脸5分钟")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if !steps.isEmpty {
                    Section("识别到 \(steps.count) 项") {
                        ForEach(steps) { step in
                            HStack {
                                Text(step.title)
                                Spacer()
                                Text(compactMinutes(step.duration))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("计划设置") {
                    Picker("重复", selection: $recurrence) {
                        ForEach(RoutineRecurrence.allCases, id: \.self) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    Toggle("设置截止", isOn: $hasDeadline)
                    if hasDeadline {
                        DatePicker(
                            "截止",
                            selection: $deadline,
                            displayedComponents: .hourAndMinute
                        )
                        Text("按截止时间倒推开始时间")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("点击开始后，从第一项正计时")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Button("保存任务线") {
                    guard let template = QuickRoutineParser.makeTemplate(
                        from: input,
                        deadline: hasDeadline ? deadline : nil,
                        recurrence: recurrence
                    ) else { return }
                    store.addTemplate(template)
                    dismiss()
                }
                .disabled(steps.isEmpty)
            }
            .navigationTitle("语音创建")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .onChange(of: input) { _, value in
                if let inferredDeadline = QuickRoutineParser.inferredDeadline(from: value) {
                    hasDeadline = true
                    deadline = inferredDeadline
                }
            }
        }
    }

    private func compactMinutes(_ duration: TimeInterval) -> String {
        let minutes = Int(duration / 60)
        return minutes >= 60 && minutes.isMultiple(of: 60)
            ? "\(minutes / 60) 小时"
            : "\(minutes) 分"
    }
}
