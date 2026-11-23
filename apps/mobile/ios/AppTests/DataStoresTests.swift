import WebKit
import XCTest
@testable import App

/// In-memory pending-deletion record, so tests never touch the app's UserDefaults.
final class MemoryPendingDeletions: PendingDeletions {
    var ids: Set<UUID> = []
    func load() -> Set<UUID> { ids }
    func save(_ ids: Set<UUID>) { self.ids = ids }
}

@MainActor
final class DataStoresTests: XCTestCase {
    private func cookie(_ name: String) -> HTTPCookie {
        HTTPCookie(properties: [
            .domain: "deployment.test", .path: "/", .name: name, .value: "1",
            .expires: Date().addingTimeInterval(3600),
        ])!
    }

    private func cookieNames(_ store: WKWebsiteDataStore) async -> Set<String> {
        Set(await store.httpCookieStore.allCookies().map(\.name))
    }

    func testModeIsMulti() {
        XCTAssertEqual(DataStores(pending: MemoryPendingDeletions()).mode, "multi")
    }

    func testStoresOfTwoIdsAreIsolated() async throws {
        let stores = DataStores(pending: MemoryPendingDeletions())
        let a = UUID().uuidString, b = UUID().uuidString
        do {
            let storeA = try stores.create(a)
            let storeB = try stores.create(b)
            XCTAssertFalse(storeA === WKWebsiteDataStore.default())
            XCTAssertEqual(storeA.identifier?.uuidString, a)
            await storeA.httpCookieStore.setCookie(cookie("only_a"))
            let inA = await cookieNames(storeA)
            let inB = await cookieNames(storeB)
            XCTAssertTrue(inA.contains("only_a"))
            XCTAssertFalse(inB.contains("only_a"))
        }
        // Every reference to the stores is gone: WebKit can remove them.
        try stores.remove(a)
        try stores.remove(b)
        let left = await stores.drain()
        XCTAssertEqual(left, [])
    }

    func testRemoveDeletesTheStoreAndForgetsItAfterwards() async throws {
        let pending = MemoryPendingDeletions()
        let stores = DataStores(pending: pending)
        let id = UUID().uuidString
        do {
            let store = try stores.create(id)
            await store.httpCookieStore.setCookie(cookie("gone"))
        }
        var all = await WKWebsiteDataStore.allDataStoreIdentifiers
        XCTAssertTrue(all.contains(UUID(uuidString: id)!))
        try stores.remove(id)
        XCTAssertEqual(pending.ids, [UUID(uuidString: id)!], "recorded before any attempt")
        XCTAssertNil(stores.store(for: id), "a removed store is never handed out again")
        XCTAssertThrowsError(try stores.create(id))
        let left = await stores.drain()
        XCTAssertEqual(left, [])
        XCTAssertEqual(pending.ids, [])
        all = await WKWebsiteDataStore.allDataStoreIdentifiers
        XCTAssertFalse(all.contains(UUID(uuidString: id)!))
    }

    func testRemovalWaitsForTheWebViewToBeReleased() async throws {
        let pending = MemoryPendingDeletions()
        let stores = DataStores(pending: pending, retryDelays: [])
        let id = UUID().uuidString
        var webView: WKWebView? = try {
            let config = WKWebViewConfiguration()
            config.websiteDataStore = try stores.create(id)
            return WKWebView(frame: .zero, configuration: config)
        }()
        webView?.loadHTMLString("<p>hi</p>", baseURL: URL(string: "https://deployment.test/"))
        await webView?.configuration.websiteDataStore.httpCookieStore.setCookie(cookie("held"))
        try stores.remove(id)
        let stillHeld = await stores.drain()
        XCTAssertEqual(stillHeld, [UUID(uuidString: id)!], "in use: stays pending")
        XCTAssertEqual(pending.ids, [UUID(uuidString: id)!])

        // Release the WebView and its configuration; WebKit frees the store asynchronously, so the
        // owner retries (spike 1.2: the second attempt succeeds).
        webView = nil
        _ = webView
        let retrying = DataStores(pending: pending)
        let left = await retrying.drain()
        XCTAssertEqual(left, [])
        XCTAssertEqual(pending.ids, [])
    }

    func testAStoreBackOnDiskAfterItsRemovalIsRemovedAgain() async throws {
        let pending = MemoryPendingDeletions()
        let id = UUID()
        // The store's closing session writes it out again right after the first removal.
        var onDisk: Set<UUID> = [id]
        var removals = 0
        let stores = DataStores(
            pending: pending,
            retryDelays: [.zero],
            listIds: { Array(onDisk) },
            removeStore: { uuid in
                removals += 1
                if removals > 1 { onDisk.remove(uuid) }
            }
        )
        pending.ids = [id]
        let left = await stores.drain()
        XCTAssertEqual(left, [])
        XCTAssertEqual(removals, 2)
        XCTAssertEqual(pending.ids, [])
    }

    func testAStoreThatStaysOnDiskStaysScheduled() async throws {
        let pending = MemoryPendingDeletions()
        let id = UUID()
        let stores = DataStores(
            pending: pending,
            retryDelays: [.zero],
            listIds: { [id] },
            removeStore: { _ in }
        )
        pending.ids = [id]
        let left = await stores.drain()
        XCTAssertEqual(left, [id], "never counted removed while it is on disk")
        XCTAssertEqual(pending.ids, [id])
    }

    func testPendingDeletionsSurviveARestart() async throws {
        let pending = MemoryPendingDeletions()
        let id = UUID()
        pending.ids = [id]
        let stores = DataStores(pending: pending)
        XCTAssertNil(stores.store(for: id.uuidString))
        let left = await stores.drain()
        XCTAssertEqual(left, [], "an id that never reached disk is simply dropped")
    }

    func testRejectsIdsThatAreNotUUIDs() {
        let stores = DataStores(pending: MemoryPendingDeletions())
        XCTAssertThrowsError(try stores.create("default"))
        XCTAssertThrowsError(try stores.remove("../x"))
        XCTAssertNil(stores.store(for: "Default"))
    }

    func testDefaultsPendingDeletionsRoundTrip() throws {
        let suite = "DataStoresTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = DefaultsPendingDeletions(defaults: defaults)
        XCTAssertEqual(record.load(), [])
        let ids: Set<UUID> = [UUID(), UUID()]
        record.save(ids)
        XCTAssertEqual(DefaultsPendingDeletions(defaults: defaults).load(), ids)
        defaults.set(["not-a-uuid", 3], forKey: DefaultsPendingDeletions.key)
        XCTAssertEqual(record.load(), [])
    }
}
