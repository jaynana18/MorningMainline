import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        NavigationStack {
            Group {
                if horizontalSizeClass == .regular {
                    HStack(spacing: 28) {
                        heroPanel
                            .frame(maxWidth: 420)
                        stepsPanel
                    }
                    .padding(32)
                } else {
                    ScrollView {
                        VStack(spacing: 22) {
                            heroPanel
                            stepsPanel
                        }
                        .padding()
                    }
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("早上主线")
        }
    }

    private var heroPanel: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("今日 Boss")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("8:35 前出门")
                .font(.system(size: 38, weight: .bold, design: .rounded))
            Text("早上的大脑不用做决定，只需要跟着当前任务走。")
                .foregroundStyle(.secondary)

            if store.session?.state == .running {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    deadlineView(now: context.date)
                }
                Button("结束今天流程") { store.finish() }
                    .buttonStyle(.bordered)
            } else {
                Button {
                    store.startToday()
                } label: {
                    Label("开始今天", systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 28))
    }

    private func deadlineView(now: Date) -> some View {
        let deadline = Calendar.current.date(bySettingHour: 8, minute: 35, second: 0, of: now) ?? now
        let seconds = Int(deadline.timeIntervalSince(now))
        let color: Color = seconds <= 10 * 60 ? .red : seconds <= 20 * 60 ? .orange : .green

        return VStack(alignment: .leading, spacing: 6) {
            Text(seconds >= 0 ? "距离出门" : "已经超过出门时间")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(seconds >= 0 ? Duration.seconds(seconds).formatted(.time(pattern: .minuteSecond)) : "立即出门")
                .font(.system(size: 34, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
        }
    }

    private var stepsPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("当前流程")
                    .font(.title2.bold())
                Spacer()
                if let session = store.session {
                    Text(session.primaryDevice == store.deviceRole ? "本机提醒" : "同步查看")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(store.snapshot.template.steps) { step in
                stepRow(step)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(.background, in: RoundedRectangle(cornerRadius: 28))
    }

    @ViewBuilder
    private func stepRow(_ step: RoutineStep) -> some View {
        let progress = store.session?.progress(for: step)
        HStack(spacing: 14) {
            Image(systemName: progress?.state == .completed ? "checkmark.circle.fill" : "circle")
                .font(.title2)
                .foregroundStyle(progress?.state == .completed ? .green : step.importance == .hardDeadline ? .red : .secondary)

            VStack(alignment: .leading, spacing: 3) {
                Text(step.title).font(.headline)
                Text(progress?.dueAt.formatted(date: .omitted, time: .shortened) ?? timingLabel(step.timing))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if progress?.state == .pending {
                Button("延后") { store.snooze(step) }
                    .buttonStyle(.borderless)
                    .disabled((progress?.snoozeCount ?? 0) >= step.maxSnoozeCount)
                Button("完成") { store.complete(step) }
                    .buttonStyle(.borderedProminent)
                    .tint(step.importance == .hardDeadline ? .red : .orange)
            }
        }
        .padding(.vertical, 6)
    }

    private func timingLabel(_ timing: StepTiming) -> String {
        switch timing {
        case .relative(let seconds): "开始后 \(Int(seconds / 60)) 分钟"
        case .absolute(let hour, let minute): String(format: "%02d:%02d", hour, minute)
        }
    }
}

