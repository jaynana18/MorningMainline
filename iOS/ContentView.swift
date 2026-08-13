import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedTemplate: RoutineTemplate?
    @State private var showsQuickCreate = false
    @State private var showsEndConfirmation = false

    var body: some View {
        NavigationStack {
            Group {
                if store.session?.state == .running {
                    activeSessionView
                } else {
                    taskLinesView
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(store.session?.state == .running ? "执行中" : "不跑偏")
            .toolbar {
                if store.session?.state == .running {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("结束") {
                            showsEndConfirmation = true
                        }
                        .tint(.red)
                    }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showsQuickCreate = true
                        } label: {
                            Label("一句话创建", systemImage: "sparkles")
                        }
                    }
                }
            }
            .navigationDestination(item: $selectedTemplate) { template in
                TaskLinePreviewView(template: template)
            }
            .sheet(isPresented: $showsQuickCreate) {
                QuickCreateView { template in
                    store.addTemplate(template)
                    showsQuickCreate = false
                    selectedTemplate = template
                }
            }
            .confirmationDialog(
                "确定结束当前任务线吗？",
                isPresented: $showsEndConfirmation,
                titleVisibility: .visible
            ) {
                Button("结束并退出", role: .destructive) {
                    store.cancel()
                }
                Button("继续执行", role: .cancel) {}
            } message: {
                Text("当前进度会停止，之后可以重新选择任务线。")
            }
        }
    }

    private var taskLinesView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("把重要的事放在前面")
                        .font(.title2.bold())
                    Text("不是把每分钟排满，而是临时想做别的时，仍然看得见主线会不会被影响。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if horizontalSizeClass == .regular {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                        taskLineCards
                    }
                } else {
                    LazyVStack(spacing: 14) {
                        taskLineCards
                    }
                }

                Button {
                    showsQuickCreate = true
                } label: {
                    Label("用一句话新建任务线", systemImage: "text.badge.plus")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
    }

    @ViewBuilder
    private var taskLineCards: some View {
        ForEach(store.snapshot.templates) { template in
            Button {
                selectedTemplate = template
            } label: {
                TaskLineCard(template: template)
            }
            .buttonStyle(.plain)
        }
    }

    private var activeSessionView: some View {
        ScrollView {
            VStack(spacing: 18) {
                ActiveFocusCard()
                PlanImpactCard()
                TimelineCard()
            }
            .padding()
        }
    }
}

private struct TaskLineCard: View {
    let template: RoutineTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Image(systemName: template.symbol)
                    .font(.title2)
                    .foregroundStyle(.orange)
                    .frame(width: 42, height: 42)
                    .background(.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 13))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            Text(template.name)
                .font(.headline)
                .foregroundStyle(.primary)
            Text(summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
            HStack(spacing: 5) {
                Image(systemName: template.mode == .backward ? "arrow.backward" : "arrow.forward")
                Text(template.mode == .backward ? "倒推计划" : "开始后正计时")
                Text("·")
                Text(template.effectiveRecurrence.title)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(template.mode == .backward ? .orange : .blue)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 22))
    }

    private var summary: String {
        if let hour = template.deadlineHour, let minute = template.deadlineMinute {
            return String(format: "%02d:%02d 前%@ · 缓冲 %@", hour, minute, template.deadlineStep?.title ?? "完成", formatMinutes(template.buffer))
        }
        return "\(template.steps.count) 个步骤 · 预计 \(formatMinutes(template.totalTaskDuration))"
    }
}

