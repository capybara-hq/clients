import Network
import WebKit
import XCTest
@testable import App

/// ProfileHost.close (Task 18 review I2): a hidden or removed profile's WebView is torn down and
/// released, so its data store is no longer in use. Real WKWebViews, no window.
@MainActor
final class ProfileHostTests: XCTestCase {
    private final class Sink: ShellCallSink {
        var opened: [String] = []
        var ended: [String] = []
        func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String) { opened.append(docId) }
        func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall) {}
        func profileWebView(_ webView: ProfileWebView, didEndDocument docId: String) { ended.append(docId) }
    }

    /// A loopback server counting requests per path (query dropped); every request gets `page`.
    private final class CountingServer {
        let listener: NWListener
        private let lock = NSLock()
        private var counts: [String: Int] = [:]
        let page: String

        init(page: String) throws {
            self.page = page
            listener = try NWListener(using: .tcp, on: .any)
        }

        func count(_ path: String) -> Int {
            lock.lock()
            defer { lock.unlock() }
            return counts[path] ?? 0
        }

        func start() async {
            listener.newConnectionHandler = { [weak self] connection in
                connection.start(queue: .global())
                connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                    guard let self, let data, let text = String(data: data, encoding: .utf8) else { return }
                    let target = text.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                    let path = String(target.split(separator: "?").first ?? "")
                    self.lock.lock()
                    self.counts[path, default: 0] += 1
                    self.lock.unlock()
                    let body = path == "/" ? self.page : "ok"
                    let reply = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\n"
                        + "Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                    connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in
                        connection.cancel()
                    })
                }
            }
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                var resumed = false
                listener.stateUpdateHandler = { state in
                    if case .ready = state, !resumed {
                        resumed = true
                        done.resume()
                    }
                }
                listener.start(queue: .global())
            }
        }

        var origin: String { "http://127.0.0.1:\(listener.port!.rawValue)" }
    }

    /// Polls `condition` every 50 ms for up to `seconds`.
    private func waitFor(_ seconds: Double, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return false }
            try await Task.sleep(for: .milliseconds(50))
        }
        return true
    }

    func testAfterCloseThePageTimerAndFetchLoopStop() async throws {
        let server = try CountingServer(page: """
        <!doctype html><title>t</title><script>
        setInterval(() => fetch("/timer?" + Math.random()), 100);
        (async () => {
          for (;;) {
            await fetch("/loop?" + Math.random()).catch(() => {});
            await new Promise((r) => setTimeout(r, 50));
          }
        })();
        </script>
        """)
        await server.start()
        defer { server.listener.cancel() }

        let host = ProfileHost(controller: nil)
        let id = UUID()
        try host.open(ProfileHost.Spec(
            profileId: "loop", origin: server.origin, base: server.origin, dataStoreId: id.uuidString,
            state: ["insets": ["top": 0, "right": 0, "bottom": 0, "left": 0], "capabilities": [:], "events": [:]]
        ))
        // In a window, so WebKit never throttles the page's timers for being offscreen.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
        let container = try XCTUnwrap(host.view(for: "loop")?.superview)
        container.frame = window.bounds
        window.addSubview(container)
        window.isHidden = false
        defer {
            container.removeFromSuperview()
            window.isHidden = true
        }

        let running = try await waitFor(15) { server.count("/timer") >= 3 && server.count("/loop") >= 3 }
        XCTAssertTrue(running, "page never ran: timer \(server.count("/timer")) loop \(server.count("/loop"))")

        weak var view = host.view(for: "loop")
        host.close("loop")
        let released = try await waitFor(5) { view == nil }
        XCTAssertTrue(released, "the closed WebView is still retained")

        // Requests in flight at close may still land; after that nothing new may arrive. The page
        // asks every 50-100 ms, so one second without a request shows both loops stopped.
        let settledTimer = server.count("/timer"), settledLoop = server.count("/loop")
        _ = try await waitFor(1) { server.count("/timer") > settledTimer + 1 || server.count("/loop") > settledLoop + 1 }
        XCTAssertLessThanOrEqual(server.count("/timer"), settledTimer + 1, "the timer kept fetching after close")
        XCTAssertLessThanOrEqual(server.count("/loop"), settledLoop + 1, "the fetch loop kept going after close")
        try? await WKWebsiteDataStore.remove(forIdentifier: id)
    }

    private func spec(_ profileId: String, store: UUID) -> ProfileHost.Spec {
        ProfileHost.Spec(
            profileId: profileId, origin: "https://deployment.test", base: "https://deployment.test",
            dataStoreId: store.uuidString,
            state: ["insets": ["top": 0, "right": 0, "bottom": 0, "left": 0], "capabilities": [:], "events": [:]]
        )
    }

    func testCloseReleasesTheWebViewAndItsStore() async throws {
        let host = ProfileHost(controller: nil)
        let sink = Sink()
        host.sink = sink
        let id = UUID()
        try host.open(spec("p1", store: id))
        weak var view = host.view(for: "p1")
        XCTAssertNotNil(view)

        host.close("p1")
        XCTAssertNil(host.view(for: "p1"))
        // WebKit lets go of a WebView whose navigation was stopped on a later run loop turn.
        for _ in 0..<50 where view != nil {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertNil(view, "the closed WebView is still retained")

        // With no WebView holding it, WebKit lets the store go (asynchronously: it may take a
        // few attempts, as DataStores.drain retries).
        var removed = false
        for _ in 0..<50 where !removed {
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: id)
                removed = true
            } catch {
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        XCTAssertTrue(removed, "the store stayed in use after close")
    }

    func testCloseOfAnUnknownProfileDoesNothingAndOpenMakesAFreshView() throws {
        let host = ProfileHost(controller: nil)
        host.close("nope")
        let id = UUID()
        try host.open(spec("p1", store: id))
        let first = host.view(for: "p1")
        host.close("p1")
        try host.open(spec("p1", store: id))
        XCTAssertNotNil(host.view(for: "p1"))
        XCTAssertFalse(first === host.view(for: "p1"))
        host.close("p1")
    }
}
