import Foundation

/// 出行方式。直接对应高德 **Web 服务** `direction/{mode}` 的路径段。
///
/// 用 REST 而非官方 SDK 的原因：高德 iOS SDK（AMapSearchKit / AMapFoundation）**不支持 watchOS**，
/// 而 REST 接口是纯 HTTP GET，watchOS 的 `URLSession` 直接可用。
/// `web/src/platform/commute.ts` 走的也是同一套 REST 接口，因此两端行为天然一致。
enum TravelMode: String, CaseIterable, Sendable {
    case driving
    case walking
    case transit

    var title: String {
        switch self {
        case .driving: "开车"
        case .walking: "步行"
        case .transit: "公交 / 地铁"
        }
    }
}

/// 高德 POI 搜索出的目的地候选。字段是「算路所需的最小集」。
///
/// 刻意不叫 `CommuteDestination` 之外的任何名字，也不用完整 POI 模型 ——
/// Watch 上只需要「名称 + 地址 + 坐标 + 城市码」就能把路线算出来。
struct CommuteDestination: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var address: String
    /// 高德坐标字符串 `经度,纬度`（GCJ-02）。
    var location: String
    var citycode: String
    /// 距出发地的直线距离（米）。定位不可用、或搜索走的是按名称路径时为 nil。
    var distanceMeters: Int?

    /// 距离的可读文案；无距离时返回空串（Watch 上直接不显示这一行）。
    var distanceText: String {
        guard let distanceMeters else { return "" }
        return distanceMeters < 1000
            ? "\(distanceMeters) 米"
            : String(format: "%.1f 公里", Double(distanceMeters) / 1000)
    }

    static func == (lhs: CommuteDestination, rhs: CommuteDestination) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// 通勤查询失败。文案与 `web/src/platform/commute.ts` 逐条对应，
/// 保证同一个错误在手机和手表上说同一句话。
enum CommuteError: LocalizedError {
    /// 没有可用的高德 Key（开发者配置未注入 / 尚未从手机同步到手表）。
    case missingKey
    /// 没填目的地。
    case missingDestination
    /// 出发地拿不到（定位失败 / 被拒 / 超时），无法算路。
    case originRequired(String)
    /// 搜到了多个候选，必须由用户选定一个具体地点后才能算路。
    case selectionRequired([CommuteDestination], String)
    /// 其余带文案的失败（服务报错、无候选、无可用路线……）。
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .missingKey: "地图服务还没就绪，暂时无法查询通勤。"
        case .missingDestination: "请填写目的地。"
        case .originRequired(let message): message
        case .selectionRequired(_, let message): message
        case .failed(let message): message
        }
    }

    /// 需要用户挑地点时，把候选带出来给 UI。
    var selectionCandidates: [CommuteDestination]? {
        if case .selectionRequired(let candidates, _) = self { return candidates }
        return nil
    }
}

