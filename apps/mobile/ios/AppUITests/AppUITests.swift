import XCTest

// The UI test bundle drives the app (TEST_TARGET_NAME = App).
final class AppUITests: XCTestCase {
    func testLaunchesTheApp() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertEqual(app.state, .runningForeground)
    }
}
