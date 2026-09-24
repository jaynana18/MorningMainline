import SwiftUI

private enum MainlineTheme {
    static let canvas = Color(red: 1.000, green: 0.985, blue: 0.925)
    static let cream = Color(red: 1.000, green: 0.902, blue: 0.680)
    static let softCream = Color(red: 1.000, green: 0.957, blue: 0.830)
    static let orange = Color(red: 0.985, green: 0.410, blue: 0.110)
    static let tangerine = Color(red: 1.000, green: 0.585, blue: 0.160)
    static let olive = Color(red: 0.585, green: 0.625, blue: 0.350)
    static let softOlive = Color(red: 0.770, green: 0.870, blue: 0.700)
    static let coral = Color(red: 0.965, green: 0.560, blue: 0.430)
    static let sky = Color(red: 0.345, green: 0.720, blue: 0.900)
    static let softSky = Color(red: 0.790, green: 0.915, blue: 0.970)
    static let ink = Color(red: 0.115, green: 0.120, blue: 0.115)

    static let taskCards = [softSky, cream, softOlive, Color(red: 0.985, green: 0.800, blue: 0.690)]
}

private struct MainlinePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.subheadline, design: .rounded, weight: .bold))
            .foregroundStyle(.white)
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(MainlineTheme.orange.opacity(configuration.isPressed ? 0.78 : 1), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

private struct MainlineSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.subheadline, design: .rounded, weight: .bold))
            .foregroundStyle(MainlineTheme.ink)
            .padding(.vertical, 11)
            .padding(.horizontal, 14)
            .background(.white.opacity(configuration.isPressed ? 0.65 : 0.88), in: Capsule())
            .overlay {
                Capsule()
                    .stroke(MainlineTheme.ink.opacity(0.62), lineWidth: 2)
            }
    }
}

