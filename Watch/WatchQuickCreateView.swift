import SwiftUI

/// 手表上的一句话创建。
///
/// 与手机版 `web/src/views/QuickCreateView.vue` 同一条流水线，差别只在呈现：
/// 1. 本机规则把输入拆成步骤（`QuickRoutineParser`）；
/// 2. `ItinerarySplitter` 切出目的地与在该地要做的事；
/// 3. 逐个目的地走高德选点（`CommuteService`），选中后算出通勤时长；
/// 4. 通勤段与活动段按手机版同样的命名组装成模板
///    （通勤项标题 `通勤到X`，活动项标题 `X · 原活动`）。
///
/// **不展示地图** —— 手表上没有地图，选点只给「名称 + 距离」的短列表。
/// 高德 Key 从 `MainlineSettings` 读取（iPhone 填一次，经 WCSession 同步过来）；
/// 没有 Key 时明确提示并保留纯规则创建，绝不假装算出了路线。
struct WatchQuickCreateView: View {
    @EnvironmentObject private var store: RoutineStore
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var hasDeadline = true
    @State private var deadline = Date()
    @State private var recurrence: RoutineRecurrence = .once

    /// 解析出的停留点。为空表示这句话里没有地点，走纯规则创建。
    @State private var stops: [ItinerarySplitter.Stop] = []
    /// 已确认的通勤项（标题 + 路线），按顺序累加。
    @State private var commuteSteps: [RoutineStep] = []
    /// 每个停留点对应的活动步骤，与 `stops` 下标对齐。
    @State private var activitySteps: [[RoutineStep]] = []
    @State private var stopIndex = 0
    @State private var candidates: [CommuteDestination] = []
    @State private var candidateHint = ""
    @State private var selectionTarget: StopSelection?
    @State private var travelMode: TravelMode = .driving
    @State private var busy = false
    @State private var message = ""
    @State private var isLoadingRoute = false

    /// 本机规则解析出的前置准备（刷牙、洗脸这类不涉及地点的事）。
    private var preparation: [RoutineStep] {
        QuickRoutineParser.makeSteps(from: ItinerarySplitter.split(input).preparation)
    }

    /// 整句的扁平解析。没有地点时用它，等价于原「语音创建」行为。
    private var flatSteps: [RoutineStep] {
        QuickRoutineParser.makeSteps(from: input)
    }

