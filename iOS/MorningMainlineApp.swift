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
            ContentView()
                .environmentObject(store)
        }
    }
}