struct ContentView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedTemplate: RoutineTemplate?
    @State private var showsQuickCreate = false
    @State private var showsEndConfirmation = false
    @State private var completionResult: CompletionResult?
    @State private var lastPresentedCompletionID: UUID?

    var body: some View {
        NavigationStack {
            ZStack {
                Group {
                    if store.session?.state == .running {
                        activeSessionView
                    } else {
                        taskLinesView
                    }
                }

                if let completionResult {
                    CompletionResultOverlay(result: completionResult) {
                        self.completionResult = nil
                    }
                    .zIndex(1)
                }
            }
            .background(MainlineTheme.canvas.ignoresSafeArea())
            .navigationTitle(store.session?.state == .running ? "执行中" : "不跑偏")
            .navigationBarTitleDisplayMode(.inline)
            .tint(MainlineTheme.orange)
            .toolbar {
                if store.session?.state == .running {
                    ToolbarItem(placement: .topBarTrailing) {
                        if store.currentProgress == nil {
                            Button("返回") {
                                store.cancel()
                            }
                        } else {
                            Button("结束") {
                                showsEndConfirmation = true
                            }
                            .tint(.red)
                        }
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
            .onChange(of: store.session?.state.rawValue) { _, state in
                guard state == SessionState.completed.rawValue,
                      let session = store.session,
                      session.id != lastPresentedCompletionID
                else { return }

                lastPresentedCompletionID = session.id
                completionResult = CompletionResult(session: session)
            }
        }
    }

    private var taskLinesView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                TaskLinesHero()

                HStack {
                    Text("快速开始")
                        .font(.headline)
                    Spacer()
                    Text("选择一条主线")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                LazyVGrid(
                    columns: [
                        GridItem(
                            .adaptive(minimum: horizontalSizeClass == .regular ? 210 : 155),
                            spacing: 12
                        )
                    ],
                    spacing: 12
                ) {
                    taskLineCards
                }

                Button {
                    showsQuickCreate = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "sparkles")
                            .font(.title3.bold())
                            .frame(width: 42, height: 42)
                            .background(.white.opacity(0.72), in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text("一句话新建任务线")
                                .font(.headline)
                            Text("说清任务和时长，其他交给我")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "arrow.right")
                            .font(.subheadline.bold())
                    }
                    .foregroundStyle(MainlineTheme.ink)
                    .padding(14)
                    .background(MainlineTheme.softSky, in: RoundedRectangle(cornerRadius: 20))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20)
                            .stroke(MainlineTheme.ink.opacity(0.62), lineWidth: 2)
                    }
                }
                .buttonStyle(.plain)
            }
            .padding()
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var taskLineCards: some View {
        ForEach(Array(store.snapshot.templates.enumerated()), id: \.element.id) { index, template in
            Button {
                selectedTemplate = template
            } label: {
                TaskLineCard(template: template, colorIndex: index)
            }
            .buttonStyle(.plain)
        }
    }

    private var activeSessionView: some View {
        ScrollView {
            Group {
                if horizontalSizeClass == .regular {
                    HStack(alignment: .top, spacing: 18) {
                        ActiveFocusCard()
                            .frame(maxWidth: .infinity, alignment: .top)
                        VStack(spacing: 18) {
                            PlanImpactCard()
                            TimelineCard()
                        }
                        .frame(maxWidth: .infinity, alignment: .top)
                    }
                } else {
                    VStack(spacing: 18) {
                        ActiveFocusCard()
                        PlanImpactCard()
                        TimelineCard()
                    }
                }
            }
            .padding()
            .frame(maxWidth: 1180)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct CompletionResult: Identifiable {
    let id = UUID()
    let sessionID: UUID
    let targetDeadline: Date?
    let completedAt: Date

    init(session: RoutineSession) {
        sessionID = session.id
        targetDeadline = session.targetDeadline
        completedAt = session.progress.compactMap(\.completedAt).max() ?? Date()
    }

    private var offset: TimeInterval? {
        targetDeadline.map { $0.timeIntervalSince(completedAt) }
    }

    var isAhead: Bool { (offset ?? 0) > 0 }

    var headline: String {
        guard let offset else { return "恭喜你，完成啦" }
        if abs(offset) < 60 { return "恭喜你，刚刚好完成" }
        return offset > 0 ? "恭喜你，成功提前了" : "很遗憾，你本次延误了"
    }

    var emphasis: String {
        guard let offset else { return "完成" }
        if abs(offset) < 60 { return "准时" }
        return "\(max(1, Int(abs(offset) / 60))) 分钟"
    }

    var plannedTime: String? {
        targetDeadline?.formatted(date: .omitted, time: .shortened)
    }
}

private struct CompletionResultOverlay: View {
    let result: CompletionResult
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.24)
                .ignoresSafeArea()
                .onTapGesture(perform: dismiss)

            VStack(spacing: 20) {
                HStack(spacing: 8) {
                    Image(systemName: result.isAhead ? "sparkles" : "cloud.drizzle.fill")
                    Text("不跑偏 · 本次结果")
                }
                .font(.subheadline.weight(.bold))
                .foregroundStyle(MainlineTheme.ink.opacity(0.7))

                Text(result.headline)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .multilineTextAlignment(.center)

                Text(result.emphasis)
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .foregroundStyle(MainlineTheme.orange)

                VStack(spacing: 5) {
                    if let plannedTime = result.plannedTime {
                        Text("原计划  \(plannedTime)")
                    }
                    Text("当前时间  \(result.completedAt.formatted(date: .omitted, time: .shortened))")
                }
                .font(.system(.title3, design: .rounded, weight: .medium))

                HStack(spacing: 10) {
                    Image(systemName: result.isAhead ? "face.smiling.fill" : "heart.text.square.fill")
                        .font(.title2)
                    Text(result.isAhead ? "今天也稳稳守住主线" : "没关系，下次继续守住主线")
                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                }
                .foregroundStyle(MainlineTheme.ink)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
                .background(MainlineTheme.cream, in: Capsule())
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "pencil.line")
                        .foregroundStyle(MainlineTheme.ink.opacity(0.55))
                        .rotationEffect(.degrees(-18))
                        .offset(x: 4, y: -8)
                }

                Button("收下啦", action: dismiss)
                    .buttonStyle(MainlinePrimaryButtonStyle())
            }
            .foregroundStyle(MainlineTheme.ink)
            .padding(28)
            .frame(maxWidth: 360)
            .background(MainlineTheme.sky, in: RoundedRectangle(cornerRadius: 38, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 38, style: .continuous)
                    .stroke(MainlineTheme.ink.opacity(0.70), lineWidth: 3)
                    .rotationEffect(.degrees(-0.5))
            }
            .shadow(color: MainlineTheme.ink.opacity(0.20), radius: 20, y: 10)
            .padding(24)
        }
        .accessibilityAddTraits(.isModal)
    }
}

