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
        .description("显示当前主线任务与倒计时")
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
        .description("显示当前任务、剩余时间与预计完成时间")
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
        // 这里只负责「换任务 / 换预计时间」这类结构性刷新。**倒计时不靠它** ——
        // 秒级数字交给 `Text(timerInterval:)` 由系统自渲染；否则每分钟才刷一次 timeline，
        // 表盘上的剩余时间最多会陈旧 60 秒（看起来像卡住不动）。
        let next = Calendar.current.date(byAdding: .minute, value: 1, to: now) ?? now
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

/// 系统自渲染的倒计时。
///
/// `Text(timerInterval:countsDown:)` 由系统逐秒更新，不消耗 timeline 预算 ——
/// 这是表盘能显示「实时剩余时间」而不被 60 秒刷新率卡住的唯一做法。
/// 已过期时区间非法（起点晚于终点会崩溃），故回落到静态的「已超时」。
private struct ComplicationCountdown: View {
    let dueAt: Date
    let now: Date
    var font: Font

    var body: some View {
        if dueAt > now {
            Text(timerInterval: now...dueAt, countsDown: true)
                .font(font)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        } else {
            Text("已超时")
                .font(font)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
                .foregroundStyle(.red)
        }
    }
}

struct MainlineComplicationCornerView: View {
    let entry: MainlineWidgetEntry

    var body: some View {
        if entry.hasActiveSession, let title = entry.currentTitle {
            Text(title)
                .font(.system(size: 9, weight: .bold))
                .lineLimit(1)
                .widgetLabel {
                    if let due = entry.currentDueAt, due > entry.date {
                        // 角落槽位由系统渲染倒计时，这里只给区间。
                        Text(timerInterval: entry.date...due, countsDown: true)
                    } else if entry.currentDueAt != nil {
                        Text("已超时")
                    } else if let estimated = entry.estimatedCompletion {
                        Text("预计 \(estimated.formatted(date: .omitted, time: .shortened))")
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
                if let due = entry.currentDueAt {
                    // 圆槽位空间小，倒计时只到分秒：`1:05` 比 `1分5秒` 省一半宽度。
                    ComplicationCountdown(
                        dueAt: due,
                        now: entry.date,
                        font: .system(size: 11, weight: .semibold, design: .rounded)
                    )
                } else if entry.delayDuration > 0 {
                    Text("晚\(compactDelay(entry.delayDuration))")
                        .font(.system(size: 8, weight: .bold, design: .rounded))
                        .foregroundStyle(.red)
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

                // 剩余时间：系统实时倒数，不再等 timeline 刷新。
                if let due = entry.currentDueAt {
                    HStack(spacing: 4) {
                        Text("还剩")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                        ComplicationCountdown(
                            dueAt: due,
                            now: entry.date,
                            font: .system(size: 12, weight: .semibold, design: .rounded)
                        )
                        // 两个分支必须同类型：`.primary` 是 HierarchicalShapeStyle，
                        // `.red` 是 Color，写成裸 `.primary : .red` 会让编译器无法统一而报错。
                        // 显式写 Color.primary / Color.red 才推得出来。
                        .foregroundStyle(due > entry.date ? Color.primary : Color.red)
                    }
                } else if entry.delayDuration > 0 {
                    Text("已延误 \(short(entry.delayDuration))")
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(.red)
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
