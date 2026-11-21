import WebKit
import XCTest
@testable import App

/// Waits for main-frame navigations of a test WebView.
@MainActor
final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private var waiting: CheckedContinuation<String, Never>?

    /// Runs `start` and answers how its navigation ended: "finish" or "fail".
    func run(_ start: () -> Void) async -> String {
        await withCheckedContinuation { continuation in
            waiting = continuation
            start()
        }
    }

    private func end(_ outcome: String) {
        let w = waiting
        waiting = nil
        w?.resume(returning: outcome)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { end("finish") }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { end("fail") }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        end("fail")
    }
}

// The iOS in-WebView sign-in block in real WebKit: the shell's `signInBlockRules`, compiled into a
// `WKContentRuleList`, decides every shared vector (packages/shell/test/fixtures/
// in-window-sign-in.json) as the vector says. apps/mobile/test/fixtures/sign-in-block.json holds the
// vectors and the rules generated for them with the deployment's host as `siblocal` (and any other
// origin as `sibother`); vitest keeps it in sync with the shell. Here `siblocal` becomes this
// test's loopback server `127.0.0.1:<port>` and `sibother` `localhost:<port>`: a blocked request
// never reaches the server, any other one does. The cases with escaped class characters (`a|b`,
// `a[b]`, `a^b`, `a%b`) prove WebKit reads them literally (the Task 10 follow-up).
@MainActor
final class SignInBlockTests: XCTestCase {
    private static let mobileDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private struct Case {
        let url: String
        let base: String
        let blocked: Bool
        let from: String
    }

    private func fixture() throws -> (rules: [String: Any], cases: [Case]) {
        let data = try Data(contentsOf: Self.mobileDir.appendingPathComponent("test/fixtures/sign-in-block.json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["loopbackHost"] as? String, "siblocal")
        XCTAssertEqual(root["otherHost"] as? String, "sibother")
        let rules = try XCTUnwrap(root["rules"] as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]]).map {
            Case(url: $0["url"] as? String ?? "", base: $0["base"] as? String ?? "",
                 blocked: $0["blocked"] as? Bool ?? false, from: $0["from"] as? String ?? "")
        }
        return (rules, cases)
    }