private struct TaskLinesHero: View {
    var body: some View {
        ZStack(alignment: .trailing) {
            RoundedRectangle(cornerRadius: 24)
                .fill(MainlineTheme.sky)

            VStack(spacing: 4) {
                Image(systemName: "flag.fill")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(MainlineTheme.orange)
                    .rotationEffect(.degrees(4))
                HStack(spacing: 5) {
                    Circle().fill(MainlineTheme.ink).frame(width: 5, height: 5)
                    Circle().fill(MainlineTheme.ink).frame(width: 5, height: 5)
                }
                Capsule()
                    .trim(from: 0.05, to: 0.70)
                    .stroke(MainlineTheme.ink, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 22, height: 11)
            }
            .padding(.trailing, 24)

            VStack(alignment: .leading, spacing: 7) {
                Text("今天，先守住一条主线")
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .foregroundStyle(MainlineTheme.ink)
                Text("不用变成完美的 J 人，只要别让最重要的事跑偏。")
                    .font(.subheadline)
                    .foregroundStyle(MainlineTheme.ink.opacity(0.64))
                    .frame(maxWidth: 250, alignment: .leading)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 132)
        .overlay {
            RoundedRectangle(cornerRadius: 24)
                .stroke(MainlineTheme.ink.opacity(0.70), lineWidth: 3)
                .rotationEffect(.degrees(-0.35))
        }
    }
}

private struct TaskLineCard: View {
    let template: RoutineTemplate
    let colorIndex: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Image(systemName: template.symbol)
                    .font(.title2)
                    .foregroundStyle(MainlineTheme.ink)
                    .frame(width: 42, height: 42)
                    .background(.white.opacity(0.72), in: RoundedRectangle(cornerRadius: 13))
                Spacer()
                Circle()
                    .fill(MainlineTheme.ink)
                    .frame(width: 5, height: 5)
            }
            Text(template.name)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .foregroundStyle(MainlineTheme.ink)
            Text(summary)
                .font(.caption)
                .foregroundStyle(MainlineTheme.ink.opacity(0.62))
                .multilineTextAlignment(.leading)
                .lineLimit(2)
            HStack(spacing: 5) {
                Image(systemName: template.mode == .backward ? "arrow.backward" : "arrow.forward")
                Text(template.mode == .backward ? "倒推计划" : "正计时")
                Spacer()
                Image(systemName: "arrow.right")
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(MainlineTheme.ink.opacity(0.78))
        }
        .padding(15)
        .frame(minHeight: 160)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardColor, in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            RoundedRectangle(cornerRadius: 20)
                .stroke(MainlineTheme.ink.opacity(0.62), lineWidth: 2.5)
        }
    }

    private var summary: String {
        if let hour = template.deadlineHour, let minute = template.deadlineMinute {
            return String(format: "%02d:%02d 前%@ · 倒推计划", hour, minute, template.deadlineStep?.title ?? "完成")
        }
        return "\(template.steps.count) 个步骤 · 预计 \(formatMinutes(template.totalTaskDuration))"
    }

    private var cardColor: Color {
        MainlineTheme.taskCards[colorIndex % MainlineTheme.taskCards.count]
    }
}

