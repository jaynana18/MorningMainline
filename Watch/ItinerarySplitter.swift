import Foundation

/// 从一句话里切出「目的地」与「在该地要做的事」。
///
/// 这是 `web/src/core/itinerary.ts:splitItinerary` 的 Swift 移植。手机版靠它把
/// 「刷牙3分钟，去凯德逛30分钟，再去宜家待1小时」切成「不动的前置准备」+「按地点成组的停留」，
/// 再逐个地点走高德选点。Watch 侧原本完全没有这一步 —— 一句话创建只会把整句
/// 按「任务名 + 时长」拆成扁平步骤，地点信息直接丢掉。补上它，手表才能像手机一样选地点。
///
/// 纯字符串运算，无网络、无副作用。
enum ItinerarySplitter {
    struct Stop {
        /// 地点名，交给高德搜 POI。
        var query: String
        /// 该地的活动描述（可能是「停留30分钟」这类）。
        var activities: String
    }

    struct Result {
        /// 动身之前做的事（不涉及地点）。
        var preparation: String
        var stops: [Stop]
    }

    /// 地点标记词。与 web 版一致：到达 / 前往 / 赶往 / 去往 / 去 / 到（后面不紧跟数字）/ 在。
    private static let markers = ["到达", "前往", "赶往", "去往", "去", "到", "在"]

    /// 地点名的结束边界：遇到这些词就说明「地点名说完了，后面是活动」。
    private static let boundaries = [
        ",", "，", "。", "；", ";", "\n", "然后", "接着", "之后", "再去", "再到",
        "停留", "待", "呆", "逛", "购物", "买", "吃", "喝", "玩", "办事", "取", "接人", "工作", "开会"
    ]

    static func split(_ input: String) -> Result {
        // 先把中文数字时长归一，`半小时` 也拉平，便于后面的时长识别。
        let text = replacingChineseDurationNumerals(input)
            .replacingOccurrences(of: "半小时", with: "30分钟")
            .replacingOccurrences(of: "半个小时", with: "30分钟")

        var firstMarkerIndex: Int? = nil
        var stops: [Stop] = []
        let matches = markerMatches(in: text)

        for (offset, match) in matches.enumerated() {
            // 「在」如果紧跟在「现」或「正」后面，是「现在」「正在」，不是地点标记。
            if match.keyword == "在" {
                let prefix = String(text[text.index(text.startIndex, offsetBy: max(0, match.range.lowerBound - 1))..<text.index(text.startIndex, offsetBy: match.range.lowerBound)])
                if prefix == "现" || prefix == "正" { continue }
            }

            let contentStart = match.range.upperBound
            let contentEnd = offset + 1 < matches.count ? matches[offset + 1].range.lowerBound : text.count
            guard contentStart <= contentEnd, contentStart <= text.count else { continue }

            let fragment = substring(text, from: contentStart, to: contentEnd)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !fragment.isEmpty else { continue }

            // 过滤掉「到 8 点」「在 18 点」这类其实在说时间的「标记」。
            if startsWithTimeExpression(fragment) { continue }

            let boundaryIndex = firstBoundaryIndex(in: fragment)
            let query = (boundaryIndex < 0 ? fragment : String(fragment.prefix(boundaryIndex)))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { continue }

            if firstMarkerIndex == nil { firstMarkerIndex = match.range.lowerBound }

            var activities = boundaryIndex < 0 ? "" : substring(fragment, from: boundaryIndex, to: fragment.count)
            activities = activities
                .replacingOccurrences(of: "然后", with: "")
                .replacingOccurrences(of: "接着", with: "")
                .replacingOccurrences(of: "之后", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: ",，。；; \t\n"))
            // 纯时长描述补上「停留」二字，读起来才成句。
            let normalized = startsWithDuration(activities) ? "停留\(activities)" : activities
            stops.append(Stop(query: query, activities: normalized))
        }