private struct TaskLinePreviewView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss
    let template: RoutineTemplate
    @State private var selectedDeadline: Date
    @State private var showsTimeConfirmation = false

    init(template: RoutineTemplate) {
        self.template = template
        let initialDeadline = template.deadline(on: Date()) ?? Date()
        _selectedDeadline = State(initialValue: initialDeadline)
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(template.name)
                        .font(.title2.bold())
                    Text(previewDescription)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }

            Section("计划步骤") {
                ForEach(template.steps) { step in
                    HStack {
                        Image(systemName: step.role == .deadline ? "flag.checkered" : "circle")
                            .foregroundStyle(step.role == .deadline ? .red : .secondary)
                        VStack(alignment: .leading) {
                            Text(step.title)
                            Text(step.role == .deadline ? deadlineSummary : "预计 \(formatMinutes(step.duration))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if template.mode == .backward {
                Section("本次时间") {
                    LabeledContent(
                        "本次\(template.deadlineStep?.title ?? "截止")",
                        value: selectedDeadline.formatted(date: .abbreviated, time: .shortened)
                    )
                    LabeledContent(
                        "倒推开始",
                        value: suggestedStart.formatted(date: .abbreviated, time: .shortened)
                    )
                    Button("修改本次时间") {
                        showsTimeConfirmation = true
                    }
                }
            }
        }
        .navigationTitle("确认任务线")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                attemptStart()
            } label: {
                Label("开始执行", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
            .padding()
            .background(.bar)
        }
        .sheet(isPresented: $showsTimeConfirmation) {
            StartTimeConfirmationView(
                template: template,
                selectedDeadline: $selectedDeadline
            ) {
                start(deadline: selectedDeadline)
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var suggestedStart: Date {
        selectedDeadline.addingTimeInterval(-template.totalTaskDuration - template.buffer)
    }

    private var deadlineSummary: String {
        "硬节点 · \(selectedDeadline.formatted(date: .omitted, time: .shortened))"
    }

    private var previewDescription: String {
        template.mode == .backward
            ? "你只要守住 \(template.deadlineStep?.title ?? "这个时间点")，App 会把开始时间和缓冲倒推出来。"
            : "点开始后顺序执行；如果临时加事，后面的时间会跟着变化。"
    }

    private func attemptStart() {
        guard template.mode == .backward else {
            start(deadline: nil)
            return
        }
        let availableTime = selectedDeadline.timeIntervalSinceNow
        let isTooEarly = suggestedStart.timeIntervalSinceNow > 60 * 60
        let isTimeInsufficient = availableTime < template.totalTaskDuration
        if isTooEarly || isTimeInsufficient {
            showsTimeConfirmation = true
        } else {
            start(deadline: selectedDeadline)
        }
    }

    private func start(deadline: Date?) {
        store.start(template, deadlineOverride: deadline)
        showsTimeConfirmation = false
        dismiss()
    }
}

private struct StartTimeConfirmationView: View {
    @Environment(\.dismiss) private var dismiss
    let template: RoutineTemplate
    @Binding var selectedDeadline: Date
    let onStart: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("本次硬节点") {
                    DatePicker(
                        "本次\(template.deadlineStep?.title ?? "截止")时间",
                        selection: $selectedDeadline,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                }

                Section("倒推结果") {
                    LabeledContent(
                        "建议开始",
                        value: suggestedStart.formatted(date: .abbreviated, time: .shortened)
                    )
                    LabeledContent(
                        "计划缓冲",
                        value: formatMinutes(template.buffer)
                    )
                    LabeledContent(
                        "现在开始可用缓冲",
                        value: formatMinutes(availableBufferIfStartedNow)
                    )
                }

                Section {
                    Label(statusMessage, systemImage: statusSymbol)
                        .foregroundStyle(statusColor)
                }
            }
            .navigationTitle("确认本次时间")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    Button {
                        onStart()
                    } label: {
                        Label("立即开始", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)

                    Button("暂不开始") {
                        dismiss()
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding()
                .background(.bar)
            }
        }
    }

    private var suggestedStart: Date {
        selectedDeadline.addingTimeInterval(-template.totalTaskDuration - template.buffer)
    }

    private var availableTime: TimeInterval {
        selectedDeadline.timeIntervalSinceNow
    }

    private var availableBufferIfStartedNow: TimeInterval {
        max(0, availableTime - template.totalTaskDuration)
    }

    private var expectedOverrun: TimeInterval {
        max(0, template.totalTaskDuration - availableTime)
    }

    private var statusMessage: String {
        if availableTime < template.totalTaskDuration {
            return "按当前设置立即开始，预计会比硬节点晚 \(formatMinutes(expectedOverrun))。"
        }
        if suggestedStart.timeIntervalSinceNow > 60 * 60 {
            return "现在距离建议开始较远；若立即开始，提前量会计入本次可用缓冲。"
        }
        if suggestedStart > Date() {
            return "还没到建议开始时间，立即开始后提前量会成为额外缓冲。"
        }
        return "现在已经进入建议执行时间，可以直接开始。"
    }

    private var statusSymbol: String {
        if availableTime < template.totalTaskDuration {
            return "exclamationmark.triangle.fill"
        }
        if suggestedStart > Date() {
            return "clock.arrow.circlepath"
        }
        return "checkmark.circle.fill"
    }

    private var statusColor: Color {
        availableTime < template.totalTaskDuration ? .red : .secondary
    }
}

private struct ActiveFocusCard: View {
    @EnvironmentObject private var store: RoutineStore
    @State private var showsTemporaryTask = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(store.session?.templateName ?? "任务线", systemImage: store.session?.templateSymbol ?? "target")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let session = store.session, session.isLate {
                    Label("会晚到", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.bold())
                        .foregroundStyle(.red)
                }
            }

            if let current = store.currentProgress {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(current.step.importance == .hardDeadline ? "现在必须做" : "当前主线")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(current.step.importance == .hardDeadline ? .red : .orange)
                        Text(current.step.title)
                            .font(.system(size: 36, weight: .bold, design: .rounded))
                        Text(current.step.prompt)
                            .foregroundStyle(.secondary)
                        RemainingTimeText(dueAt: current.dueAt, now: context.date)
                    }
                }

                HStack(spacing: 10) {
                    Button("完成") { store.complete(current) }
                        .buttonStyle(.borderedProminent)
                        .tint(.orange)
                    Button("延后 2 分钟") { store.snoozeCurrent() }
                        .buttonStyle(.bordered)
                    Button {
                        showsTemporaryTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("临时加事")
                }
            } else {
                Text("今天的主线完成啦")
                    .font(.title3.bold())
                Button("结束今天流程") { store.finish() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 26))
        .sheet(isPresented: $showsTemporaryTask) {
            TemporaryTaskView()
        }
    }
}