private struct TaskLinePreviewView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let template: RoutineTemplate
    @State private var selectedDeadline: Date
    @State private var selectedBufferMinutes = 10

    init(template: RoutineTemplate) {
        self.template = template
        let now = Date()
        let exactCompletion = now.addingTimeInterval(template.totalTaskDuration + template.buffer)
        let calendar = Calendar.current
        let minuteStart = calendar.dateInterval(of: .minute, for: exactCompletion)?.start ?? exactCompletion
        let roundedCompletion = minuteStart < exactCompletion
            ? calendar.date(byAdding: .minute, value: 1, to: minuteStart) ?? exactCompletion
            : minuteStart
        _selectedDeadline = State(initialValue: roundedCompletion)
        _selectedBufferMinutes = State(initialValue: max(0, Int(template.buffer / 60)))
    }

    var body: some View {
        ScrollView {
            if template.mode == .backward {
                backwardPlanView
            } else {
                forwardPlanView
            }
        }
        .background(MainlineTheme.canvas.ignoresSafeArea())
        .navigationTitle(template.name)
        .navigationBarTitleDisplayMode(.inline)
        .tint(MainlineTheme.orange)
    }

    private var backwardPlanView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(statusMessage, systemImage: statusSymbol)
                .foregroundStyle(statusColor)
                .font(.subheadline.weight(.medium))
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .doodleCard(statusColor == .red ? MainlineTheme.coral.opacity(0.22) : MainlineTheme.softSky, cornerRadius: 18)

            HStack(alignment: .top, spacing: 12) {
                currentPlanCard
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                originalPlanCard
                    .frame(width: horizontalSizeClass == .regular ? 320 : 132)
            }
        }
        .padding()
        .frame(maxWidth: 1120)
        .frame(maxWidth: .infinity)
    }

    private var forwardPlanView: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("从现在开始")
                    .font(.title2.bold())
                Text("进入任务线后，再选择一项开始。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 12) {
                ForEach(template.taskSteps) { step in
                    HStack {
                        Image(systemName: "circle")
                            .foregroundStyle(.secondary)
                        Text(step.title)
                        Spacer()
                        Text(formatMinutes(step.duration))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(18)
            .doodleCard(MainlineTheme.softSky, cornerRadius: 22)

            Button {
                start(deadline: nil)
            } label: {
                Label("进入任务线", systemImage: "list.bullet")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(MainlinePrimaryButtonStyle())
        }
        .padding()
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
    }

    private var currentPlanCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("本次计划")
                    .font(.title3.bold())
                Text("默认预留 10 分钟缓冲，可自行调整")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("本次\(template.deadlineStep?.title ?? "截止")时间")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                DatePicker(
                    "本次时间",
                    selection: $selectedDeadline,
                    displayedComponents: [.hourAndMinute]
                )
                .labelsHidden()
                .datePickerStyle(.compact)

                Stepper(
                    "缓冲时间 \(selectedBufferMinutes) 分钟",
                    value: $selectedBufferMinutes,
                    in: 0...60,
                    step: 5
                )
                .font(.subheadline.weight(.medium))
                Text("会按该固定机动时间整体倒推，不会在执行中扣减。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()
            BackwardPlanSummary(
                template: template,
                deadline: selectedDeadline,
                buffer: selectedBuffer
            )

            Button {
                start(deadline: selectedDeadline, buffer: selectedBuffer)
            } label: {
                Label("按本次计划进入", systemImage: "list.bullet")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(MainlinePrimaryButtonStyle())
        }
        .planOptionCard(prominent: true)
    }

    private var originalPlanCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("原计划")
                    .font(.headline)
                Text(originalPlanCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(originalDayLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(originalDeadline.formatted(date: .omitted, time: .shortened))
                    .font(.title2.bold().monospacedDigit())
                    .minimumScaleFactor(0.7)
            }

            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("建议开始")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(originalSuggestedStart.formatted(date: .omitted, time: .shortened))
                    .font(.headline.monospacedDigit())
                Text("预留缓冲 \(formatMinutes(template.buffer))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Button {
                start(deadline: originalDeadline, buffer: template.buffer)
            } label: {
                Label("按原计划进入", systemImage: "list.bullet")
                    .frame(maxWidth: .infinity)
                    .lineLimit(2)
                    .minimumScaleFactor(0.72)
            }
            .buttonStyle(MainlineSecondaryButtonStyle())
        }
        .planOptionCard(prominent: false)
    }

    private var originalDeadline: Date {
        template.deadline(on: Date()) ?? selectedDeadline
    }

    private var originalSuggestedStart: Date {
        originalDeadline.addingTimeInterval(-template.totalTaskDuration - template.buffer)
    }

    private var originalIsExpired: Bool {
        template.effectiveRecurrence == .once && originalDeadline < Date()
    }

    private var originalDayLabel: String {
        if Calendar.current.isDateInTomorrow(originalDeadline) {
            return "明天原定\(template.deadlineStep?.title ?? "截止")"
        }
        return "今天原定\(template.deadlineStep?.title ?? "截止")"
    }

    private var originalPlanCaption: String {
        if originalIsExpired {
            return "单次计划已过期"
        }
        return "按固定机动时间倒推"
    }

    private var selectedBuffer: TimeInterval {
        TimeInterval(selectedBufferMinutes * 60)
    }

    private var statusMessage: String {
        if originalIsExpired {
            return "原计划时间已经过去。单次计划不会自动顺延，请使用本次计划。"
        }
        if Calendar.current.isDateInTomorrow(originalDeadline) {
            return "今天的原计划时间已经过去，已自动顺延到明天。也可以按本次计划从现在开始。"
        }
        let originalAvailable = originalDeadline.timeIntervalSinceNow
        if originalAvailable < template.totalTaskDuration {
            let overrun = template.totalTaskDuration - originalAvailable
            return "按原计划已经来不及，预计会晚 \(formatMinutes(overrun))。建议使用本次计划。"
        }
        if originalSuggestedStart.timeIntervalSinceNow > 60 * 60 {
            return "现在距离原计划建议开始较远。你可以调整本次时间，或按原计划开始。"
        }
        if originalSuggestedStart > Date() {
            return "还没到原计划建议开始时间；现在开始会比原计划更从容。"
        }
        return "现在已经进入建议执行时间，选择计划进入后，再开始具体任务。"
    }

    private var statusSymbol: String {
        if originalIsExpired {
            return "calendar.badge.exclamationmark"
        }
        if Calendar.current.isDateInTomorrow(originalDeadline) {
            return "calendar.badge.clock"
        }
        if originalDeadline.timeIntervalSinceNow < template.totalTaskDuration {
            return "exclamationmark.triangle.fill"
        }
        if originalSuggestedStart > Date() {
            return "clock.arrow.circlepath"
        }
        return "checkmark.circle.fill"
    }

    private var statusColor: Color {
        originalIsExpired || originalDeadline.timeIntervalSinceNow < template.totalTaskDuration
            ? .red
            : .orange
    }

    private func start(deadline: Date?, buffer: TimeInterval? = nil) {
        store.start(
            template,
            deadlineOverride: deadline,
            bufferOverride: buffer
        )
        dismiss()
    }
}

