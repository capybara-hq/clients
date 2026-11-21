// Task 31 in the running app: the strip navigation through nav@1, against
// apps/mobile/testpages/navigation/strip.html served on loopback by the test. On the iPhone Duo
// (outer display, and the inner one when the test can open the Duo) the vertical system tab bar
// sits in the strip with four sections and the menu button above them; taps reach the page. On
// any other iPhone or iPad there is no tab bar and no nav@1.
//
// The expectation is picked by the simulator's model (the iPhone Duo is iPhone19,4); the app itself
// decides by the window only (StripDetector).

import XCTest

final class StripTests: XCTestCase {
    private var pagesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("testpages/navigation")
    }

    private var isDuo: Bool {
        ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4"
    }

    private func launch(_ server: HostileServer) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-loaderTestBase", "\(server.originA)/strip.html"]
        app.launch()
        return app
    }

    /// The latest report whose doc is `doc` and that matches, once one arrives.
    @discardableResult
    private func waitReport(_ server: HostileServer, _ doc: String, timeout: TimeInterval = 60,
                            _ match: @escaping ([String: Any]) -> Bool = { _ in true }) -> [String: Any] {
        let find = { () -> [String: Any]? in
            server.snapshot().reports.last {
                $0["doc"] as? String == doc && match(($0["results"] as? [String: Any]) ?? [:])
            }.flatMap { $0["results"] as? [String: Any] }
        }
        let seen = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in find() != nil }, object: nil)
        wait(for: [seen], timeout: timeout)
        return find() ?? [:]
    }

    private func hittable(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 30), "\(element)")
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: element)],
             timeout: 30)
    }

    /// A section button of the strip's tab bar.
    private func section(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    /// Exactly one tab bar: each section button exists once in the whole hierarchy.
    private func assertOneBar(_ app: XCUIApplication, _ labels: [String]) {
        XCTAssertEqual(app.tabBars.count, 0, "a horizontal tab bar")
        for label in labels {
            XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", label)).count, 1, label)
        }
    }

    func testTheStripCarriesTheSectionsAndTheMenuButtonOnlyOnTheDuo() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server)
        defer { app.terminate() }

        let ready = waitReport(server, "strip-ready", timeout: 120)
        guard isDuo else {
            XCTAssertEqual(ready["nav"] as? Bool, false, "\(ready)")
            XCTAssertEqual(ready["dataNativeNav"] as? Bool, false, "\(ready)")
            XCTAssertEqual(app.tabBars.count, 0, "a tab bar outside a strip")
            XCTAssertFalse(app.buttons["strip-menu"].exists)
            XCTAssertFalse(section(app, "收件箱").exists)
            return
        }

        XCTAssertEqual(ready["nav"] as? Bool, true, "\(ready)")
        XCTAssertEqual(ready["dataNativeNav"] as? Bool, true, "\(ready)")
        waitReport(server, "strip-set-ready") { $0["ok"] as? Bool == true }
        // R7 / spike 1.4: the strip arrives as env(safe-area-inset-right) inside the tab child, once.
        let env = waitReport(server, "strip-env")
        XCTAssertEqual(env["envRight"] as? Double, 84, "\(env)")

        // The vertical system tab bar (UIKit exposes it as a toolbar): one set of four sections in
        // the right strip.
        let labels = ["对话", "收件箱", "智能体", "定时任务"]
        let window = app.windows.firstMatch.frame
        let tabs = labels.map { section(app, $0) }
        for tab in tabs { hittable(tab) }
        assertOneBar(app, labels)
        for tab in tabs { XCTAssertGreaterThan(tab.frame.minX, window.midX, "\(tab.frame) in \(window)") }
        XCTAssertEqual(Set(tabs.map { $0.frame.minX }).count, 1, "the sections stack vertically")
        XCTAssertEqual(section(app, "收件箱").value as? String, "3 items", "the inbox badge")

        let menu = app.buttons["strip-menu"]
        hittable(menu)
        XCTAssertEqual(menu.label, "菜单")
        XCTAssertGreaterThan(menu.frame.minX, window.midX, "\(menu.frame)")
        let firstItem = tabs.map { $0.frame.minY }.min() ?? 0
        XCTAssertLessThanOrEqual(menu.frame.maxY, firstItem, "the menu button sits above the items")

        section(app, "收件箱").tap()
        let select = waitReport(server, "strip-select-inbox")
        XCTAssertEqual(select["path"] as? String, "/inbox")
        XCTAssertTrue(app.webViews.firstMatch.staticTexts["/inbox"].waitForExistence(timeout: 30))

        // Back to chats; a tap on the section already selected still reaches the page.
        section(app, "对话").tap()
        waitReport(server, "strip-select-chats") { $0["path"] as? String == "/" }
        section(app, "对话").tap()
        let again = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            server.snapshot().reports.filter { $0["doc"] as? String == "strip-select-chats" }.count >= 2
        }, object: nil)
        wait(for: [again], timeout: 30)

        menu.tap()
        waitReport(server, "strip-menu")

        // One document all along: no reload while moving between tabs.
        let loads = server.requestLog().filter { $0.hasSuffix(" /strip.html") }
        XCTAssertEqual(loads.count, 1, "\(loads)")
        XCTAssertEqual(server.snapshot().reports.filter { $0["doc"] as? String == "strip-ready" }.count, 1)
    }

    /// Opens or closes the Duo: the app's debug-only DuoSwap swaps on this Darwin notification and
    /// logs the answer. Skips where the simulator refuses the swap.
    private func swapDisplays(_ server: HostileServer) throws {
        let before = server.snapshot().nativeLog.filter { $0["event"] as? String == "duoSwap" }.count
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName("com.capybarahq.shell.test.duo-swap" as CFString),
                                             nil, nil, true)
        let answer = { server.snapshot().nativeLog.filter { $0["event"] as? String == "duoSwap" }.dropFirst(before).first }
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in answer() != nil }, object: nil)],
             timeout: 30)
        let result = answer()?["result"] as? String
        if result != "swapped" { throw XCTSkip("the simulator did not swap displays: \(result ?? "no answer")") }
    }

    func testOpeningToTheInnerDisplayKeepsTheStripWithoutTheMenuButton() throws {
        guard isDuo else { throw XCTSkip("the iPhone Duo only") }
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server)
        defer { app.terminate() }
        waitReport(server, "strip-set-ready", timeout: 120) { $0["ok"] as? Bool == true }
        let labels = ["对话", "收件箱", "智能体", "定时任务"]
        hittable(app.buttons["strip-menu"])

        try swapDisplays(server)
        // The inner display is wide (the web's class is no longer compact): it sets `menu: null`.
        let wide = waitReport(server, "strip-resize") { ($0["width"] as? Double ?? 0) >= 600 }
        XCTAssertEqual(wide["nav"] as? Bool, true, "the inner display has the strip too: \(wide)")
        waitReport(server, "strip-set-resize") { $0["ok"] as? Bool == true && $0["menu"] is NSNull }
        // The strip never went away on the way: no change took nav@1 from the page.
        XCTAssertFalse(server.snapshot().reports.contains {
            $0["doc"] as? String == "strip-change" && ($0["results"] as? [String: Any])?["nav"] as? Bool == false
        }, "nav@1 dropped while opening")
        let window = app.windows.firstMatch.frame
        let tabs = labels.map { section(app, $0) }
        for tab in tabs { hittable(tab) }
        assertOneBar(app, labels)
        for tab in tabs { XCTAssertGreaterThan(tab.frame.minX, window.midX, "\(tab.frame) in \(window)") }
        let menuGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
                                                 object: app.buttons["strip-menu"])
        wait(for: [menuGone], timeout: 30)

        section(app, "智能体").tap()
        waitReport(server, "strip-select-agents") { $0["path"] as? String == "/agents" }

        // Closing again: back to the outer display, the menu button returns; still one document.
        try swapDisplays(server)
        waitReport(server, "strip-set-resize") { $0["ok"] as? Bool == true && $0["menu"] is [String: Any] }
        hittable(app.buttons["strip-menu"])
        assertOneBar(app, labels)
        XCTAssertEqual(server.requestLog().filter { $0.hasSuffix(" /strip.html") }.count, 1)
    }
}
