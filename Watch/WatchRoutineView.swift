import SwiftUI

struct WatchRoutineView: View {
    @EnvironmentObject private var store: RoutineStore

    var body: some View {
        if store.session?.state == .running {
            activeView
        } else {
            startView
        }
    }

    private var startView: some View {
        VStack(spacing: 12) {
            Text("🎯")
                .font(.system(size: 36))
            Text("早上主线")
                .font(.headline)
            Text("今日 Boss：8:35 出门")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("开始今天") {
                store.startToday()
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
        }
    }

    private var activeView: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let step = store.currentStep,
                   let progress = store.session?.progress(for: step) {
                    Text(step.importance == .hardDeadline ? "🚨 硬节点" : "当前主线")
                        .font(.caption2)
                        .foregroundStyle(step.importance == .hardDeadline ? .red : .orange)
                    Text(step.title)
                        .font(.title3.bold())
                    Text(step.prompt)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                    Text(progress.dueAt, style: .timer)
                        .font(.system(.title3, design: .monospaced, weight: .bold))

                    Button("开始了 / 完成") {
                        store.complete(step)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(step.importance == .hardDeadline ? .red : .orange)

                    Button("2分钟后再提醒") {
                        store.snooze(step)
                    }
                    .disabled(progress.snoozeCount >= step.maxSnoozeCount)
                } else {
                    Text("今天的主线完成啦")
                    Button("结束") { store.finish() }
                }
            }
        }
    }
}