private struct BackwardPlanSummary: View {
    let template: RoutineTemplate
    let deadline: Date
    let buffer: TimeInterval

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent(
                "倒推开始",
                value: deadline
                    .addingTimeInterval(-template.totalTaskDuration - buffer)
                    .formatted(date: .omitted, time: .shortened)
            )
            LabeledContent("本次预留缓冲", value: formatMinutes(buffer))

            ForEach(planRows) { row in
                HStack(spacing: 10) {
                    Image(systemName: row.isDeadline ? "flag.fill" : "circle")
                        .font(.caption)
                        .foregroundStyle(row.isDeadline ? .red : .secondary)
                    Text(row.title)
                        .font(.subheadline)
                    Spacer()
                    Text(row.time.formatted(date: .omitted, time: .shortened))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var planRows: [PlanRow] {
        var cursor = deadline.addingTimeInterval(-buffer)
        var rows: [PlanRow] = template.deadlineStep.map {
            [PlanRow(id: $0.id, title: $0.title, time: deadline, isDeadline: true)]
        } ?? []

        for step in template.taskSteps.reversed() {
            cursor = cursor.addingTimeInterval(-step.duration)
            rows.append(PlanRow(id: step.id, title: step.title, time: cursor, isDeadline: false))
        }
        return rows.reversed()
    }

    private struct PlanRow: Identifiable {
        let id: UUID
        let title: String
        let time: Date
        let isDeadline: Bool
    }
}

private extension View {
    func doodleCard(_ color: Color, cornerRadius: CGFloat) -> some View {
        background(color, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(MainlineTheme.ink.opacity(0.62), lineWidth: 2.5)
                    .rotationEffect(.degrees(-0.25))
            }
    }

    func planOptionCard(prominent: Bool) -> some View {
        padding(prominent ? 18 : 11)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .doodleCard(prominent ? MainlineTheme.softSky : MainlineTheme.cream, cornerRadius: 22)
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
                if let session = store.session {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        if session.isLate(at: context.date) {
                            Label("会晚到", systemImage: "exclamationmark.triangle.fill")
                                .font(.caption.bold())
                                .foregroundStyle(.red)
                        }
                    }
                }
            }

            if let current = store.currentProgress {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(current.step.importance == .hardDeadline ? "现在必须做" : "当前主线")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(current.step.importance == .hardDeadline ? .red : MainlineTheme.orange)
                        Text(current.step.title)
                            .font(.system(size: 36, weight: .bold, design: .rounded))
                        Text(current.step.prompt)
                            .foregroundStyle(.secondary)
                        RemainingTimeText(dueAt: current.dueAt, now: context.date)
                    }
                }

                HStack(spacing: 10) {
                    Button("完成") { store.complete(current) }
                        .buttonStyle(MainlinePrimaryButtonStyle())
                    Button("延后 2 分钟") { store.snoozeCurrent() }
                        .buttonStyle(MainlineSecondaryButtonStyle())
                    Button {
                        showsTemporaryTask = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(MainlineSecondaryButtonStyle())
                    .accessibilityLabel("临时加事")
                }
            } else if store.session?.progress.contains(where: {
                $0.state.isIncomplete && $0.step.role == .task
            }) == true {
                Text("还没有开始任务")
                    .font(.system(.title2, design: .rounded, weight: .bold))
                Text("从下方任务列表选择一项，点击“开始”。")
                    .foregroundStyle(.secondary)
            } else if store.session?.progress.contains(where: {
                $0.state.isIncomplete && $0.step.role == .deadline
            }) == true {
                Text("任务步骤已完成")
                    .font(.system(.title2, design: .rounded, weight: .bold))
                Text("正在整理本次完成结果。")
                    .foregroundStyle(.secondary)
            } else {
                Text("今天的主线完成啦")
                    .font(.title3.bold())
                Button("结束今天流程") { store.finish() }
                    .buttonStyle(MainlinePrimaryButtonStyle())
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .doodleCard(MainlineTheme.sky, cornerRadius: 26)
        .sheet(isPresented: $showsTemporaryTask) {
            TemporaryTaskView()
        }
    }
}

