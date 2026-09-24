import SwiftUI
import WidgetKit

// MARK: - 表盘复杂功能 Complication

/// 表盘角落/模块化复杂功能：显示当前任务标题 + 倒计时。
struct MainlineCornerComplication: Widget {
    let kind = "MainlineCornerComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WatchTimelineProvider()) { entry in
            MainlineComplicationCornerView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("不跑偏")
        .description("显示当前主线任务与倒计时")
        .supportedFamilies([.accessoryCorner, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

/// 圆形表盘复杂功能。
struct MainlineCircularComplication: Widget {
    let kind = "MainlineCircularComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WatchTimelineProvider()) { entry in
            MainlineComplicationCircularView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("不跑偏 · 圆形")
        .description("显示当前主线任务倒计时")
        .supportedFamilies([.accessoryCircular])
    }
}

/// 矩形表盘复杂功能（模块化大槽位）。
struct MainlineRectangularComplication: Widget {
    let kind = "MainlineRectangularComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WatchTimelineProvider()) { entry in
            MainlineComplicationRectangularView(entry: entry)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("不跑偏 · 矩形")
        .description("显示当前任务、倒计时与预计完成时间")
        .supportedFamilies([.accessoryRectangular])
    }
}

// MARK: - Provider

struct WatchTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> MainlineWidgetEntry {
        .placeholder()
    }

    func getSnapshot(in context: Context, completion: @escaping (MainlineWidgetEntry) -> Void) {
        completion(MainlineWidgetProvider.entry(for: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MainlineWidgetEntry>) -> Void) {
        let now = Date()
        let entry = MainlineWidgetProvider.entry(for: now)
        // 每分钟刷新一次，保持倒计时/预计时间近似实时。
        let next = Calendar.current.date(byAdding: .minute, value: 1, to: now) ?? now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

struct MainlineComplicationCornerView: View {
    let entry: MainlineWidgetEntry

    var body: some View {
        if entry.hasActiveSession, let title = entry.currentTitle {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .lineLimit(1)
                .widgetLabel {
                    if let estimated = entry.estimatedCompletion, entry.delayDuration > 0 {
                        Text("预计 \(estimated.formatted(date: .omitted, time: .shortened)) · 晚 \(compactDelay(entry.delayDuration))")
                    } else if let estimated = entry.estimatedCompletion {
                        Text("预计 \(estimated.formatted(date: .omitted, time: .shortened)) · 未延误")
                    } else if let due = entry.currentDueAt {
                        Text(short(due.timeIntervalSince(entry.date)))
                    } else {
                        Text("进行中")
                    }
                }
        } else if entry.hasActiveSession {
            Text("选任务")
                .font(.system(size: 9, weight: .bold))
                .widgetLabel { Text("等待开始") }
        } else {
            Text("不跑偏")
                .font(.system(size: 9, weight: .bold))
                .widgetLabel { Text("暂无任务线") }
        }
    }
}

struct MainlineComplicationCircularView: View {
    let entry: MainlineWidgetEntry

    var body: some View {
        if entry.hasActiveSession, let title = entry.currentTitle {
            VStack(spacing: 0) {
                Text(title)
                    .font(.system(size: 9, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                if let estimated = entry.estimatedCompletion {
                    Text("预计\(estimated.formatted(date: .omitted, time: .shortened))")
                        .font(.system(size: 7, weight: .semibold, design: .rounded))
                        .minimumScaleFactor(0.65)
                }
                if entry.delayDuration > 0 {
                    Text("晚\(compactDelay(entry.delayDuration))")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .foregroundStyle(.red)
                } else {
                    Text("未延误")
                        .font(.system(size: 7, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
        } else if entry.hasActiveSession {
            VStack(spacing: 0) {
                Text("选任务")
                    .font(.system(size: 9, weight: .bold))
                Text("开始")
                    .font(.system(size: 9))
            }
        } else {
            Image(systemName: "flag.checkered")
                .widgetLabel { Text("不跑偏") }
        }
    }
}

struct MainlineComplicationRectangularView: View {
    let entry: MainlineWidgetEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if entry.hasActiveSession, let title = entry.currentTitle {
                Text(title)
                    .font(.system(size: 12, weight: .bold))
                    .lineLimit(1)
                if entry.delayDuration > 0 {
                    Text("已延误 \(short(entry.delayDuration))")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.red)
                } else if let due = entry.currentDueAt {
                    Text("还剩 \(short(due.timeIntervalSince(entry.date)))")
                        .font(.system(size: 11, design: .rounded))
                        .foregroundStyle(entry.isHardDeadline ? .red : .secondary)
                }
                if let estimated = entry.estimatedCompletion {
                    Text("预计 \(estimated.formatted(date: .omitted, time: .shortened)) 完成")
                        .font(.system(size: 10))
                        .foregroundStyle(entry.isLate ? .red : .secondary)
                }
            } else if entry.hasActiveSession {
                Text("尚未开始任务")
                    .font(.system(size: 12, weight: .bold))
                Text("请打开不跑偏并选择一项开始")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            } else {
                Text("不跑偏")
                    .font(.system(size: 12, weight: .bold))
                Text("暂无进行中的任务线")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private func short(_ interval: TimeInterval) -> String {
    let total = max(0, Int(interval.rounded()))
    let minutes = total / 60
    let seconds = total % 60
    return minutes > 0 ? "\(minutes)分\(seconds)秒" : "\(seconds)秒"
}

private func compactDelay(_ interval: TimeInterval) -> String {
    let total = max(0, Int(interval.rounded()))
    if total < 60 { return "\(total)秒" }
    return "\(max(1, total / 60))分"
}
