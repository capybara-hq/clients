import XCTest
@testable import App

// The unit test bundle runs inside the app (TEST_HOST) and sees the `App` module.
final class AppTests: XCTestCase {
    func testRunsInsideTheApp() {
        XCTAssertNotNil(Bundle.main.bundleIdentifier)
        XCTAssertTrue(UIApplication.shared.delegate is AppDelegate)
    }
}