private struct PlanImpactCard: View {
    @EnvironmentObject private var store: RoutineStore
    @State private var showsPlanDetails = false

    var body: some View {
        if let session = store.session {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let estimated = session.estimatedCompletion(at: context.date)
                let isLate = session.isLate(at: context.date)
                let isOverdue = session.targetDeadline.map { context.date > $0 } ?? false

                VStack(alignment: .leading, spacing: 12) {
                    Text("计划影响")
                        .font(.headline)
                    if let target = session.targetDeadline, let estimated {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("预计结束")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(estimated.formatted(date: .omitted, time: .shortened))
                                    .font(.system(.title2, design: .rounded, weight: .bold))
                                    .foregroundStyle(isLate ? .red : .primary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 3) {
                                Text("Deadline")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(target.formatted(date: .omitted, time: .shortened))
                                    .font(.subheadline.monospacedDigit())
                                if isLate {
                                    Text("晚 \(formatMinutes(estimated.timeIntervalSince(target)))")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(.red)
                                } else if estimated < target {
                                    Text("提前 \(formatMinutes(target.timeIntervalSince(estimated)))")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(MainlineTheme.olive)
                                }
                            }
                        }
                    }

                    DisclosureGroup("计划详情", isExpanded: $showsPlanDetails) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("已预留 \(formatMinutes(session.remainingBuffer)) 机动时间")
                            Text("这段时间不参与倒计时，也不会因延误而扣减。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if isOverdue {
                                Text("Deadline 已过，仍会持续提醒")
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                            }
                        }
                        .font(.caption)
                        .padding(.top, 3)
                    }
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .tint(MainlineTheme.ink.opacity(0.65))
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .doodleCard(isLate ? MainlineTheme.coral.opacity(0.28) : MainlineTheme.softSky, cornerRadius: 22)
            }
        }
    }
}

private struct TimelineCard: View {
    @EnvironmentObject private var store: RoutineStore
    @State private var showsReorder = false
    @State private var taskPendingDeletion: StepProgress?

    var body: some View {
        if let session = store.session {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let estimates = session.estimatedDueDates(at: context.date)
                VStack(alignment: .leading, spacing: 13) {
                    HStack {
                        Text("任务列表")
                            .font(.headline)
                        Spacer()
                        if reorderableItems(in: session).count > 1 {
                            Button("调整顺序") { showsReorder = true }
                                .font(.caption.weight(.semibold))
                        }
                    }
                    ForEach(session.progress) { progress in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: icon(for: progress))
                                .foregroundStyle(progress.state == .completed ? MainlineTheme.olive : progress.isTemporary ? MainlineTheme.coral : MainlineTheme.ink.opacity(0.55))
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    Text(progress.step.title)
                                    if progress.state == .active {
                                        Text("当前")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(MainlineTheme.orange)
                                    } else if progress.state == .suspended {
                                        Text("已挂起")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(MainlineTheme.coral)
                                    }
                                    if progress.isTemporary {
                                        Text("临时")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(MainlineTheme.coral)
                                    }
                                }
                                .font(.subheadline.weight(.medium))
                                if progress.state == .completed {
                                    Text(progress.completedAt.map {
                                        "完成于 \($0.formatted(date: .omitted, time: .shortened))"
                                    } ?? "已完成")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                } else {
                                    let estimated = estimates[progress.id] ?? progress.dueAt
                                    HStack(spacing: 10) {
                                        Label(
                                            "计划 \(progress.originalDueAt.formatted(date: .omitted, time: .shortened))",
                                            systemImage: "calendar"
                                        )
                                        Label(
                                            "预计 \(estimated.formatted(date: .omitted, time: .shortened))",
                                            systemImage: "clock.arrow.circlepath"
                                        )
                                        .foregroundStyle(estimated > progress.originalDueAt ? .red : MainlineTheme.olive)
                                    }
                                    .font(.caption2.monospacedDigit())
                                }
                            }
                            Spacer()
                            HStack(spacing: 8) {
                                action(for: progress, in: session)
                                if progress.step.role == .task {
                                    Button(role: .destructive) {
                                        taskPendingDeletion = progress
                                    } label: {
                                        Image(systemName: "trash")
                                            .font(.caption.weight(.semibold))
                                    }
                                    .buttonStyle(.bordered)
                                    .accessibilityLabel("删除本次任务 \(progress.step.title)")
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(rowColor(for: progress), in: RoundedRectangle(cornerRadius: 15))
                        .overlay {
                            RoundedRectangle(cornerRadius: 15)
                                .stroke(MainlineTheme.ink.opacity(0.45), lineWidth: 2)
                        }
                        .opacity(progress.state == .completed ? 0.55 : 1)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .doodleCard(.white.opacity(0.80), cornerRadius: 22)
            }
            .sheet(isPresented: $showsReorder) {
                PendingTaskReorderView(items: reorderableItems(in: session)) { ids in
                    store.reorderPendingTasks(ids: ids)
                }
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
                Button("取消", role: .cancel) {
                    taskPendingDeletion = nil
                }
            } message: { _ in
                Text("只从本次计划中删除，原任务线不会改变。")
            }
        }
    }