/// 高德 Web 服务通勤查询。
///
/// 逐条移植 `web/src/platform/commute.ts` 的 `queryCommute`，包括
/// 「先搜出发地附近的同名地点 → 再按名称搜 → 最后兜底附近 POI」的三段式候选策略，
/// 以及「公交方案里只画服务返回的真实折线，不用直线冒充路线」的做法。
///
/// 两点刻意的差异化（Watch 特有）：
/// - **不生成地图 URL**。Watch 不展示地图，静态地图接口对它没有意义；
///   iPhone 侧的地图仍由 web 层的 `commuteMapURL` 负责。
/// - 候选排序沿用同一套 Haversine 直线距离，但文案不变 —— 直线距离不能冒充实际路程。
actor CommuteService {
    static let shared = CommuteService()

    /// 出发地缓存。定位是昂贵操作，同一分钟内多次算路复用同一次结果。
    /// 与 web 版一样只缓存 60 秒，且**不落盘**。
    private var cachedOrigin: (location: String, capturedAt: Date)?

    /// 查询通勤路线。
    ///
    /// - Parameters:
    ///   - key: 高德 Web 服务 Key（不持久化）。
    ///   - address: 目的地名称或地址。
    ///   - mode: 出行方式。
    ///   - selectedDestination: 已选定的具体地点。**传了它就跳过选点、直接按坐标算路** ——
    ///     这是排程重算能只做一次网络请求的关键。
    ///   - originLocation: 已知出发地坐标（如上一段通勤的终点），传了就跳过定位。
    /// - Throws: `CommuteError`。其中 `.selectionRequired` 需要 UI 让用户挑地点后重试。
    func queryCommute(
        key rawKey: String,
        address: String,
        mode: TravelMode,
        selectedDestination: CommuteDestination? = nil,
        originLocation: String? = nil
    ) async throws -> CommuteInfo {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw CommuteError.missingKey }
        let query = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { throw CommuteError.missingDestination }

        let origin = try await resolveOrigin(
            key: key,
            selectedDestination: selectedDestination,
            originLocation: originLocation
        )

        // 城市码用于公交方案与按名称搜索；解析失败只是降级，不该中断整个流程。
        var city = ""
        if !origin.isEmpty,
           let start = try? await request("geocode/regeo", params: ["location": origin], key: key) {
            city = Self.cityCode(from: start)
        }

        guard let destination = selectedDestination else {
            let outcome = try await searchDestinations(query: query, origin: origin, city: city, key: key)
            guard !outcome.candidates.isEmpty else {
                throw CommuteError.failed("没有找到可选择的地点。请返回修改原句，补充城市或门店名称后再生成。")
            }
            let message: String
            if outcome.usedNearbyFallback && !origin.isEmpty {
                message = "没有找到「\(query)」的准确匹配，以下是出发地附近的地点，请确认是否有你要去的位置；没有的话请返回修改原句。"
            } else if !origin.isEmpty {
                message = "已按距出发地的远近排序，请选择具体地点（距离为直线距离）。"
            } else {
                message = "未获取到当前位置，已按名称搜索。请选择具体地点。"
            }
            throw CommuteError.selectionRequired(outcome.candidates, message)
        }

        return try await route(
            origin: origin,
            destination: destination,
            city: city,
            mode: mode,
            key: key
        )
    }

    // MARK: - 出发地

    /// 出发地三级回落：显式传入 → 60 秒缓存 → 现场定位（GPS 需转高德坐标系）。
    ///
    /// 定位失败时是否中断，取决于此刻在做什么：**正在算路就必须有出发地**（抛错），
    /// 而只是搜地点则可以先按名称搜下去 —— 这一点与 web 版行为一致。
    private func resolveOrigin(
        key: String,
        selectedDestination: CommuteDestination?,
        originLocation: String?
    ) async throws -> String {
        var origin = originLocation ?? ""
        if origin.isEmpty,
           let cached = cachedOrigin,
           Date().timeIntervalSince(cached.capturedAt) < 60 {
            origin = cached.location
        }
        guard origin.isEmpty else { return origin }

        do {
            let gps = try await LocationProvider.shared.gpsString()
            let converted = try await request(
                "assistant/coordinate/convert",
                params: ["locations": gps, "coordsys": "gps"],
                key: key
            )
            guard let location = converted["locations"] as? String, !location.isEmpty else {
                throw CommuteError.originRequired("无法获取当前位置，请选择出发地。")
            }
            origin = location
            cachedOrigin = (location, Date())
            return origin
        } catch {
            // 搜地点可以在定位失败后继续；真正算路程仍必须有出发地。
            guard selectedDestination != nil else { return "" }
            if let commuteError = error as? CommuteError { throw commuteError }
            throw CommuteError.originRequired("无法获取当前位置，请选择出发地。")
        }
    }

    // MARK: - 目的地候选

    private func searchDestinations(
        query: String,
        origin: String,
        city: String,
        key: String
    ) async throws -> (candidates: [CommuteDestination], usedNearbyFallback: Bool) {
        // 地标、商场简称走 POI 搜索，不当作结构化门牌地址；不擅自选择首个结果。
        var pois: [[String: Any]] = []
        if !origin.isEmpty {
            let around = try await request(
                "place/around",
                params: [
                    "keywords": query, "location": origin, "radius": "10000",
                    "sortrule": "distance", "offset": "20", "page": "1", "extensions": "base"
                ],
                key: key
            )
            pois = around["pois"] as? [[String: Any]] ?? []
        }
        if pois.isEmpty {
            let text = try await request(
                "place/text",
                params: ["keywords": query, "city": city, "offset": "20", "page": "1", "extensions": "base"],
                key: key
            )
            pois = text["pois"] as? [[String: Any]] ?? []
        }
        var usedNearbyFallback = false
        if pois.isEmpty && !origin.isEmpty {
            usedNearbyFallback = true
            let nearby = try await request(
                "place/around",
                params: [
                    "location": origin, "radius": "3000",
                    "sortrule": "distance", "offset": "20", "page": "1", "extensions": "base"
                ],
                key: key
            )
            pois = nearby["pois"] as? [[String: Any]] ?? []
        }

        var candidates: [CommuteDestination] = pois.compactMap { poi in
            guard let location = poi["location"] as? String,
                  Self.isValidCoordinate(location)
            else { return nil }
            let address = ["pname", "cityname", "adname", "address"]
                .compactMap { poi[$0] as? String }
                .filter { !$0.isEmpty }
                .joined()
            return CommuteDestination(
                id: poi["id"] as? String ?? location,
                name: poi["name"] as? String ?? "未命名地点",
                address: address,
                location: location,
                citycode: poi["citycode"] as? String ?? city,
                distanceMeters: nil
            )
        }

        if !origin.isEmpty, let originPoint = Self.point(from: origin) {
            for index in candidates.indices {
                guard let target = Self.point(from: candidates[index].location) else { continue }
                candidates[index].distanceMeters = Self.straightDistance(from: originPoint, to: target)
            }
            candidates.sort { ($0.distanceMeters ?? .max) < ($1.distanceMeters ?? .max) }
        }
        return (candidates, usedNearbyFallback)
    }

    // MARK: - 算路

    private func route(
        origin: String,
        destination: CommuteDestination,
        city: String,
        mode: TravelMode,
        key: String
    ) async throws -> CommuteInfo {
        var params: [String: String] = ["origin": origin, "destination": destination.location]
        if mode == .transit {
            params["city"] = city
            params["cityd"] = destination.citycode.isEmpty ? city : destination.citycode
        }
        let body = try await request(
            mode == .transit ? "direction/transit/integrated" : "direction/\(mode.rawValue)",
            params: params,
            key: key
        )

        let route = body["route"] as? [String: Any]
        let rawPaths = (mode == .transit ? route?["transits"] : route?["paths"]) as? [[String: Any]] ?? []
        let available = rawPaths
            .compactMap { path -> (path: [String: Any], duration: Double)? in
                guard let duration = Self.number(path["duration"]), duration > 0 else { return nil }
                return (path, duration)
            }
            .sorted { $0.duration < $1.duration }

        guard let selected = available.first else {
            throw CommuteError.failed("没有找到可用路线，请检查目的地或切换交通方式。")
        }

        // 公交方案包含步行、公交和铁路段；只画服务返回的真实折线，不用直线冒充路线。
        var lines: [String] = []
        Self.collectPolylines(
            from: mode == .transit ? selected.path["segments"] : selected.path["steps"],
            into: &lines
        )
        let points = lines
            .flatMap { $0.split(separator: ";").map(String.init) }
            .filter(Self.isValidCoordinate)
        // 缩略图抽样，控制长度，保留路线首尾。
        let step = max(1, Int(ceil(Double(points.count) / 60.0)))
        let sampled = points.enumerated()
            .filter { index, _ in index % step == 0 || index == points.count - 1 }
            .map(\.element)

        return CommuteInfo(
            address: destination.name,
            location: destination.location,
            origin: origin,
            mode: mode.rawValue,
            // 与 web 版一致：向上取整到整分钟，避免出现「27.4 分钟」这种排程毛刺。
            seconds: (selected.duration / 60).rounded(.up) * 60,
            polyline: sampled.joined(separator: ";")
        )
    }

    // MARK: - HTTP

    private func request(
        _ path: String,
        params: [String: String],
        key: String
    ) async throws -> [String: Any] {
        var components = URLComponents(string: "https://restapi.amap.com/v3/\(path)")
        components?.queryItems = [URLQueryItem(name: "key", value: key)]
            + params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = components?.url else {
            throw CommuteError.failed("路线服务地址无效。")
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 15

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw CommuteError.failed("路线服务暂时不可用，请稍后重试。")
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CommuteError.failed("路线服务暂时不可用，请稍后重试。")
        }
        guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw CommuteError.failed("路线服务返回了无法解析的数据。")
        }
        guard body["status"] as? String == "1" else {
            throw CommuteError.failed(Self.failureMessage(path: path, body: body))
        }
        return body
    }

    /// 把高德的 `info` / `infocode` 翻成「哪一步失败了」——高德对不同接口给的信息很含糊，
    /// 不指明阶段的话用户只看到一句英文错误码，无从下手。
    private static func failureMessage(path: String, body: [String: Any]) -> String {
        let stage: String
        if path.hasPrefix("place/") {
            stage = "目的地搜索"
        } else if path.hasPrefix("direction/") {
            stage = "路线查询"
        } else if path == "geocode/regeo" {
            stage = "当前位置解析"
        } else {
            stage = "坐标转换"
        }
        let info = body["info"] as? String ?? "请检查 Key 和服务权限"
        let code = body["infocode"] as? String ?? "未知错误码"
        return "高德\(stage)失败：\(info)（\(code)）"
    }

    // MARK: - 纯工具

    private static func cityCode(from body: [String: Any]) -> String {
        let regeocode = body["regeocode"] as? [String: Any]
        let component = regeocode?["addressComponent"] as? [String: Any]
        return component?["citycode"] as? String ?? ""
    }

    /// 递归收集所有 `polyline` 字段。遇到 `buslines` 只取第一段 —— 与 web 版一致，
    /// 公交方案的首选线路才代表实际要走的那条。
    private static func collectPolylines(from value: Any?, into lines: inout [String]) {
        guard let value else { return }
        if let dictionary = value as? [String: Any] {
            for (name, child) in dictionary {
                if name == "polyline", let text = child as? String {
                    lines.append(text)
                } else if name == "buslines", let array = child as? [Any] {
                    collectPolylines(from: array.first, into: &lines)
                } else {
                    collectPolylines(from: child, into: &lines)
                }
            }
        } else if let array = value as? [Any] {
            for child in array { collectPolylines(from: child, into: &lines) }
        }
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private static func isValidCoordinate(_ text: String) -> Bool {
        text.range(of: "^-?\\d+(\\.\\d+)?,\\s*-?\\d+(\\.\\d+)?$", options: .regularExpression) != nil
    }

    private static func point(from location: String) -> (longitude: Double, latitude: Double)? {
        let parts = location.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count == 2, let longitude = Double(parts[0]), let latitude = Double(parts[1]) else { return nil }
        return (longitude, latitude)
    }

    /// 直线距离（米）。**只用于给候选排序**，绝不当作实际路程写进 `CommuteInfo.seconds`。
    private static func straightDistance(
        from start: (longitude: Double, latitude: Double),
        to end: (longitude: Double, latitude: Double)
    ) -> Int {
        let radius = 6_371_000.0
        let rad = Double.pi / 180
        let a = pow(sin((end.latitude - start.latitude) * rad / 2), 2)
            + cos(start.latitude * rad) * cos(end.latitude * rad)
            * pow(sin((end.longitude - start.longitude) * rad / 2), 2)
        return Int((radius * 2 * asin(sqrt(min(1, a)))).rounded())
    }
}
