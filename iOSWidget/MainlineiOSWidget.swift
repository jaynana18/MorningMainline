import SwiftUI
import WidgetKit

struct MainlineiOSWidget: Widget {
    let kind = "MainlineiOSWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: iOSWidgetTimelineProvider()) { entry in
            MainlineWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("不跑偏")
        .description("显示当前主线任务、倒计时与预计完成时间")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct iOSWidgetTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> MainlineWidgetEntry {
        .placeholder()
    }

    func getSnapshot(in context: Context, completion: @escaping (MainlineWidgetEntry) -> Void) {
        completion(MainlineWidgetProvider.entry(for: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MainlineWidgetEntry>) -> Void) {
        let now = Date()
        let entry = MainlineWidgetProvider.entry(for: now)
        let next = Calendar.current.date(byAdding: .minute, value: 1, to: now) ?? now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

struct MainlineWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MainlineWidgetEntry

    var body: some View {
        switch family {
        case .systemMedium:
            mediumView
        default:
            smallView
        }
    }

    private var smallView: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "flag.checkered")
                    .foregroundStyle(entry.hasActiveSession ? .orange : .secondary)
                Spacer()
                if let name = entry.sessionName {
                    Text(name)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if entry.hasActiveSession, let title = entry.currentTitle {
                Text(title)
                    .font(.headline.weight(.bold))
                    .lineLimit(2)
                if entry.delayDuration > 0 {
                    Text("已延误 \(short(entry.delayDuration))")
                        .font(.system(.caption, design: .rounded).weight(.bold))
                        .foregroundStyle(.red)
                } else if let due = entry.currentDueAt {
                    Text("还剩 \(short(due.timeIntervalSince(entry.date)))")
                        .font(.system(.caption, design: .rounded).weight(.semibold))
                        .foregroundStyle(entry.isHardDeadline ? .red : .secondary)
                }
                if let estimated = entry.estimatedCompletion {
                    Text("预计 \(estimated.formatted(date: .omitted, time: .shortened)) 完成")
                        .font(.caption2)
                        .foregroundStyle(entry.isLate ? .red : .secondary)
                }
            } else if entry.hasActiveSession {
                Text("尚未开始任务")
                    .font(.headline.weight(.bold))
                Text("请选择一项开始")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("不跑偏")
                    .font(.headline.weight(.bold))
                Text("暂无进行中的任务线")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var mediumView: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "flag.checkered")
                        .foregroundStyle(entry.hasActiveSession ? .orange : .secondary)
                    Text(entry.sessionName ?? "不跑偏")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                if entry.hasActiveSession, let title = entry.currentTitle {
                    Text(title)
                        .font(.title3.weight(.bold))
                        .lineLimit(2)
                    if entry.delayDuration > 0 {
                        Text("已延误 \(short(entry.delayDuration))")
                            .font(.system(.subheadline, design: .rounded).weight(.bold))
                            .foregroundStyle(.red)
                    } else if let due = entry.currentDueAt {
                        Text("还剩 \(short(due.timeIntervalSince(entry.date)))")
                            .font(.system(.subheadline, design: .rounded).weight(.semibold))
                            .foregroundStyle(entry.isHardDeadline ? .red : .secondary)
                    }
                } else if entry.hasActiveSession {
                    Text("尚未开始任务")
                        .font(.title3.weight(.bold))
                    Text("打开不跑偏并选择一项开始")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("不跑偏")
                        .font(.title3.weight(.bold))
                    Text("暂无进行中的任务线")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if entry.hasActiveSession, let estimated = entry.estimatedCompletion {
                VStack(spacing: 3) {
                    Text("预计完成")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(estimated.formatted(date: .omitted, time: .shortened))
                        .font(.system(.title3, design: .rounded).weight(.bold))
                        .foregroundStyle(entry.isLate ? .red : .primary)
                }
            }
        }
    }

    private func short(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval.rounded()))
        let minutes = total / 60
        let seconds = total % 60
        return minutes > 0 ? "\(minutes)分\(seconds)秒" : "\(seconds)秒"
    }
}
