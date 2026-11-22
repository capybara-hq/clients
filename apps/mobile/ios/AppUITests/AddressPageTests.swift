// The address page wired into the runtime (wave T1 wiring, N1): the page is framed over the runtime
// document with no Capacitor bridge, asks the runtime to discover by postMessage, and the runtime
// runs native HttpGet, adds the profile and opens it. Launched with `-loaderTestBase` (the native
// log goes to the test server) and `-loaderTestAddress YES` (debug builds only), so the runtime
// starts on the address page over an empty in-memory profile list.

import XCTest

final class AddressPageTests: XCTestCase {
    private var pagesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("testpages/address")
    }

    func testAddingAnAddressThroughTheFramedPageOpensTheDeployment() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = XCUIApplication()
        app.launchArguments = ["-loaderTestBase", "\(server.originA)/", "-loaderTestAddress", "YES"]
        app.launch()
        defer { app.terminate() }

        let web = app.webViews.firstMatch
        let field = web.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 120), "the framed address page")
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: field)
        wait(for: [hittable], timeout: 30)
        // The launch splash turns touches off on the app's view until it is gone, while XCUITest
        // already finds the framed page hittable: a tap before then is lost, and typing fails
        // with "Neither element nor any descendant has keyboard focus" (CI, clients#41).
        let touchable = expectation(description: "the app takes touches")
        server.onNative({ $0["event"] as? String == "touchable" && $0["enabled"] as? Bool == true }) {
            touchable.fulfill()
        }
        wait(for: [touchable], timeout: 60)
        field.tap()
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: field)],
             timeout: 30)
        field.typeText("\(server.originA)\n")

        // Discovery ran in the runtime (native HttpGet): the page shows the deployment's name.
        let name = web.staticTexts["Loopback Test Platform"]
        XCTAssertTrue(name.waitForExistence(timeout: 60), "the discovered deployment")
        XCTAssertTrue(server.requestLog().contains { $0.hasSuffix(" /api/v1/meta") })

        let opened = expectation(description: "the added deployment opened in a profile WebView")
        server.onReport(doc: "address-deployment") { opened.fulfill() }
        // The primary button of the found view ("Sign in" / "登录"): the deployment opens and the
        // browser sign-in starts over it (its sheet is not driven here).
        let signIn = web.buttons.matching(NSPredicate(format: "label IN %@", ["Sign in", "登录"])).firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 30))
        let signInHittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: signIn)
        wait(for: [signInHittable], timeout: 30)
        signIn.tap()
        let result = XCTWaiter().wait(for: [opened], timeout: 60)
        XCTAssertEqual(result, .completed, "reports \(server.snapshot().reports) requests \(server.requestLog()) native \(server.snapshot().nativeLog)")

        let report = server.snapshot().reports.first { $0["doc"] as? String == "address-deployment" }
        let results = report?["results"] as? [String: Any]
        XCTAssertEqual(results?["capabilities"] as? [String],
                       ["chrome@1", "haptics@1", "menu@1", "openExternal@1", "profiles@1", "share@1", "signIn@1"],
                       "\(report ?? [:])")
        XCTAssertEqual(results?["capacitor"] as? String, "undefined", "a profile WebView never has the bridge")
    }
}
