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