    private func compile(_ json: String, id: String) async throws -> WKContentRuleList {
        try await withCheckedThrowingContinuation { continuation in
            WKContentRuleListStore.default().compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) {
                list, error in
                if let list { continuation.resume(returning: list) } else {
                    continuation.resume(throwing: error ?? ProfileWebViewError.badInit)
                }
            }
        }
    }

    func testTheCompiledRulesBlockExactlyTheBlockedVectorsInARealWebView() async throws {
        let server = try await TestHttpServer.start { _ in
            TestHttpServer.Response(headers: ["Content-Type: text/html"], body: "<!doctype html><p>ok</p>")
        }
        defer { server.stop() }
        let port = server.port
        let (rules, cases) = try fixture()
        XCTAssertGreaterThan(cases.count, 130)
        let loopback = "127.0.0.1:\(port)"
        var checked = 0, blockedSeen = 0

        for (index, (base, list)) in rules.sorted(by: { $0.key < $1.key }).enumerated() {
            let data = try JSONSerialization.data(withJSONObject: list)
            // In JSON text a regex backslash is written `\\`.
            let json = try XCTUnwrap(String(data: data, encoding: .utf8))
                .replacingOccurrences(of: "siblocal", with: #"127\\.0\\.0\\.1:"# + "\(port)")
            let compiled = try await compile(json, id: "sign-in-block-test-\(index)")

            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.add(compiled)
            let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
            let waiter = NavigationWaiter()
            webView.navigationDelegate = waiter
            let start = try XCTUnwrap(URL(string: "http://\(loopback)/start-page"))

            for c in cases where c.base == base {
                let url = c.url.replacingOccurrences(of: "siblocal", with: loopback)
                    .replacingOccurrences(of: "sibother", with: "localhost:\(port)")
                let loaded = await waiter.run { webView.load(URLRequest(url: start)) }
                XCTAssertEqual(loaded, "finish", "start page for \(c.from)")
                server.clear()
                if url.contains("@") {
                    // fetch refuses a URL with credentials: these go as a navigation.
                    _ = await waiter.run {
                        webView.evaluateJavaScript("location.href = \(Self.jsString(url));", completionHandler: nil)
                    }
                } else {
                    // The page's own request, as a sign-in form's fetch would send it.
                    _ = try await webView.callAsyncJavaScript(
                        "try { await fetch(u, { method: 'POST', mode: 'no-cors', body: '{}' }); return 'sent'; } catch (e) { return 'refused'; }",
                        arguments: ["u": url], in: nil, contentWorld: .page)
                }
                let reached = !server.requests.isEmpty
                XCTAssertEqual(reached, !c.blocked, "\(c.from) as \(url)")
                checked += 1
                if c.blocked { blockedSeen += 1 }
            }
        }
        XCTAssertEqual(checked, cases.count)
        XCTAssertGreaterThan(blockedSeen, 50)
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    /// M6: the harness sees a blocked vector's request when no list is installed.
    func testControlWithoutTheListTheLoginReachesTheServer() async throws {
        let server = try await TestHttpServer.start { _ in
            TestHttpServer.Response(headers: ["Content-Type: text/html"], body: "<!doctype html><p>ok</p>")
        }
        defer { server.stop() }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        let waiter = NavigationWaiter()
        webView.navigationDelegate = waiter
        let start = try XCTUnwrap(URL(string: "http://127.0.0.1:\(server.port)/start-page"))
        _ = await waiter.run { webView.load(URLRequest(url: start)) }
        server.clear()
        _ = try await webView.callAsyncJavaScript(
            "try { await fetch('/api/v1/auth/login', { method: 'POST', mode: 'no-cors', body: '{}' }); } catch (e) {} return 1;",
            arguments: [:], in: nil, contentWorld: .page)
        XCTAssertTrue(server.requests.contains { $0.method == "POST" && $0.target == "/api/v1/auth/login" })
    }

    /// M9: a removed profile's list is deleted from the store.
    func testARemovedProfilesListIsDeleted() async throws {
        let store = WKContentRuleListStore.default()!
        let id = ProfileWebView.blockRulesIdentifier("removal-test")
        let rules = #"[{"trigger":{"url-filter":"^https://x\\.example/a$"},"action":{"type":"block"}}]"#
        _ = try await compile(rules, id: id)
        let removed: Error? = await withCheckedContinuation { c in
            ProfileWebView.removeBlockRules("removal-test") { c.resume(returning: $0) }
        }
        XCTAssertNil(removed)
        let identifiers: [String] = await withCheckedContinuation { c in
            store.getAvailableContentRuleListIdentifiers { c.resume(returning: $0 ?? []) }
        }
        XCTAssertFalse(identifiers.contains(id))
    }

    // MARK: The profile WebView installs the rules before it loads

    func testAProfileWebViewInstallsTheRulesAndKeepsTheSameList() async throws {
        let view = try ProfileWebView.make(
            profileId: "block-test", profileOrigin: "https://cap.example.com", dataStore: .nonPersistent(),
            shellVersion: "0.0.0", state: ["insets": [:], "capabilities": [:], "events": [:]], script: "",
            base: "https://cap.example.com")
        let rules = #"[{"trigger":{"url-filter":"^https://cap\\.example\\.com/api/v1/auth/login$"},"action":{"type":"block"}}]"#
        let first: Error? = await withCheckedContinuation { c in view.installBlockRules(rules) { c.resume(returning: $0) } }
        XCTAssertNil(first)
        let again: Error? = await withCheckedContinuation { c in view.installBlockRules(rules) { c.resume(returning: $0) } }
        XCTAssertNil(again)
        let broken: Error? = await withCheckedContinuation { c in view.installBlockRules("not json") { c.resume(returning: $0) } }
        XCTAssertNotNil(broken, "a list that does not compile is an error: the host then loads nothing")
    }
}
