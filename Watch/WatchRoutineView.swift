import SwiftUI

struct WatchRoutineView: View {
    @EnvironmentObject private var store: RoutineStore
    @State private var showsQuickCreate = false

    var body: some View {
        if store.session?.state == .running {
            activeView
        } else {
            taskLinePicker
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

                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = current.dueAt.timeIntervalSince(context.date)
                        Text(seconds >= 0 ? "还有 \(compactTime(seconds))" : "已超时 \(compactTime(-seconds))")
                            .font(.system(.title3, design: .monospaced, weight: .bold))
                            .foregroundStyle(seconds < 0 ? .red : .primary)
                    }

                    Button("完成") {
                        store.complete(current)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(current.step.importance == .hardDeadline ? .red : .orange)

                    Button("延后 2 分钟") {
                        store.snoozeCurrent()
                    }

                    if let session = store.session {
                        Text("缓冲 \(compactTime(session.remainingBuffer))")
                            .font(.caption2)
                            .foregroundStyle(session.remainingBuffer == 0 ? .red : .secondary)
                    }
                } else {
                    Text("今天的主线完成啦")
                    Button("结束") { store.finish() }
                }
            }
            .multilineTextAlignment(.center)
        }
        .navigationTitle(store.session?.templateName ?? "不跑偏")
    }

    private func deadlineText(_ template: RoutineTemplate) -> String {
        guard let hour = template.deadlineHour, let minute = template.deadlineMinute else { return "倒推计划" }
        return String(format: "%02d:%02d 前", hour, minute)
    }

    private func compactTime(_ seconds: TimeInterval) -> String {
        let rounded = max(0, Int(seconds.rounded()))
        let minutes = rounded / 60
        let remainder = rounded % 60
        return minutes > 0 ? "\(minutes) 分" : "\(remainder) 秒"
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
        }
    }

    private func compactMinutes(_ duration: TimeInterval) -> String {
        let minutes = Int(duration / 60)
        return minutes >= 60 && minutes.isMultiple(of: 60)
            ? "\(minutes / 60) 小时"
            : "\(minutes) 分"
    }
}
