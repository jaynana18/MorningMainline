import SwiftUI

@main
struct MorningMainlineWatchApp: App {
    @StateObject private var store = RoutineStore(deviceRole: .watch)

    var body: some Scene {
        WindowGroup {
            WatchRoutineView()
                .environmentObject(store)
        }
    }
}

