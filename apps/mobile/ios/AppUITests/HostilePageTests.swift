// The hostile-page suite (Task 13): the real ProfileWebView in the running app, next to
// Capacitor's bridge, against the documents of apps/mobile/testpages/hostile. Only the profile
// origin's top document may see `capybaraShell` and get a reply; every other document's posts are
// dropped natively (each one must actually have been attempted and logged), and no document sees
// `window.Capacitor`. The rules match android/.../HostilePageTest.kt; expect.json lists the
// documents.

import XCTest

final class HostilePageTests: XCTestCase {
    private var pagesDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("testpages/hostile")
    }

    func testOnlyTheProfileTopDocumentReachesNative() throws {
        let server = try HostileServer(pagesDir: pagesDir)
        let expectData = try Data(contentsOf: pagesDir.appendingPathComponent("expect.json"))
        let expect = try XCTUnwrap(JSONSerialization.jsonObject(with: expectData) as? [String: Any])

        let app = XCUIApplication()
        app.launchArguments = ["-hostilePort", "\(server.port)"]
        app.launch()
        defer { app.terminate() }

        // The popup document waits for a real tap (a user gesture) before its second window.open.
        let popupReady = expectation(description: "popup document ready")
        server.onReport(doc: "popup-ready") { popupReady.fulfill() }
        wait(for: [popupReady], timeout: 180)
        let button = app.webViews.buttons["Open popup"]
        XCTAssertTrue(button.waitForExistence(timeout: 30))
        button.tap()

        let done = expectation(description: "sequence done")
        server.onReport(doc: expect["sequenceEnd"] as? String ?? "sequence-done") { done.fulfill() }
        let gesture = expectation(description: "gesture result")
        server.onReport(doc: "A-popup-gesture") { gesture.fulfill() }
        wait(for: [done, gesture], timeout: 120)

        let (reports, nativeLog) = server.snapshot()
        let evidence: [String: Any] = ["reports": reports, "nativeLog": nativeLog]
        if let data = try? JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]) {
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "hostile-ios.json"
            attachment.lifetime = .keepAlways
            add(attachment)
            print("HOSTILE-EVIDENCE \(String(decoding: data, as: UTF8.self))")
        }
        let failures = HostileEvaluator.evaluate(platform: "ios", expect: expect, reports: reports,
                                                 nativeLog: nativeLog)
        XCTAssertEqual(failures, [], failures.joined(separator: "\n"))
    }
}

