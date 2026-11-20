import Capacitor
import Foundation
import WebKit

/// The durable list of data stores whose deletion is scheduled but not done yet.
protocol PendingDeletions: AnyObject {
    func load() -> Set<UUID>
    func save(_ ids: Set<UUID>)
}

final class DefaultsPendingDeletions: PendingDeletions {
    static let key = "capybara.dataStores.pendingDeletions"
    private let defaults: UserDefaults

    init(defaults: UserDefaults) { self.defaults = defaults }

    func load() -> Set<UUID> {
        let raw = defaults.array(forKey: Self.key) ?? []
        return Set(raw.compactMap { ($0 as? String).flatMap(UUID.init(uuidString:)) })
    }

    func save(_ ids: Set<UUID>) {
        defaults.set(ids.map(\.uuidString).sorted(), forKey: Self.key)
    }
}

enum DataStoreError: Error, CustomStringConvertible {
    case invalidId(String)
    case pendingDeletion(String)

    var description: String {
        switch self {
        case .invalidId(let id): return "not a data store id (a UUID): \(id)"
        case .pendingDeletion(let id): return "data store \(id) is being deleted"
        }
    }
}

/// One `WKWebsiteDataStore(forIdentifier:)` per deployment (spec §4.3; iOS 17 minimum). A
/// deployment never gets `WKWebsiteDataStore.default()`: that is Capacitor's store, and Capacitor
/// mirrors its cookies into `HTTPCookieStorage.shared` (spike 1.2).
///
/// Deletion is deferred: WebKit refuses to remove a store while a WebView still holds it, and frees
/// it asynchronously after the WebView goes (spike 1.2: the attempt right after the WebView is
/// removed fails with "Data store is in use", the next one succeeds). So `remove` records the id
/// durably and returns; `drain` tries every recorded id with a short backoff, again on
/// `webViewReleased()` and at the next launch. A recorded id is never handed out again.
@MainActor
final class DataStores {
    static let shared = DataStores(pending: DefaultsPendingDeletions(defaults: .standard))

    /// Every store's identifier on disk (`WKWebsiteDataStore.allDataStoreIdentifiers`).
    typealias ListIds = @MainActor () async -> [UUID]
    typealias RemoveStore = @MainActor (UUID) async throws -> Void

    private let pending: PendingDeletions
    private let retryDelays: [Duration]
    private let listIds: ListIds
    private let removeStore: RemoveStore
    private var draining: Task<Set<UUID>, Never>?
    /// Stores opened in this process: one may still be written by its WebView, so it stays
    /// scheduled until a removal succeeds even while it is not on disk yet.
    private var opened: Set<UUID> = []

    /// Mode reported to TypeScript: iOS always gives each deployment its own store.
    let mode = "multi"

    init(
        pending: PendingDeletions,
        retryDelays: [Duration] = [.milliseconds(100), .milliseconds(250), .milliseconds(500),
                                   .seconds(1), .seconds(2)],
        listIds: @escaping ListIds = { await WKWebsiteDataStore.allDataStoreIdentifiers },
        removeStore: @escaping RemoveStore = { try await WKWebsiteDataStore.remove(forIdentifier: $0) }
    ) {
        self.pending = pending
        self.retryDelays = retryDelays
        self.listIds = listIds
        self.removeStore = removeStore
    }

    private func parse(_ id: String) throws -> UUID {
        guard let uuid = UUID(uuidString: id) else { throw DataStoreError.invalidId(id) }
        return uuid
    }

    /// The store a profile WebView of `id` uses, or nil when `id` is not a UUID or is being deleted.
    func store(for id: String) -> WKWebsiteDataStore? {
        guard let uuid = UUID(uuidString: id), !pending.load().contains(uuid) else { return nil }
        opened.insert(uuid)
        return WKWebsiteDataStore(forIdentifier: uuid)
    }

    /// Creates (opens) the store of a newly added deployment.
    @discardableResult
    func create(_ id: String) throws -> WKWebsiteDataStore {
        let uuid = try parse(id)
        if pending.load().contains(uuid) { throw DataStoreError.pendingDeletion(id) }
        opened.insert(uuid)
        return WKWebsiteDataStore(forIdentifier: uuid)
    }

    /// Schedules the store's deletion durably and starts trying in the background. The owner of
    /// the profile's WebView releases it and calls `webViewReleased()`.
    func remove(_ id: String) throws {
        let uuid = try parse(id)
        var ids = pending.load()
        ids.insert(uuid)
        pending.save(ids)
        Task { await self.drain() }
    }

    /// A profile WebView was released: its store may be removable now.
    func webViewReleased() {
        Task { await self.drain() }
    }

    /// Tries every scheduled deletion, retrying a store still in use with backoff. Returns the ids
    /// still pending (in use past the last retry); they are tried again later. Calls made while
    /// one runs wait for it, then run again, so an id scheduled meanwhile is tried too.
    @discardableResult
    func drain() async -> Set<UUID> {
        while let running = draining { _ = await running.value }
        let task = Task { () -> Set<UUID> in
            let left = await self.drainOnce()
            // Cleared by the task itself, before any waiter resumes, so waiters never spin on a
            // finished task.
            self.draining = nil
            return left
        }
        draining = task
        return await task.value
    }

    private func drainOnce() async -> Set<UUID> {
        let batch = pending.load()
        var left = batch
        for attempt in 0...retryDelays.count {
            if left.isEmpty { break }
            if attempt > 0 { try? await Task.sleep(for: retryDelays[attempt - 1]) }
            for uuid in left {
                do {
                    try await removeStore(uuid)
                    left.remove(uuid)
                } catch {
                    // A store that never reached disk and was not opened in this process cannot be
                    // removed and needs no removal.
                    if !opened.contains(uuid), !(await listIds()).contains(uuid) { left.remove(uuid) }
                }
            }
            // Drop only what this pass removed: an id scheduled meanwhile stays recorded.
            pending.save(pending.load().subtracting(batch.subtracting(left)))
        }
        return pending.load()
    }

    /// Clears every deployment store's data (cookies, storage, caches). Not used in multi mode by
    /// the profile store; kept for parity with Android's single mode.
    func clearAll() async {
        let skip = pending.load()
        for uuid in await listIds() where !skip.contains(uuid) {
            await WKWebsiteDataStore(forIdentifier: uuid).removeData(
                ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        }
    }
}

/// The `DataStores` Capacitor plugin: the TypeScript `DataStorePort` (src/runtime/profiles.ts).
/// Registered with one line in ShellPlugins.swift: `bridge.registerPluginInstance(DataStoresPlugin())`.
@objc(DataStoresPlugin)
public class DataStoresPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DataStoresPlugin"
    public let jsName = "DataStores"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "mode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAll", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        // Deletions scheduled before the last exit run now, before any profile WebView exists.
        Task { @MainActor in await DataStores.shared.drain() }
    }

    @objc func mode(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(["mode": DataStores.shared.mode]) }
    }

    @objc func create(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        Task { @MainActor in
            do {
                try DataStores.shared.create(id)
                call.resolve()
            } catch {
                call.reject("\(error)")
            }
        }
    }

    /// Resolves once the deletion is recorded; the store goes when its WebView is released.
    @objc func remove(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        Task { @MainActor in
            do {
                try DataStores.shared.remove(id)
                call.resolve()
            } catch {
                call.reject("\(error)")
            }
        }
    }

    @objc func clearAll(_ call: CAPPluginCall) {
        Task { @MainActor in
            await DataStores.shared.clearAll()
            call.resolve()
        }
    }
}
