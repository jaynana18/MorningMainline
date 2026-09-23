import SwiftUI

@main
struct MorningMainlineApp: App {
    @StateObject private var store: RoutineStore

    init() {
        #if os(iOS)
        let role: DeviceRole = UIDevice.current.userInterfaceIdiom == .pad ? .pad : .phone
        #else
        let role: DeviceRole = .phone
        #endif
        _store = StateObject(wrappedValue: RoutineStore(deviceRole: role))
    }

    var body: some Scene {
        WindowGroup {
            // P2：iOS/iPad 的 UI 交给 `web/` 的 Vue 产物承载（WKWebView 宿主）。
            // `iOS/ContentView.swift` 仍保留在工程里（原生实现留作回退），但不再被引用。
            WebHost(store: store)
                .environmentObject(store)
        }
    }
}