/// The pass criteria, shared in substance with the Android suite.
enum HostileEvaluator {
    static func evaluate(platform: String, expect: [String: Any], reports: [[String: Any]],
                         nativeLog: [[String: Any]]) -> [String] {
        var failures: [String] = []
        let denied: Set<String> = platform == "ios" ? ["rejected:denied"] : ["denied"]

        func results(_ doc: String) -> [String: Any]? {
            reports.first { $0["doc"] as? String == doc }?["results"] as? [String: Any]
        }
        func logged(_ event: String, id: String) -> [[String: Any]] {
            nativeLog.filter { $0["event"] as? String == event && $0["id"] as? String == id }
        }
        func string(_ r: [String: Any], _ path: String...) -> String? {
            var value: Any? = r
            for key in path { value = (value as? [String: Any])?[key] }
            if let s = value as? String { return s }
            if let n = value as? NSNumber { return n.stringValue }
            return nil
        }
        func checkNoCapacitor(_ doc: String, _ r: [String: Any]) {
            for key in ["capacitorType", "bridgeHandlerType", "androidBridgeType"]
            where string(r, key) != "undefined" {
                failures.append("\(doc): \(key) is \(string(r, key) ?? "missing")")
            }
        }

        // The profile document: the shell, a reply, a refused redefinition, a pushed change.
        let profile = expect["profile"] as? String ?? "A-top"
        if let r = results(profile) {
            if string(r, "shellEarly") != "object" || string(r, "shellAtProbe") != "object" {
                failures.append("\(profile): no capybaraShell")
            }
            if (r["redefineTook"] as? Bool) != false { failures.append("\(profile): capybaraShell replaced") }
            if string(r, "replies", "shell") != "pong" {
                failures.append("\(profile): shell reply \(string(r, "replies", "shell") ?? "none")")
            }
            if string(r, "attempts", "raw") != "posted" || string(r, "replies", "raw") != "pong"
                || logged("accept", id: "\(profile):raw").isEmpty {
                failures.append("\(profile): raw post not accepted")
            }
            if string(r, "attempts", "malformed") != "posted"
                || !denied.contains(string(r, "replies", "malformed") ?? "")
                || !logged("drop", id: "\(profile):malformed").contains(where: { $0["reason"] as? String == "shape" }) {
                failures.append("\(profile): malformed post not dropped (\(string(r, "replies", "malformed") ?? "none"))")
            }
            if string(r, "pushedBottom") != "7" {
                failures.append("\(profile): pushed state not seen (\(string(r, "pushedBottom") ?? "none"))")
            }
            checkNoCapacitor(profile, r)
        } else {
            failures.append("\(profile): no report")
        }

        // Every hostile document: nothing defined, each attack attempted, each post dropped.
        let hostile = expect["hostile"] as? [String: [String: Any]] ?? [:]
        for (doc, spec) in hostile.sorted(by: { $0.key < $1.key }) {
            guard let r = results(doc) else {
                failures.append("\(doc): no report")
                continue
            }
            if string(r, "shellEarly") != "undefined" || string(r, "shellAtProbe") != "undefined" {
                failures.append("\(doc): sees capybaraShell")
            }
            checkNoCapacitor(doc, r)
            if (r["strayPush"] as? Bool) != false { failures.append("\(doc): a push reached it") }
            switch spec["viaTop"] as? String {
            case "pong":
                // Spec §15.3, pinned: a same-origin unsandboxed frame calls the top document's shell.
                if string(r, "attempts", "viaTop") != "posted" || string(r, "replies", "viaTop") != "pong" {
                    failures.append("\(doc): the top document's shell was not reachable (\(string(r, "replies", "viaTop") ?? "none"))")
                }
            case "blocked":
                if !(string(r, "viaTopType") ?? "").hasPrefix("blocked") {
                    failures.append("\(doc): reached window.top.capybaraShell (\(string(r, "viaTopType") ?? "none"))")
                }
            default:
                break
            }
            let expected = (spec["endpoint"] as? [String: String])?[platform] ?? "yes"
            let vias = (spec["frame"] as? Bool) == true ? ["raw", "fake"] : ["raw"]
            for via in vias {
                let id = "\(doc):\(via)"
                switch string(r, "attempts", via) {
                case "posted":
                    if expected == "no" { failures.append("\(id): endpoint present, expected none") }
                    let reply = string(r, "replies", via) ?? "none"
                    if !denied.contains(reply) { failures.append("\(id): reply \(reply)") }
                    if logged("drop", id: id).isEmpty { failures.append("\(id): no native drop logged") }
                    if !logged("accept", id: id).isEmpty { failures.append("\(id): native accepted") }
                case "no-endpoint":
                    if expected == "yes" { failures.append("\(id): no endpoint to attack, expected one") }
                case let other:
                    failures.append("\(id): not attempted (\(other ?? "missing"))")
                }
            }
        }

        // Popups: window.open answers null with and without a gesture, and no WebView is made.
        let popup = expect["popup"] as? String ?? "A-popup"
        let popupResults = (expect["popupResults"] as? [String: [String]])?[platform] ?? ["null"]
        if let r = results(popup) {
            if !popupResults.contains(string(r, "popup", "noGesture") ?? "") {
                failures.append("\(popup): window.open without a gesture gave \(string(r, "popup", "noGesture") ?? "nothing")")
            }
            let gesture = results("\(popup)-gesture").flatMap { string($0, "gesture") }
            if !popupResults.contains(gesture ?? "") {
                failures.append("\(popup): window.open with a gesture gave \(gesture ?? "nothing")")
            }
            checkNoCapacitor(popup, r)
        } else {
            failures.append("\(popup): no report")
        }
        if platform == "ios", !nativeLog.contains(where: {
            $0["event"] as? String == "popup" && ($0["url"] as? String ?? "").hasSuffix("popup-child.html?via=gesture")
        }) {
            failures.append("\(popup): the gesture popup's URL did not reach the popup hook")
        }
        if nativeLog.contains(where: { $0["event"] as? String == "popup-window" }) {
            failures.append("\(popup): a popup window was created")
        }
        let child = expect["popupChild"] as? String ?? "A-popup-child"
        for report in reports where report["doc"] as? String == child {
            let r = report["results"] as? [String: Any] ?? [:]
            if (r["hasOpener"] as? Bool) == true, (r["openerIsSelf"] as? Bool) != true {
                failures.append("\(child): opened in a popup window")
            }
        }

        // Nothing but top documents on the profile origin was ever accepted.
        let trusted = [profile, popup, child].map { "\($0):" }
        for entry in nativeLog where entry["event"] as? String == "accept" && entry["kind"] as? String == "call" {
            let id = entry["id"] as? String ?? ""
            if id.contains(":") && !trusted.contains(where: { id.hasPrefix($0) }) {
                failures.append("accepted \(id)")
            }
        }
        if !reports.contains(where: { $0["doc"] as? String == "sequence-done" }) {
            failures.append("the sequence never finished")
        }
        return failures
    }
}
