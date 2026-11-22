// Task 31 and the nav@1 minor version of 2026-11-22 in the running app: the strip through nav@1,
// against apps/mobile/testpages/navigation/strip.html served on loopback by the test. On the iPhone
// Duo (outer display, and the inner one when the test can open the Duo) the pill the OS floats in
// the strip carries the page's action (accent-filled, on top), the four sections and search, with
// the account avatar under the status above it; taps reach the page (`onSelect`, `onAction`,
// `onAccount`); the highlight follows the page's `current` (null clears it). No menu button. On
// any other iPhone or iPad there is no pill and no nav@1.
//
// The tests wait on what the app and the page report (the native log, the page's reports), never
// on system UI; taps wait for the launch splash to go (it holds touches while XCUITest already
// finds the page hittable). The expectation is picked by the simulator's model (the iPhone Duo is
// iPhone19,4); the app itself decides by the window only (StripDetector).

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

    private let sections = ["对话", "收件箱", "智能体", "定时任务", "搜索"]

    private func launch(_ server: HostileServer) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-loaderTestBase", "\(server.originA)/strip.html"]
        app.launch()
        return app
    }

    /// The latest report whose doc is `doc` and that matches, once one arrives.
    @discardableResult
    private func waitReport(_ server: HostileServer, _ doc: String, timeout: TimeInterval = 60,
                            file: StaticString = #filePath, line: UInt = #line,
                            _ match: @escaping ([String: Any]) -> Bool = { _ in true }) -> [String: Any] {
        let find = { () -> [String: Any]? in
            server.snapshot().reports.last {
                $0["doc"] as? String == doc && match(($0["results"] as? [String: Any]) ?? [:])
            }.flatMap { $0["results"] as? [String: Any] }
        }
        let seen = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in find() != nil }, object: nil)
        if XCTWaiter().wait(for: [seen], timeout: timeout) != .completed {
            let snapshot = server.snapshot()
            let native = snapshot.nativeLog.filter {
                ["stripChanged", "navSet", "duoSwap"].contains($0["event"] as? String ?? "")
            }
            XCTFail("no report \(doc); reports: \(snapshot.reports.suffix(12)); native: \(native.suffix(12))",
                    file: file, line: line)
        }
        return find() ?? [:]
    }

    private func reports(_ server: HostileServer, _ doc: String) -> Int {
        server.snapshot().reports.filter { $0["doc"] as? String == doc }.count
    }

    /// Waits until the page has reported `doc` more than `count` times.
    private func waitMore(_ server: HostileServer, _ doc: String, than count: Int) {
        let more = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.reports(server, doc) > count
        }, object: nil)
        wait(for: [more], timeout: 30)
    }

    /// Waits until the app drew a `navSet` whose `current` is `current` (NSNull for none).
    private func waitDrawn(_ server: HostileServer, current: Any) {
        let drawn = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let last = server.snapshot().nativeLog.last(where: { $0["event"] as? String == "navSet" })
            else { return false }
            if current is NSNull { return last["current"] is NSNull }
            return last["current"] as? String == current as? String
        }, object: nil)
        wait(for: [drawn], timeout: 30)
    }

    /// Waits until the launch splash is gone: it turns touches off on the app's view until then.
    private func waitForTheSplashToGo(_ server: HostileServer) {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            server.snapshot().nativeLog.contains {
                $0["event"] as? String == "touchable" && $0["enabled"] as? Bool == true
            }
        }, object: nil)
        wait(for: [gone], timeout: 60)
    }

    private func hittable(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 30), "\(element)")
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: element)],
             timeout: 30)
    }

    /// A button of the strip's pill, by its label.
    private func item(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func selected(_ element: XCUIElement, _ value: Bool) {
        wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == %@", NSNumber(value: value)),
                                             object: element)], timeout: 30)
    }

    /// Exactly one pill: each item exists once in the whole hierarchy, and no horizontal tab bar.
    private func assertOnePill(_ app: XCUIApplication, _ labels: [String]) {
        XCTAssertEqual(app.tabBars.count, 0, "a horizontal tab bar")
        for label in labels {
            XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", label)).count, 1, label)
        }
    }

    /// How many pixels of the element look like the page's accent (#ff6a13).
    private func accentPixels(_ element: XCUIElement) -> Int {
        guard let image = element.screenshot().image.cgImage else { return 0 }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return 0 }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var count = 0
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            if r > 220, (70...150).contains(g), b < 80 { count += 1 }
        }
        return count
    }

    func testThePillCarriesTheActionSectionsSearchAndTheAvatarOnlyOnTheDuo() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server)
        defer { app.terminate() }

        let ready = waitReport(server, "strip-ready", timeout: 120)
        guard isDuo else {
            XCTAssertEqual(ready["nav"] as? Bool, false, "\(ready)")
            XCTAssertEqual(ready["dataNativeNav"] as? Bool, false, "\(ready)")
            XCTAssertEqual(app.tabBars.count, 0, "a tab bar outside a strip")
            XCTAssertFalse(app.buttons["strip-account"].exists)
            XCTAssertFalse(item(app, "新会话").exists)
            XCTAssertFalse(item(app, "收件箱").exists)
            return
        }

        XCTAssertEqual(ready["nav"] as? Bool, true, "\(ready)")
        XCTAssertEqual(ready["side"] as? String, "right", "\(ready)")
        XCTAssertEqual(ready["onMenu"] as? Bool, false, "nav@1 has no onMenu: \(ready)")
        XCTAssertEqual(ready["dataNativeNav"] as? Bool, true, "\(ready)")
        // The old shape (with menu) is refused; the new one draws, current null on the page's load.
        waitReport(server, "strip-oldshape-ready") { $0["ok"] as? Bool == false }
        waitReport(server, "strip-set-ready") { $0["ok"] as? Bool == true && $0["current"] is NSNull }
        waitDrawn(server, current: NSNull())
        // R7 / spike 1.4: the strip arrives as env(safe-area-inset-right) inside the tab child, once.
        let env = waitReport(server, "strip-env")
        XCTAssertEqual(env["envRight"] as? Double, 84, "\(env)")
        XCTAssertEqual(env["envLeft"] as? Double, 0, "\(env)")
        waitForTheSplashToGo(server)

        let window = app.windows.firstMatch.frame
        let action = item(app, "新会话")
        hittable(action)
        let tabs = sections.map { item(app, $0) }
        for tab in tabs { hittable(tab) }
        assertOnePill(app, ["新会话"] + sections)
        for element in [action] + tabs {
            XCTAssertGreaterThan(element.frame.minX, window.midX, "\(element.frame) in \(window)")
        }
        XCTAssertEqual(Set(([action] + tabs).map { $0.frame.minX }).count, 1, "the pill stacks vertically")
        let firstSection = tabs.map { $0.frame.minY }.min() ?? 0
        XCTAssertLessThan(action.frame.minY, firstSection, "the action is the pill's top item")
        XCTAssertEqual(item(app, "收件箱").value as? String, "3 items", "the inbox badge")
        // Accent-filled with the page's accent (chrome@1 tokens).
        let accentSeen = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.accentPixels(action) > 40
        }, object: nil)
        wait(for: [accentSeen], timeout: 30)
        // current null: no section highlighted.
        for tab in tabs { XCTAssertFalse(tab.isSelected, tab.label) }

        // The avatar: under the status, above the pill, in the strip, with the initial and badge.
        let account = app.buttons["strip-account"]
        hittable(account)
        XCTAssertEqual(account.label, "Grace Hopper")
        XCTAssertGreaterThan(account.frame.minX, window.midX, "\(account.frame)")
        XCTAssertLessThanOrEqual(account.frame.maxY, action.frame.minY, "the avatar sits above the pill")

        item(app, "收件箱").tap()
        let select = waitReport(server, "strip-select-inbox")
        XCTAssertEqual(select["path"] as? String, "/inbox")
        XCTAssertTrue(app.webViews.firstMatch.staticTexts["/inbox"].waitForExistence(timeout: 30))
        waitDrawn(server, current: "inbox")
        selected(item(app, "收件箱"), true)

        // A tap on the section already selected still reaches the page.
        let inboxTaps = reports(server, "strip-select-inbox")
        item(app, "收件箱").tap()
        waitMore(server, "strip-select-inbox", than: inboxTaps)

        // Search is reported and never takes the highlight.
        item(app, "搜索").tap()
        waitReport(server, "strip-select-search")
        XCTAssertFalse(item(app, "搜索").isSelected)
        XCTAssertTrue(item(app, "收件箱").isSelected)

        // The action goes home: the page sets current null and the highlight clears.
        action.tap()
        let acted = waitReport(server, "strip-action")
        XCTAssertEqual(acted["from"] as? String, "/inbox")
        waitDrawn(server, current: NSNull())
        selected(item(app, "收件箱"), false)
        for tab in tabs { XCTAssertFalse(tab.isSelected, tab.label) }

        // A later section selects again.
        item(app, "对话").tap()
        waitReport(server, "strip-select-chats") { $0["path"] as? String == "/conversations" }
        waitDrawn(server, current: "chats")
        selected(item(app, "对话"), true)

        account.tap()
        waitReport(server, "strip-account")

        // One document all along: no reload while moving between tabs.
        let loads = server.requestLog().filter { $0.hasSuffix(" /strip.html") }
        XCTAssertEqual(loads.count, 1, "\(loads)")
        XCTAssertEqual(reports(server, "strip-ready"), 1)
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

    func testOpeningToTheInnerDisplayKeepsThePillOnTheRight() throws {
        guard isDuo else { throw XCTSkip("the iPhone Duo only") }
        let server = try HostileServer(pagesDir: pagesDir)
        let app = launch(server)
        defer { app.terminate() }
        waitReport(server, "strip-set-ready", timeout: 120) { $0["ok"] as? Bool == true }
        waitForTheSplashToGo(server)
        hittable(item(app, "新会话"))
        // On the outer display the agents page's primary is the pill's top item.
        item(app, "智能体").tap()
        waitReport(server, "strip-set-route") { $0["action"] as? String == "new-agent" }
        hittable(item(app, "新建智能体"))

        try swapDisplays(server)
        // The inner display is wide: the action stays 新会话 (D14), the pill and avatar stay right.
        let wide = waitReport(server, "strip-resize") { ($0["width"] as? Double ?? 0) >= 600 }
        XCTAssertEqual(wide["nav"] as? Bool, true, "the inner display has the strip too: \(wide)")
        XCTAssertEqual(wide["side"] as? String, "right", "\(wide)")
        waitReport(server, "strip-set-resize") {
            $0["ok"] as? Bool == true && $0["action"] as? String == "new-conversation"
        }
        // The strip never went away on the way: no change took nav@1 from the page.
        XCTAssertFalse(server.snapshot().reports.contains {
            $0["doc"] as? String == "strip-change" && ($0["results"] as? [String: Any])?["nav"] as? Bool == false
        }, "nav@1 dropped while opening")
        let window = app.windows.firstMatch.frame
        let action = item(app, "新会话")
        hittable(action)
        let tabs = sections.map { item(app, $0) }
        for tab in tabs { hittable(tab) }
        assertOnePill(app, ["新会话"] + sections)
        for element in [action] + tabs + [app.buttons["strip-account"]] {
            XCTAssertGreaterThan(element.frame.minX, window.midX, "\(element.frame) in \(window)")
        }
        XCTAssertTrue(item(app, "智能体").isSelected)

        action.tap()
        waitReport(server, "strip-action") { $0["from"] as? String == "/agents" }
        waitDrawn(server, current: NSNull())
        selected(item(app, "智能体"), false)

        // Closing again: back to the outer display; still one document.
        try swapDisplays(server)
        waitReport(server, "strip-resize") { ($0["width"] as? Double ?? 600) < 600 }
        hittable(item(app, "新会话"))
        assertOnePill(app, ["新会话"] + sections)
        XCTAssertEqual(server.requestLog().filter { $0.hasSuffix(" /strip.html") }.count, 1)
    }
}
