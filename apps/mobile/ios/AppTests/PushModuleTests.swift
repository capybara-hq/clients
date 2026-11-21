import UserNotifications
import XCTest
@testable import App

final class PushModuleTests: XCTestCase {
    // MARK: The token

    func testTokenIsLowercaseHexOfEveryByte() {
        XCTAssertEqual(PushToken.hex(Data([0x00, 0x0A, 0xFF, 0x10, 0xAB])), "000aff10ab")
        XCTAssertEqual(PushToken.hex(Data()), "")
        let token = PushToken.hex(Data((0..<32).map { UInt8($0 * 7 & 0xFF) }))
        XCTAssertEqual(token.count, 64)
        XCTAssertEqual(token, token.lowercased())
    }

    // MARK: The payload

    /// The body the `push-apns` plugin sends: `{ aps: { alert, "thread-id", sound }, path, origin }`.
    private let remote: [AnyHashable: Any] = [
        "aps": [
            "alert": ["title": "Helper", "body": "needs your approval"],
            "thread-id": "conv-1",
            "sound": "default",
        ] as [String: Any],
        "path": "/chat/conv-1?org=o1",
        "origin": "https://cap.example",
    ]

    func testRemotePayloadGivesTheRoutingFieldsAndTheText() {
        let data = PushPayload.data(from: remote)
        XCTAssertEqual(data as NSDictionary, [
            "origin": "https://cap.example",
            "path": "/chat/conv-1?org=o1",
            "threadId": "conv-1",
            "title": "Helper",
            "body": "needs your approval",
        ] as NSDictionary)
    }

    func testRemotePayloadKeepsOnlyStrings() {
        let data = PushPayload.data(from: [
            "aps": ["alert": "plain body", "thread-id": 7] as [String: Any],
            "path": 3,
            "origin": "https://cap.example",
            "extra": "ignored",
        ])
        XCTAssertEqual(data as NSDictionary, ["origin": "https://cap.example", "body": "plain body"] as NSDictionary)
        XCTAssertTrue(PushPayload.data(from: [:]).isEmpty)
    }

    func testPresentedBannerCarriesTheRuntimeData() {
        let info = PushPayload.presentedUserInfo(["origin": "https://cap.example", "path": "/inbox", "n": 1])
        XCTAssertNil(PushPayload.presented(from: remote))
        XCTAssertEqual(PushPayload.presented(from: info) as NSDictionary?,
                       ["origin": "https://cap.example", "path": "/inbox"] as NSDictionary)
        // A tap on the banner reports the runtime's data, a tap on a remote push its payload.
        XCTAssertEqual(PushPayload.tapData(from: info) as NSDictionary,
                       ["origin": "https://cap.example", "path": "/inbox"] as NSDictionary)
        XCTAssertEqual(PushPayload.tapData(from: remote)["threadId"] as? String, "conv-1")
    }

    // MARK: Foreground presentation

    func testWillPresentFollowsTheInjectedDecision() {
        let suppress = PushCenter(decide: { _ in false })
        XCTAssertEqual(suppress.presentationOptions(for: remote), [])
        let show = PushCenter(decide: { _ in true })
        XCTAssertEqual(show.presentationOptions(for: remote), [.banner, .sound])
    }

    func testByDefaultOnlyTheRuntimesBannerShows() {
        let center = PushCenter()
        XCTAssertEqual(center.presentationOptions(for: remote), [])
        XCTAssertEqual(center.presentationOptions(for: PushPayload.presentedUserInfo(["path": "/x"])),
                       [.banner, .sound])
    }

    func testForegroundRemotePushGoesToTheRuntimeAndATapIsHeldUntilASinkAttaches() {
        let center = PushCenter()
        _ = center.presentationOptions(for: remote)
        center.tapped(remote)
        let sink = RecordingSink()
        center.sink = sink
        // The foreground push had no listener and is gone; the tap waited.
        XCTAssertEqual(sink.events.map(\.name), ["tap"])
        XCTAssertEqual(sink.events.first?.retain, true)
        XCTAssertEqual(sink.events.first?.data["path"] as? String, "/chat/conv-1?org=o1")
        _ = center.presentationOptions(for: remote)
        XCTAssertEqual(sink.events.map(\.name), ["tap", "foreground"])
        XCTAssertEqual(sink.events.last?.data["title"] as? String, "Helper")
        // The runtime's own banner is not reported again as a foreground push.
        _ = center.presentationOptions(for: PushPayload.presentedUserInfo(["path": "/x"]))
        XCTAssertEqual(sink.events.count, 2)
    }

    // MARK: The token wait