private struct PlanImpactCard: View {
    @EnvironmentObject private var store: RoutineStore

    var body: some View {
        guard let session = store.session else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(alignment: .leading, spacing: 12) {
                Text("计划影响")
                    .font(.headline)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("剩余缓冲")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(formatMinutes(session.remainingBuffer))
                            .font(.title3.bold())
                            .foregroundStyle(session.remainingBuffer == 0 ? .red : .primary)
                    }
                    Spacer()
                    if let target = session.targetDeadline, let expected = session.expectedDeadline {
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(session.isLate ? "预计完成" : "目标时间")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(expected.formatted(date: .omitted, time: .shortened))
                                .font(.title3.bold())
                                .foregroundStyle(session.isLate ? .red : .primary)
                            if session.isLate {
                                Text("比 \(target.formatted(date: .omitted, time: .shortened)) 晚 \(formatMinutes(expected.timeIntervalSince(target)))")
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(session.isLate ? Color.red.opacity(0.08) : Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 22))
        )
    }
}

private struct TimelineCard: View {
    @EnvironmentObject private var store: RoutineStore

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("接下来")
                .font(.headline)
            ForEach(store.session?.progress.sorted { $0.dueAt < $1.dueAt } ?? []) { progress in
                HStack(spacing: 12) {
                    Image(systemName: icon(for: progress))
                        .foregroundStyle(progress.state == .completed ? .green : progress.isTemporary ? .purple : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(progress.step.title)
                            if progress.isTemporary {
                                Text("临时")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.purple)
                            }
                        }
                        .font(.subheadline.weight(.medium))
                        Text(progress.dueAt.formatted(date: .omitted, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .opacity(progress.state == .completed ? 0.55 : 1)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 22))
    }

    private func icon(for progress: StepProgress) -> String {
        if progress.state == .completed { return "checkmark.circle.fill" }
        if progress.step.role == .deadline { return "flag.checkered" }
        return "circle"
    }
}

private struct RemainingTimeText: View {
    let dueAt: Date
    let now: Date

    var body: some View {
        let seconds = dueAt.timeIntervalSince(now)
        Text(seconds >= 0 ? "还有 \(formatMinutes(seconds, includeSeconds: true))" : "已超时 \(formatMinutes(-seconds, includeSeconds: true))")
            .font(.system(.title3, design: .monospaced, weight: .bold))
            .foregroundStyle(seconds < 0 ? .red : seconds < 5 * 60 ? .orange : .primary)
    }
}