        let preparation = firstMarkerIndex.map { substring(text, from: 0, to: $0) } ?? text
        return Result(preparation: preparation, stops: stops)
    }

    // MARK: - 匹配

    private struct MarkerMatch {
        var keyword: String
        /// 在**字符**（非 UTF-16 单元）下标空间里的范围。
        var range: Range<Int>
    }

    /// 找出所有地点标记。按最长标记优先：`到达` 必须先于 `到`，否则会把「到达凯德」
    /// 切成「达凯德」。这正是 web 版用正则交替顺序保证的事，Swift 这边手动排序。
    private static func markerMatches(in text: String) -> [MarkerMatch] {
        let characters = Array(text)
        let ordered = markers.sorted { $0.count > $1.count }
        var result: [MarkerMatch] = []
        var index = 0

        while index < characters.count {
            var matched: String?
            for marker in ordered {
                let markerChars = Array(marker)
                guard index + markerChars.count <= characters.count else { continue }
                if Array(characters[index..<(index + markerChars.count)]) == markerChars {
                    matched = marker
                    break
                }
            }
            if let matched {
                result.append(MarkerMatch(keyword: matched, range: index..<(index + matched.count)))
                index += matched.count
            } else {
                index += 1
            }
        }
        return result
    }

    /// 在片段里找「地点名结束」的位置，返回字符下标；找不到返回 -1。
    private static func firstBoundaryIndex(in fragment: String) -> Int {
        let characters = Array(fragment)
        var best = -1
        var index = 0

        while index < characters.count {
            // 时长表达式（如 `30分钟`）也是边界。
            if characters[index].isNumber {
                var probe = index
                while probe < characters.count, characters[probe].isNumber || characters[probe] == "." { probe += 1 }
                let unit = probe < characters.count ? String(characters[probe...].prefix(2)) : ""
                if unit.hasPrefix("分钟") || unit.hasPrefix("小时") {
                    return index
                }
            }
            for boundary in boundaries {
                let boundaryChars = Array(boundary)
                guard index + boundaryChars.count <= characters.count else { continue }
                if Array(characters[index..<(index + boundaryChars.count)]) == boundaryChars {
                    if best < 0 || index < best { best = index }
                }
            }
            if best >= 0 { return best }
            index += 1
        }
        return best
    }

    private static func startsWithTimeExpression(_ text: String) -> Bool {
        text.range(of: "^\\s*\\d+(\\.\\d+)?\\s*(点|:|：)", options: .regularExpression) != nil
    }

    private static func startsWithDuration(_ text: String) -> Bool {
        text.range(of: "^\\d+(\\.\\d+)?\\s*(分钟|小时)", options: .regularExpression) != nil
    }

    // MARK: - 字符串工具

    private static func substring(_ text: String, from start: Int, to end: Int) -> String {
        let characters = Array(text)
        let lower = max(0, min(start, characters.count))
        let upper = max(lower, min(end, characters.count))
        return String(characters[lower..<upper])
    }

    /// 与 `QuickRoutineParser` 同源：只转换紧挨着时长单位的中文数字，
    /// 避免误改地点名里的中文数字（如「去第三个路口」）。
    private static func replacingChineseDurationNumerals(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "([零〇一二三四五六七八九十两]+)\\s*(?:个)?\\s*(小时|分钟|分)") else {
            return text
        }
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard !matches.isEmpty else { return text }

        var result = text
        // 从后往前替换，避免前面的替换改变后面 match 的位置。
        for match in matches.reversed() {
            guard let numeralRange = Range(match.range(at: 1), in: result),
                  let unitRange = Range(match.range(at: 2), in: result),
                  let value = chineseNumber(String(result[numeralRange]))
            else { continue }
            let unit = String(result[unitRange])
            let replacement = "\(value)\(unit)"
            let fullRange = Range(match.range(at: 0), in: result)!
            result.replaceSubrange(fullRange, with: replacement)
        }
        return result
    }

    private static func chineseNumber(_ text: String) -> Int? {
        let digits: [Character: Int] = [
            "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
            "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
        ]
        var total = 0
        var current = 0
        for character in text {
            if let digit = digits[character] {
                current = digit
            } else if character == "十" {
                total += max(1, current) * 10
                current = 0
            } else {
                return nil
            }
        }
        return total + current
    }
}