    func testTokenWaitersShareOneRegistrationAndRotationIsReported() {
        let center = PushCenter()
        var registrations = 0
        var answers: [String] = []
        center.token(register: { registrations += 1 }) { if case .success(let t) = $0 { answers.append(t) } }
        center.token(register: { registrations += 1 }) { if case .success(let t) = $0 { answers.append(t) } }
        XCTAssertEqual(registrations, 1)
        let sink = RecordingSink()
        center.sink = sink
        center.didRegister(Data([0xAB, 0x01]))
        XCTAssertEqual(answers, ["ab01", "ab01"])
        // The first token is no rotation; a later different one is.
        XCTAssertTrue(sink.events.isEmpty)
        center.token(register: { registrations += 1 }) { if case .success(let t) = $0 { answers.append(t) } }
        XCTAssertEqual(registrations, 1)
        center.didRegister(Data([0xCD]))
        XCTAssertEqual(sink.events.map(\.name), ["token"])
        XCTAssertEqual(sink.events.first?.data as NSDictionary?, ["provider": "push-apns", "token": "cd"] as NSDictionary)
    }

    func testAnExpiredWaitLeavesSoTheNextCallRegistersAgain() {
        let center = PushCenter()
        var registrations = 0
        var results: [String] = []
        let record: (Result<String, Error>) -> Void = {
            switch $0 {
            case .success(let t): results.append(t)
            case .failure: results.append("failed")
            }
        }
        let first = center.token(register: { registrations += 1 }, done: record)
        XCTAssertEqual(registrations, 1)
        center.expire(try! XCTUnwrap(first))
        XCTAssertEqual(results, ["failed"])
        // Expiring again (or after an answer) does nothing.
        center.expire(first!)
        XCTAssertEqual(results, ["failed"])
        center.token(register: { registrations += 1 }, done: record)
        XCTAssertEqual(registrations, 2)
        center.didRegister(Data([0x01]))
        XCTAssertEqual(results, ["failed", "01"])
        XCTAssertNil(center.token(register: { registrations += 1 }, done: record))
        XCTAssertEqual(registrations, 2)
    }

    func testTokenWaitersFailWhenRegistrationFails() {
        let center = PushCenter()
        var failed = 0
        center.token(register: {}) { if case .failure = $0 { failed += 1 } }
        center.didFail()
        XCTAssertEqual(failed, 1)
    }

    // MARK: Permission

    func testPermissionMapping() {
        XCTAssertEqual(PushPermission.from(.authorized), "granted")
        XCTAssertEqual(PushPermission.from(.provisional), "granted")
        XCTAssertEqual(PushPermission.from(.ephemeral), "granted")
        XCTAssertEqual(PushPermission.from(.denied), "denied")
        XCTAssertEqual(PushPermission.from(.notDetermined), "prompt")
    }

    // MARK: The profile WebView side (CapybaraHost)

    func testRegistrationDeleteUrlIsExactlyTheBasesRegistrationRoute() {
        let ok: [(String, String)] = [
            ("https://cap.example", "https://cap.example/api/v1/me/push-registrations/abc_DEF-1"),
            ("https://cap.example/capy", "https://cap.example/capy/api/v1/me/push-registrations/r1"),
            ("https://cap.example", "https://cap.example/api/v1/me/push-registrations/" + String(repeating: "a", count: 128)),
        ]
        for (base, url) in ok { XCTAssertTrue(PushRegistrationURL.accept(url, base: base), url) }
        let base = "https://cap.example/capy"
        let bad = [
            "https://cap.example/api/v1/me/push-registrations/r1",
            "https://cap.example/other/api/v1/me/push-registrations/r1",
            "https://other.example/capy/api/v1/me/push-registrations/r1",
            "http://cap.example/capy/api/v1/me/push-registrations/r1",
            "https://cap.example/capy/api/v1/me/push-registrations/",
            "https://cap.example/capy/api/v1/me/push-registrations/a/b",
            "https://cap.example/capy/api/v1/me/push-registrations/r1?x=1",
            "https://cap.example/capy/api/v1/me/push-registrations/r1#x",
            "https://cap.example/capy/api/v1/me/push-registrations/r%2F1",
            "https://cap.example/capy/api/v1/me/sessions/r1",
            "https://cap.example/capy/api/v1/me/push-registrations/" + String(repeating: "a", count: 129),
            "not a url",
        ]
        for url in bad { XCTAssertFalse(PushRegistrationURL.accept(url, base: base), url) }
    }

    func testOpenPathResolvesOnlyOnTheOrigin() {
        XCTAssertEqual(ProfileOpenPath.url(origin: "https://cap.example", path: "/chat/c1?org=o1")?.absoluteString,
                       "https://cap.example/chat/c1?org=o1")
        XCTAssertEqual(ProfileOpenPath.url(origin: "http://127.0.0.1:8080", path: "/inbox")?.absoluteString,
                       "http://127.0.0.1:8080/inbox")
        for path in ["", "chat", "//evil.example/x", "/\\evil", "/a\\b", "/" + String(repeating: "a", count: 512)] {
            XCTAssertNil(ProfileOpenPath.url(origin: "https://cap.example", path: path), path)
        }
    }
}

private final class RecordingSink: PushSink {
    var events: [(name: String, data: [String: Any], retain: Bool)] = []
    func push(event: String, data: [String: Any], retain: Bool) {
        events.append((event, data, retain))
    }
}