    private var canSave: Bool {
        if !stops.isEmpty {
            return stopIndex >= stops.count
        }
        return !flatSteps.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("任务和时长") {
                    TextField("点这里说话", text: $input, axis: .vertical)
                    Text("例如：去凯德逛30分钟，再去宜家待1小时")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                if !stops.isEmpty {
                    Section("识别到 \(stops.count) 个地点") {
                        ForEach(Array(stops.enumerated()), id: \.offset) { index, stop in
                            HStack {
                                Text(stop.query)
                                Spacer()
                                if index < commuteSteps.count,
                                   let seconds = commuteSteps[index].commute?.seconds {
                                    Text(compactDuration(seconds))
                                        .foregroundStyle(.secondary)
                                } else {
                                    Text("待选点")
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                } else if !flatSteps.isEmpty {
                    Section("识别到 \(flatSteps.count) 项") {
                        ForEach(flatSteps) { step in
                            HStack {
                                Text(step.title)
                                Spacer()
                                Text(compactDuration(step.duration))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("出行方式") {
                    Picker("方式", selection: $travelMode) {
                        ForEach(TravelMode.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .onChange(of: travelMode) { _, mode in
                        store.setTravelMode(mode)
                        // 方式变了，已算出的通勤时长就过期了，必须作废重来。
                        resetCommutes()
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
                        DatePicker("截止", selection: $deadline, displayedComponents: .hourAndMinute)
                        Text("按截止时间倒推开始时间")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if !message.isEmpty {
                    Section {
                        Text(message)
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }

                if !stops.isEmpty && stopIndex < stops.count {
                    Section {
                        Button {
                            Task { await pickNextStop() }
                        } label: {
                            if busy {
                                HStack { ProgressView(); Text("正在搜索…") }
                            } else {
                                Label("选择「\(stops[stopIndex].query)」", systemImage: "mappin.and.ellipse")
                            }
                        }
                        .disabled(busy)
                    }
                }

                Button("保存任务线") { save() }
                    .disabled(!canSave)
            }
            .navigationTitle("语音创建")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .onChange(of: input) { _, value in
                if let inferred = QuickRoutineParser.inferredDeadline(from: value) {
                    hasDeadline = true
                    deadline = inferred
                }
                prepareStops()
            }
            .onAppear {
                travelMode = store.settings.mode
                prepareStops()
            }
            // 选点用 sheet 而不是 alert：候选可能十几条，alert 放不下也滚不动。
            .sheet(item: $selectionTarget) { target in
                destinationPicker(target)
            }
        }
    }

    // MARK: - 选点

    private struct StopSelection: Identifiable {
        var id: Int { index }
        var index: Int
        var query: String
        var hint: String
        var candidates: [CommuteDestination]
    }

    /// 重新切分地点。输入变了就把之前的选点结果全部作废 —— 地名改了还用旧路线是错的。
    private func prepareStops() {
        let next = ItinerarySplitter.split(input).stops
        guard next.map(\.query) != stops.map(\.query) else { return }
        stops = next
        resetCommutes()
    }

    private func resetCommutes() {
        commuteSteps = []
        activitySteps = []
        stopIndex = 0
        candidates = []
        selectionTarget = nil
        message = ""
    }

    /// 为第 `stopIndex` 个地点搜候选。搜到就弹选点列表；搜不到就把原因写进 `message`。
    private func pickNextStop() async {
        guard stopIndex < stops.count else { return }

        busy = true
        message = ""
        let stop = stops[stopIndex]
        // 上一段的终点就是这一段的起点；第一段交给定位。
        let origin = commuteSteps.last?.commute?.location
        do {
            let route = try await CommuteService.shared.queryCommute(
                address: stop.query,
                mode: travelMode,
                originLocation: origin
            )
            accept(route: route, stop: stop)
        } catch let error as CommuteError {
            if let found = error.selectionCandidates {
                candidates = found
                candidateHint = error.errorDescription ?? "请选择具体地点。"
                selectionTarget = StopSelection(
                    index: stopIndex,
                    query: stop.query,
                    hint: candidateHint,
                    candidates: found
                )
            } else {
                message = error.errorDescription ?? "搜索失败，请重试。"
            }
        } catch {
            message = "搜索失败，请重试。"
        }
        busy = false
    }

    /// 用户选定具体地点后重算这一段。
    private func confirm(_ destination: CommuteDestination) async {
        guard stopIndex < stops.count else { return }
        let stop = stops[stopIndex]
        let origin = commuteSteps.last?.commute?.location
        isLoadingRoute = true
        do {
            let route = try await CommuteService.shared.queryCommute(
                address: stop.query,
                mode: travelMode,
                selectedDestination: destination,
                originLocation: origin
            )
            accept(route: route, stop: stop)
            selectionTarget = nil
        } catch let error as CommuteError {
            message = error.errorDescription ?? "路线查询失败，请重试。"
        } catch {
            message = "路线查询失败，请重试。"
        }
        isLoadingRoute = false
    }

    /// 接受一段算好的路线，推进到下一个地点。
    private func accept(route: CommuteInfo, stop: ItinerarySplitter.Stop) {
        let commuteStep = RoutineStep(
            title: "通勤到\(route.address)",
            prompt: "现在出发，预计 \(max(1, Int((route.seconds / 60).rounded()))) 分钟到达",
            duration: route.seconds
        )
        var step = commuteStep
        step.commute = route
        commuteSteps.append(step)

        // 与手机版同一套命名：活动项标题前缀地点名，读起来才知道是在哪儿做这件事。
        let tasks = QuickRoutineParser.makeSteps(from: stop.activities)
        let localized = tasks.map { task -> RoutineStep in
            var copy = task
            copy.title = "\(route.address) · \(task.title)"
            return copy
        }
        activitySteps.append(localized.isEmpty
            ? [RoutineStep(title: "\(route.address) · 停留", duration: 10 * 60)]
            : localized)

        stopIndex += 1
        if stopIndex < stops.count {
            // 继续下一个地点：候选搜索仍由用户主动触发，避免一次性发一堆请求。
            message = "已记录，继续选择下一个地点。"
        } else {
            message = "地点都选好了，可以保存。"
        }
    }

    private func destinationPicker(_ target: StopSelection) -> some View {
        NavigationStack {
            List {
                Section {
                    Text(target.hint)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Section("「\(target.query)」的候选地点") {
                    ForEach(target.candidates) { candidate in
                        Button {
                            Task { await confirm(candidate) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.name)
                                    .font(.caption.bold())
                                    .lineLimit(2)
                                if !candidate.distanceText.isEmpty {
                                    Text(candidate.distanceText)
                                        .font(.caption2)
                                        .foregroundStyle(.orange)
                                }
                                if !candidate.address.isEmpty {
                                    Text(candidate.address)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .disabled(isLoadingRoute)
                    }
                }
                if isLoadingRoute {
                    Section { HStack { ProgressView(); Text("正在算路…") } }
                }
            }
            .navigationTitle("确认地点")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("返回") { selectionTarget = nil }
                }
            }
        }
    }

    // MARK: - 保存

    private func save() {
        let steps: [RoutineStep]
        if !stops.isEmpty {
            guard stopIndex >= stops.count else { return }
            // 前置准备在前，随后按「通勤 → 该地活动」交替拼接，顺序即行程顺序。
            // 注意 `[$0.0, $0.1]` 不行：两侧元素类型不同（RoutineStep vs [RoutineStep]），
            // Swift 会按 $0.1 推断成 [[RoutineStep]] 再拒绝 $0.0。必须显式拼接。
            steps = preparation
                + zip(commuteSteps, activitySteps).flatMap { [$0.0] + $0.1 }
        } else {
            steps = flatSteps
        }

        guard let template = QuickRoutineParser.makeTemplate(
            steps: steps,
            deadline: hasDeadline ? deadline : nil,
            recurrence: recurrence
        ) else { return }
        store.addTemplate(template)
        dismiss()
    }

    private func compactDuration(_ duration: TimeInterval) -> String {
        let minutes = max(1, Int((duration / 60).rounded()))
        if minutes < 60 { return "\(minutes) 分" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours) 小时" : "\(hours) 小时 \(remainder) 分"
    }
}
