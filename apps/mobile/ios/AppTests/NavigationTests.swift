// The navigation policy against the vectors vitest and JUnit read too (apps/mobile/test/fixtures/
// navigation.json), and its sign-in guard against packages/shell's in-window-sign-in.json.

import XCTest
@testable import App

final class NavigationTests: XCTestCase {
    private static let mobileDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func load(_ url: URL) throws -> [[String: Any]] {
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    func testTheSharedNavigationVectors() throws {
        let vectors = try load(Self.mobileDir.appendingPathComponent("test/fixtures/navigation.json"))
        XCTAssertGreaterThan(vectors.count, 40)
        for v in vectors {
            let profile = try XCTUnwrap(v["profile"] as? [String: String])
            let got = NavigationPolicy.decide(
                url: v["url"] as? String ?? "", profileOrigin: profile["origin"] ?? "",
                base: profile["base"] ?? "", isMainFrame: v["isMainFrame"] as? Bool ?? false,
                targetBlank: v["targetBlank"] as? Bool ?? false,
                oauthReturnPending: v["oauthReturnPending"] as? Bool ?? false,
                fromProfileOrigin: v["fromProfileOrigin"] as? Bool ?? false)
            XCTAssertEqual(got.rawValue, v["expect"] as? String, v["name"] as? String ?? "?")
        }
    }

    func testTheSharedSignInVectors() throws {
        let file = Self.mobileDir.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/shell/test/fixtures/in-window-sign-in.json")
        let vectors = try load(file)
        XCTAssertGreaterThan(vectors.count, 100)
        for v in vectors {
            let method = v["method"] as? String ?? "", url = v["url"] as? String ?? ""
            let got = SignInGuard.isInWindowSignIn(method: method, url: url, base: v["base"] as? String ?? "")
            XCTAssertEqual(got, v["blocked"] as? Bool, "\(method) \(url) on \(v["base"] ?? "")")
        }
    }

    func testThePendingOauthReturn() throws {
        let profile = try XCTUnwrap(Origin(string: "https://cap.example.com"))
        let t0 = Date(timeIntervalSince1970: 1000)
        let authorize = "https://idp.example/a?response_type=code&client_id=c&state=s&redirect_uri=https%3A%2F%2Fcap.example.com%2Fcb"
        XCTAssertTrue(NavigationPolicy.isAuthorizationUrl(authorize, profileOrigin: profile))
        let started = OauthReturn.next(nil, url: authorize, decision: .allow, profileOrigin: profile, now: t0)
        XCTAssertEqual(started, OauthReturn(since: t0))
        XCTAssertEqual(OauthReturn.next(started, url: "https://idp2.example/x", decision: .allow,
                                        profileOrigin: profile, now: t0 + 5), started)
        XCTAssertNil(OauthReturn.next(started, url: "https://cap.example.com/cb?code=1", decision: .allow,
                                      profileOrigin: profile, now: t0 + 6))
        XCTAssertNil(OauthReturn.next(nil, url: authorize, decision: .sheet, profileOrigin: profile, now: t0))
        XCTAssertTrue(OauthReturn.isPending(started, now: t0 + 599))
        XCTAssertFalse(OauthReturn.isPending(started, now: t0 + 600))
    }
}