    private func reorderableItems(in session: RoutineSession) -> [StepProgress] {
        return session.progress.filter {
            $0.state.isIncomplete
                && $0.step.role == .task
                && $0.id != session.activeProgressID
        }
    }

    @ViewBuilder
    private func action(for progress: StepProgress, in session: RoutineSession) -> some View {
        if progress.step.role == .task,
           progress.state == .pending || progress.state == .suspended {
            Button("开始") {
                store.start(progress)
            }
            .buttonStyle(.borderedProminent)
            .tint(MainlineTheme.orange)
            .font(.caption.bold())
        } else if progress.step.role == .deadline,
                  progress.state.isIncomplete,
                  session.progress
                    .filter({ $0.step.role == .task })
                    .allSatisfy({ !$0.state.isIncomplete }) {
            Button("完成") {
                store.complete(progress)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .font(.caption.bold())
        }
    }

    private func icon(for progress: StepProgress) -> String {
        if progress.state == .completed { return "checkmark.circle.fill" }
        if progress.state == .active { return "target" }
        if progress.state == .suspended { return "pause.circle.fill" }
        if progress.step.role == .deadline { return "flag.checkered" }
        return "circle"
    }

    private func rowColor(for progress: StepProgress) -> Color {
        if progress.state == .active { return MainlineTheme.cream }
        if progress.state == .suspended { return MainlineTheme.coral.opacity(0.13) }
        if progress.step.role == .deadline { return MainlineTheme.cream.opacity(0.78) }
        if progress.isTemporary { return MainlineTheme.coral.opacity(0.16) }
        return MainlineTheme.softCream.opacity(0.76)
    }
}

private struct PendingTaskReorderView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var items: [StepProgress]
    let onSave: ([UUID]) -> Void

