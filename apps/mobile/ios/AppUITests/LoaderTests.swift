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
        tapEachToTheSheet(app, server, cases)

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
    /// Taps each element; each must open the browser sheet with its URL, which is then closed.
    private func tapEachToTheSheet(_ app: XCUIApplication, _ server: HostileServer, _ cases: [(XCUIElement, String)]) {
        for (element, url) in cases {
            XCTAssertTrue(element.waitForExistence(timeout: 30), url)
            element.tap()
            waitNative(server, "sheet for \(url)", timeout: 30) {
                $0["event"] as? String == "sheet" && $0["url"] as? String == url
            }
            // The sheet's dismiss button, by its name (localized, so every language the simulator
            // may run in): while the sheet is still presenting, the bar's first button can be
            // another one (CI tapped a bar-wide button and the sheet stayed up).
            let bar = app.otherElements["TopBrowserBar"]
            let names = ["Done", "Close", "完成", "关闭"]
            let done = bar.buttons.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", names, names)).firstMatch
            XCTAssertTrue(done.waitForExistence(timeout: 30), "the browser sheet for \(url)")
            wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: done)], timeout: 30)
            done.tap()
            let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: bar)
            wait(for: [gone], timeout: 30)
        }

    }

    func testEveryNewWindowGoesToTheSheetWhateverItsOrigin() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server, page: "popups.html")
        defer { app.terminate() }

        let ready = expectation(description: "popups page ready")
        server.onReport(doc: "popups-ready") { ready.fulfill() }
        wait(for: [ready], timeout: 120)
        let web = app.webViews.firstMatch
        let oauth = web.links["OAuth link"]
        XCTAssertTrue(oauth.waitForExistence(timeout: 30))
        let hittable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: oauth)
        wait(for: [hittable], timeout: 30)
        let a = server.originA, b = server.originB
        tapEachToTheSheet(app, server, [
            // An OAuth-shaped target=_blank link must never leave in place (fix round 1, I1).
            (oauth, "\(b)/foreign.html?via=oauth&response_type=code&client_id=c&state=s&redirect_uri=\(a)%2Fcb"),
            (web.links["Same-origin link"], "\(a)/foreign.html?via=same-blank"),
            (web.buttons["Same-origin window"], "\(a)/foreign.html?via=same-open"),
        ])
        let commits = server.snapshot().nativeLog.filter { $0["event"] as? String == "commit" }
            .compactMap { $0["url"] as? String }
        XCTAssertEqual(commits.filter { !$0.hasSuffix("/popups.html") }, [], "a new window loaded in the profile WebView")
    }
}
