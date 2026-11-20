// Task 16 in the running app, through the real runtime (index.html in Capacitor's WebView), the
// real loader and the real profile WebView, against apps/mobile/testpages/navigation served on
// loopback by the test. The app is launched with `-loaderTestBase <url>` (debug builds only), so
// the runtime opens that page as its only profile.

import XCTest

final class LoaderTests: XCTestCase {
    private var pagesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("testpages/navigation")
    }

    private func launch(_ server: HostileServer, page: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-loaderTestBase", "\(server.originA)/\(page)"]
        app.launch()
        return app
    }

    private func waitNative(_ server: HostileServer, _ name: String, timeout: TimeInterval = 60,
                            _ match: @escaping ([String: Any]) -> Bool) {
        let seen = expectation(description: name)
        server.onNative(match) { seen.fulfill() }
        wait(for: [seen], timeout: timeout)
    }

    /// The color at the middle of the screen, as 0...255 components.
    private func centerColor() -> (Int, Int, Int)? {
        guard let image = XCUIScreen.main.screenshot().image.cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        let x = image.width / 2, y = image.height / 2
        context.draw(image, in: CGRect(x: -x, y: -(image.height - y), width: image.width, height: image.height))
        return (Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
    }

    func testChromeReadyDropsTheSplashAndTheNativeBackgroundShows() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server, page: "chrome.html")
        defer { app.terminate() }

        let page = expectation(description: "the page called setAppearance and ready")
        server.onReport(doc: "chrome-page") { page.fulfill() }
        wait(for: [page], timeout: 120)
        let report = server.snapshot().reports.first { $0["doc"] as? String == "chrome-page" }
        XCTAssertEqual((report?["results"] as? [String: Any])?["ready"] as? Bool, true, "\(report ?? [:])")
        waitNative(server, "native background set") {
            $0["event"] as? String == "appearance" && $0["background"] as? String == "#123456"
                && $0["statusBar"] as? String == "light"
        }

        // The page is transparent: once the splash is gone the native background is what shows.
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let (r, g, b) = self.centerColor() else { return false }
            return abs(r - 0x12) <= 4 && abs(g - 0x34) <= 4 && abs(b - 0x56) <= 4
        }, object: nil)
        wait(for: [shown], timeout: 30)
        XCTAssertTrue(server.snapshot().nativeLog.contains {
            $0["event"] as? String == "load" && ($0["detail"] as? [String: Any])?["type"] as? String == "didFinish"
        })
    }

    func testLeavingTheOriginGoesToTheSheetAndNeverLoadsInTheProfileWebView() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server, page: "nav.html")
        defer { app.terminate() }

        let ready = expectation(description: "nav page ready")
        server.onReport(doc: "nav-ready") { ready.fulfill() }
        wait(for: [ready], timeout: 120)
        // The splash drops 3 s after the load (this page never calls ready()).
        let web = app.webViews.firstMatch
        let open = web.buttons["Open window"]
        XCTAssertTrue(open.waitForExistence(timeout: 30))
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: open)
        wait(for: [hittable], timeout: 30)

        let cases: [(XCUIElement, String)] = [
            (open, "\(server.originB)/foreign.html?via=open"),
            (web.links["Blank link"], "\(server.originB)/foreign.html?via=blank"),
            (web.links["Redirect link"], "\(server.originB)/redirected.html"),
        ]
        for (element, url) in cases {
            XCTAssertTrue(element.waitForExistence(timeout: 30), url)
            element.tap()
            waitNative(server, "sheet for \(url)", timeout: 30) {
                $0["event"] as? String == "sheet" && $0["url"] as? String == url
            }
            // The sheet's dismiss button (its label follows the simulator's language).
            let done = app.otherElements["TopBrowserBar"].buttons.element(boundBy: 0)
            XCTAssertTrue(done.waitForExistence(timeout: 30), "the browser sheet for \(url)")
            done.tap()
            let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: done)
            wait(for: [gone], timeout: 30)
        }

        let log = server.snapshot().nativeLog
        let commits = log.filter { $0["event"] as? String == "commit" }.compactMap { $0["url"] as? String }
        XCTAssertFalse(commits.isEmpty)
        XCTAssertEqual(commits.filter { !$0.hasPrefix(server.originA) }, [], "a foreign page committed in the profile WebView")
        let allowedForeign = log.filter {
            $0["event"] as? String == "navigation" && $0["decision"] as? String == "allow"
                && ($0["url"] as? String ?? "").hasPrefix(server.originB)
        }
        XCTAssertEqual(allowedForeign.count, 0, "\(allowedForeign)")
        XCTAssertTrue(server.requestLog().contains { $0.hasSuffix(" /redirect") })
    }
}
