import SwiftUI
import WidgetKit

@main
struct MainlineWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        MainlineCornerComplication()
        MainlineCircularComplication()
        MainlineRectangularComplication()
    }
}