    init(items: [StepProgress], onSave: @escaping ([UUID]) -> Void) {
        _items = State(initialValue: items)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            List {
                Section("拖动调整待办顺序") {
                    ForEach(items) { item in
                        HStack {
                            Label(item.step.title, systemImage: item.isTemporary ? "sparkles" : "circle")
                            Spacer()
                            Text(formatMinutes(item.step.duration))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .onMove { source, destination in
                        items.move(fromOffsets: source, toOffset: destination)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(MainlineTheme.canvas)
            .tint(MainlineTheme.orange)
            .environment(\.editMode, .constant(.active))
            .navigationTitle("调整任务顺序")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        onSave(items.map(\.id))
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct RemainingTimeText: View {
    let dueAt: Date
    let now: Date

    var body: some View {
        let seconds = dueAt.timeIntervalSince(now)
        Text(seconds >= 0 ? "还有 \(formatMinutes(seconds, includeSeconds: true))" : "已超时 \(formatMinutes(-seconds, includeSeconds: true))")
            .font(.system(size: 32, weight: .bold, design: .monospaced))
            .foregroundStyle(seconds < 0 ? .red : seconds < 5 * 60 ? MainlineTheme.orange : MainlineTheme.ink)
            .contentTransition(.numericText())
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
                Section("执行方式") {
                    Label("新任务会立即置顶并开始", systemImage: "arrow.up.circle.fill")
                    Text("现在做到一半的任务会自动挂起；临时任务完成后，会自动回到原任务。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section {
                    Text(impactText)
                        .foregroundStyle(impactIsLate ? .red : .secondary)
                } header: {
                    Text("加入前先看影响")
                }
            }
            .scrollContentBackground(.hidden)
            .background(MainlineTheme.canvas)
            .tint(MainlineTheme.orange)
            .navigationTitle("临时加事")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("加入并开始") {
                        store.addTemporaryTask(
                            title: title,
                            minutes: minutes,
                            placement: .now
                        )
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private var impactIsLate: Bool {
        guard let session = store.session else { return false }
        return false
    }

    private var impactText: String {
        guard let session = store.session else { return "" }
        let seconds = TimeInterval(minutes * 60)
        return "会让后续计划整体后移 \(formatMinutes(seconds))。"
    }
}

private struct QuickCreateView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    /// 解析出的任务步骤。改截止时间/重复方式时据此重算模板，避免重新走一遍解析（甚至再请求一次模型）。
    @State private var parsedSteps: [RoutineStep] = []
    @State private var generated: RoutineTemplate?
    @State private var isParsing = false
    /// 截止时间默认关闭：没识别到截止时间时保持关闭态，符合「没写就不设」的预期。
    @State private var hasDeadline = false
    @State private var selectedDeadline = Date()
    @State private var recurrence: RoutineRecurrence = .once
    let onSave: (RoutineTemplate) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $input)
                        .frame(minHeight: 130)
                    Text("例：18点30结束，去厕所5分钟 刷杯子2分钟 买水果10分钟")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Label("也可以点系统键盘的麦克风直接说", systemImage: "mic.fill")
                        .font(.caption)
                        .foregroundStyle(MainlineTheme.orange)
                } header: {
                    Text("写下要做的事")
                } footer: {
                    Text("截止时间可以直接写进去，比如「18点30结束」；生成后也能手动调整。")
                }

                Section("计划设置") {
                    Picker("重复", selection: $recurrence) {
                        ForEach(RoutineRecurrence.allCases, id: \.self) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Button {
                    Task { await generate() }
                } label: {
                    if isParsing && RoutineParsing.current.hasEnhancedPath {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("正在识别…")
                        }
                    } else {
                        Text("生成任务线")
                    }
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isParsing)

                // 截止时间区只在下方的任务线生成成功后出现：先解析、再由用户按识别结果调整，
                // 避免输入框还没解析就摆一个不知道该填什么的选择器。
                if let generated {
                    Section("截止时间") {
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
                            Text("不设置时，进入任务线后由你选择第一项开始正计时。")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Section("预览") {
                        Label(generated.name, systemImage: generated.symbol)
                        LabeledContent("重复", value: generated.effectiveRecurrence.title)
                        LabeledContent(
                            "计时方式",
                            value: generated.mode == .backward ? "按截止时间倒推" : "开始后正计时"
                        )
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
            .scrollContentBackground(.hidden)
            .background(MainlineTheme.canvas)
            .tint(MainlineTheme.orange)
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
            .onChange(of: hasDeadline) { _, _ in rebuild() }
            .onChange(of: selectedDeadline) { _, _ in rebuild() }
            .onChange(of: recurrence) { _, _ in rebuild() }
            .onChange(of: input) { _, _ in
                // 输入变了，上次的生成结果作废，截止时间区随之收回（回到「生成后才显示」的初始态）。
                parsedSteps = []
                generated = nil
            }
        }
    }

    @MainActor
    private func generate() async {
        isParsing = true
        defer { isParsing = false }

        guard let result = await RoutineParsing.current.parse(input) else {
            parsedSteps = []
            generated = nil
            return
        }

        // 模型没给出截止时间时，再用本机规则兜一次（本机只能读「结束18:30」这类锚点在前的写法）。
        let resolvedDeadline = result.deadline ?? QuickRoutineParser.inferredDeadline(from: input)

        parsedSteps = result.steps
        hasDeadline = resolvedDeadline != nil
        if let resolvedDeadline { selectedDeadline = resolvedDeadline }
        rebuild()
    }

    /// 只重算模板，不碰解析结果。改截止时间/重复方式都走这里，避免把已解析的步骤丢掉。
    private func rebuild() {
        generated = QuickRoutineParser.makeTemplate(
            steps: parsedSteps,
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
    if includeSeconds {
        if hours > 0 { return "\(hours) 小时 \(minutes) 分 \(remainingSeconds) 秒" }
        if minutes > 0 { return "\(minutes) 分 \(remainingSeconds) 秒" }
        return "\(remainingSeconds) 秒"
    }
    if hours > 0 && minutes > 0 { return "\(hours) 小时 \(minutes) 分钟" }
    if hours > 0 { return "\(hours) 小时" }
    return "\(minutes) 分钟"
}
