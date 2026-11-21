import XCTest
@testable import App

/// Managed configuration: the type filter native applies, and change detection over a private
/// defaults suite (never the app's standard defaults).
@MainActor
final class ManagedConfigTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        suite = "ManagedConfigTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    func testKeepsTheTwoKeysWithTheirTypes() {
        let out = ManagedConfigValues.from([
            "presetUrl": "cap.example", "lockToPreset": true, "other": "x",
        ])
        XCTAssertEqual(out["presetUrl"] as? String, "cap.example")
        XCTAssertEqual(out["lockToPreset"] as? Bool, true)
        XCTAssertEqual(out.count, 2)
    }

    func testDropsWrongTypes() {
        let out = ManagedConfigValues.from(["presetUrl": 42, "lockToPreset": "yes"])
        XCTAssertTrue(out.isEmpty)
        // A number is not a boolean, even though NSNumber would bridge it to Bool.
        XCTAssertTrue(ManagedConfigValues.from(["lockToPreset": NSNumber(value: 1)]).isEmpty)
        XCTAssertTrue(ManagedConfigValues.from(nil).isEmpty)
    }

    func testReadsTheManagedDictionary() {
        defaults.set(["presetUrl": "https://a.example", "lockToPreset": false],
                     forKey: ManagedConfigValues.defaultsKey)
        let out = ManagedConfigValues.read(defaults)
        XCTAssertEqual(out["presetUrl"] as? String, "https://a.example")
        XCTAssertEqual(out["lockToPreset"] as? Bool, false)
    }

    func testReportsOnlyRealChanges() {
        var seen: [[String: Any]] = []
        let observer = ManagedConfigObserver(defaults: defaults) { seen.append($0) }
        defer { observer.stop() }
        observer.check()
        XCTAssertTrue(seen.isEmpty)
        defaults.set(["presetUrl": "https://a.example", "lockToPreset": true],
                     forKey: ManagedConfigValues.defaultsKey)
        observer.check()
        observer.check()
        defaults.set("unrelated", forKey: "other")
        observer.check()
        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(seen.first?["lockToPreset"] as? Bool, true)
        defaults.removeObject(forKey: ManagedConfigValues.defaultsKey)
        observer.check()
        XCTAssertEqual(seen.count, 2)
        XCTAssertTrue(seen.last?.isEmpty == true)
    }
}
