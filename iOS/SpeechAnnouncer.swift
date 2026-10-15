import AVFoundation
import OSLog

/// 应用内语音播报（TTS）。
///
/// **为什么需要自己念，而不是用系统的「播报通知」**：
/// iOS 的「播报通知」（设置 → Siri 与搜索 → 播报通知）是**系统级 Siri 功能**，
/// 只在 iPhone **锁屏 / 熄屏**时生效。用户亮屏使用中，系统认为「你在看屏幕」，
/// 一律不念 —— 这是系统行为，App 无法通过任何 API 改变，也不是本工程的 bug。
///
/// 要做到「亮屏也播报、且能播到耳机」，唯一可行的路径是 App 自己合成语音
/// （`AVSpeechSynthesizer`）。本类即是这条路径的唯一实现。
///
/// **音频会话配置为什么是这一组**（导航类播报 App 的通行做法）：
/// - `category = .playback`：不受静音开关影响。提醒是「必须听见」的内容，
///   若用 `.ambient`，用户一拨静音键就彻底哑了。
/// - `mode = .spokenAudio`：专为语音设计，系统会按输出设备优化语音清晰度。
/// - `.duckOthers`：念的时候把用户的音乐/播客压低，而不是掐断；念完恢复。
/// - `.interruptSpokenAudioAndMixWithOthers`：若后台正在放有声书/播客这类**语音**内容，
///   直接打断（压低一段念白和另一段语音叠在一起是听不清的）。
/// - `.allowBluetoothA2DP`：**耳机路由的关键**。没有它，AirPods 可能被当作
///   免提（HFP）通道而音质极差，或干脆仍走扬声器。
///
/// **激活与停用必须成对**：漏掉 `setActive(false)` 会让用户的音乐一直被压着，
/// 用户会以为播放器坏了。故播完（或被打断）立即释放。
@MainActor
final class SpeechAnnouncer: NSObject {
    static let shared = SpeechAnnouncer()

    private let synthesizer = AVSpeechSynthesizer()
    /// 当前是否已为本轮播报激活了音频会话。用于保证 setActive 成对出现。
    private var sessionActive = false

    private static let log = Logger(subsystem: "com.jaynana.MorningMainline", category: "SpeechAnnouncer")

    private override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// 念一段话。
    ///
    /// 重复调用会**先掐掉上一句**：提醒的语义是「现在做这个」，
    /// 让过时的播报和最新的播报排队念完，用户听到的最后一句反而是旧的。
    func speak(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        activateSession()

        // 立刻停掉正在念的内容，并丢弃尚未开始的那一句。
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }

        let utterance = AVSpeechUtterance(string: trimmed)
        // 不指定具体 voice：系统语音包因机型/地区而异，硬编码 zh-CN 语音标识
        // 在没装的设备上会静默不出声。给 language 让系统自己挑最合适的中文嗓子。
        utterance.voice = AVSpeechSynthesisVoice(language: "zh-CN")
        // 默认语速偏慢，闹钟式提醒用稍快的速度更接近真人说话节奏。
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
        synthesizer.speak(utterance)
    }

    // MARK: - 音频会话

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers, .allowBluetoothA2DP]
            )
            try session.setActive(true)
            sessionActive = true
        } catch {
            // 会话配置失败不该让提醒消失 —— 屏幕上还有弹窗。静默降级，仅记录线索。
            Self.log.error("语音播报音频会话激活失败：\(error.localizedDescription, privacy: .public)")
        }
    }

    /// 释放会话，让被压低的第三方音频恢复。
    ///
    /// `.notifyOthersOnDeactivation` 是必需的：不告诉系统，别的 App 的音乐会一直闷着。
    private func deactivateSession() {
        guard sessionActive else { return }
        sessionActive = false
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
        } catch {
            Self.log.error("语音播报音频会话释放失败：\(error.localizedDescription, privacy: .public)")
        }
    }
}

// MARK: - AVSpeechSynthesizerDelegate

extension SpeechAnnouncer: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.deactivateSession() }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor in self.deactivateSession() }
    }
}
