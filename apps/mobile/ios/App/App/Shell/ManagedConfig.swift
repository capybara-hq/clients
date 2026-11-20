// Managed configuration (mobile spec §4.3, Decision 8): an MDM's AppConfig dictionary under
// `com.apple.configuration.managed` in the standard defaults. Native only keeps the two keys with
// their declared types; the values stay untrusted and the TypeScript runtime parses them strictly
// (src/runtime/managed.ts: https only, no userinfo, normalized).

import Capacitor
import Foundation

enum ManagedConfigValues {
    static let defaultsKey = "com.apple.configuration.managed"

    /// `presetUrl` when it is a string, `lockToPreset` when it is a boolean; nothing else.
    static func from(_ raw: [String: Any]?) -> [String: Any] {
        var out: [String: Any] = [:]
        guard let raw else { return out }
        if let url = raw["presetUrl"] as? String { out["presetUrl"] = url }
        // NSNumber bridges both booleans and numbers to Bool: only a real CFBoolean counts.
        if let lock = raw["lockToPreset"] as? NSNumber, CFGetTypeID(lock) == CFBooleanGetTypeID() {
            out["lockToPreset"] = lock.boolValue
        }
        return out
    }

    static func read(_ defaults: UserDefaults) -> [String: Any] {
        from(defaults.dictionary(forKey: defaultsKey))
    }

    /// Equality of two filtered dictionaries (the only value types are String and Bool).
    static func same(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        a["presetUrl"] as? String == b["presetUrl"] as? String
            && a["lockToPreset"] as? Bool == b["lockToPreset"] as? Bool
            && a.count == b.count
    }
}

/// Follows the managed dictionary: `UserDefaults.didChangeNotification` fires for every defaults
/// write (the app's own too), so a change is reported only when the filtered values differ.
@MainActor
final class ManagedConfigObserver {
    private let defaults: UserDefaults
    private var last: [String: Any]
    private var token: NSObjectProtocol?
    private let changed: ([String: Any]) -> Void

    init(defaults: UserDefaults = .standard, changed: @escaping ([String: Any]) -> Void) {
        self.defaults = defaults
        self.changed = changed
        last = ManagedConfigValues.read(defaults)
        token = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
    }

    var current: [String: Any] { last }

    func check() {
        let now = ManagedConfigValues.read(defaults)
        guard !ManagedConfigValues.same(now, last) else { return }
        last = now
        changed(now)
    }

    func stop() {
        if let token { NotificationCenter.default.removeObserver(token) }
        token = nil
    }
}

/// The `ManagedConfig` Capacitor plugin: `get()` and a `change` event, each `{ config }`.
public class ManagedConfigPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ManagedConfigPlugin"
    public let jsName = "ManagedConfig"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    /// Lives as long as the bridge (the app); its notification block holds only a weak self.
    @MainActor private var observer: ManagedConfigObserver?

    override public func load() {
        Task { @MainActor in
            observer = ManagedConfigObserver { [weak self] config in
                self?.notifyListeners("change", data: ["config": config])
            }
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        Task { @MainActor in
            let config = observer?.current ?? ManagedConfigValues.read(.standard)
            call.resolve(["config": config])
        }
    }
}