private struct TemporaryTaskView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var minutes = 5

    var body: some View {
        NavigationStack {
            Form {
                Section("临时加一件事") {
                    TextField("例如：找袜子 / 回一条消息", text: $title)
                    Stepper("预计 \(minutes) 分钟", value: $minutes, in: 1...60)
                }
                Section {
                    Text(impactText)
                        .foregroundStyle(impactIsLate ? .red : .secondary)
                } header: {
                    Text("加入前先看影响")
                }
            }
            .navigationTitle("临时加事")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("加入") {
                        store.addTemporaryTask(title: title, minutes: minutes)
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var impactIsLate: Bool {
        guard let session = store.session else { return false }
        return TimeInterval(minutes * 60) > session.remainingBuffer
    }

    private var impactText: String {
        guard let session = store.session else { return "" }
        let seconds = TimeInterval(minutes * 60)
        if seconds <= session.remainingBuffer {
            return "会消耗 \(formatMinutes(seconds)) 缓冲，还剩 \(formatMinutes(session.remainingBuffer - seconds))，目标时间不变。"
        }
        return "缓冲只剩 \(formatMinutes(session.remainingBuffer))，加入后预计会晚 \(formatMinutes(seconds - session.remainingBuffer))。"
    }
}

private struct QuickCreateView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @State private var generated: RoutineTemplate?
    @State private var hasDeadline = true
    @State private var selectedDeadline = Date()
    @State private var recurrence: RoutineRecurrence = .once
    let onSave: (RoutineTemplate) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $input)
                        .frame(minHeight: 130)
                    Text("例：博兴任务20分钟  去厕所5分钟  App安装5分钟")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Label("也可以点系统键盘的麦克风直接说", systemImage: "mic.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } header: {
                    Text("只写任务和时长")
                } footer: {
                    Text("截止时间和重复方式在下方选择，不需要写进这段话。")
                }

                Section("计划设置") {
                    Picker("重复", selection: $recurrence) {
                        ForEach(RoutineRecurrence.allCases, id: \.self) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)

                    Toggle("设置截止时间", isOn: $hasDeadline)

                    if hasDeadline {
                        DatePicker(
                            "截止时间",
                            selection: $selectedDeadline,
                            displayedComponents: .hourAndMinute
                        )
                        Text("设置后，会按截止时间倒推出应该开始的时间。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("不设置时，点击“开始执行”后从第一项开始正计时。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Button("生成任务线") {
                    generated = makeTemplate()
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if let generated {
                    Section("预览") {
                        Label(generated.name, systemImage: generated.symbol)
                        LabeledContent("重复", value: generated.effectiveRecurrence.title)
                        LabeledContent(
                            "计时方式",
                            value: generated.mode == .backward ? "按截止时间倒推" : "开始后正计时"
                        )
                        if generated.mode == .backward {
                            LabeledContent(
                                "截止时间",
                                value: selectedDeadline.formatted(date: .omitted, time: .shortened)
                            )
                        }
                        ForEach(generated.steps) { step in
                            HStack {
                                Text(step.title)
                                Spacer()
                                Text(step.role == .deadline ? "硬节点" : formatMinutes(step.duration))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("一句话创建")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        if let generated { onSave(generated) }
                    }
                    .disabled(generated == nil)
                }
            }
            .onChange(of: hasDeadline) { _, _ in generated = nil }
            .onChange(of: selectedDeadline) { _, _ in generated = nil }
            .onChange(of: recurrence) { _, _ in generated = nil }
            .onChange(of: input) { _, _ in generated = nil }
        }
    }

    private func makeTemplate() -> RoutineTemplate? {
        QuickRoutineParser.makeTemplate(
            from: input,
            deadline: hasDeadline ? selectedDeadline : nil,
            recurrence: recurrence
        )
    }
}

private func formatMinutes(_ seconds: TimeInterval, includeSeconds: Bool = false) -> String {
    let rounded = max(0, Int(seconds.rounded()))
    let hours = rounded / 3600
    let minutes = (rounded % 3600) / 60
    let remainingSeconds = rounded % 60
    if includeSeconds, hours == 0, minutes == 0 { return "\(remainingSeconds) 秒" }
    if hours > 0 && minutes > 0 { return "\(hours) 小时 \(minutes) 分钟" }
    if hours > 0 { return "\(hours) 小时" }
    return "\(minutes) 分钟"
}
