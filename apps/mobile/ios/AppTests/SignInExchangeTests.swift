import AuthenticationServices
import WebKit
import XCTest
@testable import App

// The code exchange in a real profile WebView against a loopback deployment: it POSTs with the CSRF
// header from the top document in the `.defaultClient` world (a page that patched `fetch` never
// sees it), the session cookie lands in that profile's data store only, and it is refused while
// the top document is off the profile origin. Also what the browser session's completion means.
@MainActor
final class SignInExchangeTests: XCTestCase {
    private var server: TestHttpServer!
    private var tokenStatus = "200 OK"

    override func setUp() async throws {
        server = try await TestHttpServer.start { [unowned self] request in
            if request.target == "/api/v1/app-auth/token" {
                return TestHttpServer.Response(
                    status: self.tokenStatus,
                    headers: ["Content-Type: application/json", "Set-Cookie: cap_at=session-1; Path=/; HttpOnly"],
                    body: #"{"account":{"displayName":"A"},"secret":"never-crosses"}"#)
            }
            // The page patches fetch in its own world: the exchange must not run through it.
            return TestHttpServer.Response(
                headers: ["Content-Type: text/html"],
                body: "<!doctype html><script>window.fetch = function () { window.stolen = true; return Promise.reject(new Error('patched')); };</script><p>page</p>")
        }
    }

    override func tearDown() async throws { server.stop() }

    private var origin: String { "http://127.0.0.1:\(server.port)" }

    private func profileView(store: WKWebsiteDataStore) throws -> ProfileWebView {
        try ProfileWebView.make(profileId: "exchange-test", profileOrigin: origin, dataStore: store,
                                shellVersion: "0.0.0", state: ["insets": [:], "capabilities": [:], "events": [:]],
                                script: "", base: origin)
    }

    private func exchange(_ view: ProfileWebView, url: String? = nil) async -> [String: Any] {
        let body = #"{"code":"cap_ac_x","codeVerifier":"v","redirectUri":"capybara://auth/callback"}"#
        return await withCheckedContinuation { c in
            view.exchange(url: url ?? "\(origin)/api/v1/app-auth/token", body: body) { c.resume(returning: $0) }
        }
    }

    private func cookies(_ store: WKWebsiteDataStore) async -> [HTTPCookie] {
        await withCheckedContinuation { c in store.httpCookieStore.getAllCookies { c.resume(returning: $0) } }
    }

    func testTheExchangeRunsFromTheTopDocumentAndTheCookieLandsInTheProfileStore() async throws {
        let store = WKWebsiteDataStore.nonPersistent()
        let other = WKWebsiteDataStore.nonPersistent()
        let view = try profileView(store: store)
        let waiter = NavigationWaiter()
        view.navigationDelegate = waiter
        let loaded = await waiter.run { view.loadBase() }
        XCTAssertEqual(loaded, "finish")
        XCTAssertEqual(view.currentProfileOrigin, origin)

        let result = await exchange(view)
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual(result["status"] as? Int, 200)
        XCTAssertEqual(result["hasAccount"] as? Bool, true)
        XCTAssertEqual(Set(result.keys), ["ok", "status", "hasAccount"])

        let post = try XCTUnwrap(server.requests.first { $0.method == "POST" })
        XCTAssertEqual(post.target, "/api/v1/app-auth/token")
        XCTAssertEqual(post.headers["x-capybara-csrf"], "1")
        XCTAssertEqual(post.headers["content-type"], "application/json")
        XCTAssertEqual(post.body, #"{"code":"cap_ac_x","codeVerifier":"v","redirectUri":"capybara://auth/callback"}"#)

        let stolen = try await view.evaluateJavaScript("window.stolen === true")
        XCTAssertEqual(stolen as? Bool, false, "the page's patched fetch never saw the exchange")
        let mine = await cookies(store)
        XCTAssertEqual(mine.first { $0.name == "cap_at" }?.value, "session-1")
        let theirs = await cookies(other)
        XCTAssertNil(theirs.first { $0.name == "cap_at" })
    }

    func testARefusedExchangeReportsItsStatusOnly() async throws {
        tokenStatus = "400 Bad Request"
        let view = try profileView(store: .nonPersistent())
        let waiter = NavigationWaiter()
        view.navigationDelegate = waiter
        _ = await waiter.run { view.loadBase() }
        let result = await exchange(view)
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["status"] as? Int, 400)
        XCTAssertEqual(result["hasAccount"] as? Bool, false)
    }

    func testNoExchangeWhileOffTheProfileOriginOrToAnotherOrigin() async throws {
        let view = try profileView(store: .nonPersistent())
        // Nothing committed yet: no top document on the profile origin.
        XCTAssertNil(view.currentProfileOrigin)
        var result = await exchange(view)
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue(server.requests.isEmpty)

        let waiter = NavigationWaiter()
        view.navigationDelegate = waiter
        _ = await waiter.run { view.loadBase() }
        server.clear()
        result = await exchange(view, url: "http://localhost:\(server.port)/api/v1/app-auth/token")
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue(server.requests.isEmpty)
    }

    func testTheScriptAnswerIsReducedToThreeFields() {
        XCTAssertNil(ExchangeScript.result(nil))
        XCTAssertNil(ExchangeScript.result(["status": 200]))
        let r = ExchangeScript.result(["ok": true, "status": NSNumber(value: 200), "hasAccount": true, "token": "x"])
        XCTAssertEqual(r?["ok"] as? Bool, true)
        XCTAssertEqual(r?["status"] as? Int, 200)
        XCTAssertNil(r?["token"])
        XCTAssertFalse(ExchangeScript.source.contains("\\("), "the script is a fixed string")
    }

    // MARK: The browser session

    func testWhatTheSessionCompletionMeans() throws {
        let cancel = NSError(domain: ASWebAuthenticationSessionErrorDomain,
                             code: ASWebAuthenticationSessionError.canceledLogin.rawValue)
        XCTAssertEqual(try AuthSession.answer(callbackURL: nil, error: cancel, scheme: "capybara").get(), .cancelled)
        let link = try XCTUnwrap(URL(string: "capybara://auth/callback?code=c&state=s&iss=x"))
        XCTAssertEqual(try AuthSession.answer(callbackURL: link, error: nil, scheme: "capybara").get(),
                       .callback("capybara://auth/callback?code=c&state=s&iss=x"))
        let other = try XCTUnwrap(URL(string: "evil://auth/callback?code=c"))
        XCTAssertThrowsError(try AuthSession.answer(callbackURL: other, error: nil, scheme: "capybara").get())
        XCTAssertThrowsError(try AuthSession.answer(callbackURL: nil, error: nil, scheme: "capybara").get())
        let failure = NSError(domain: ASWebAuthenticationSessionErrorDomain,
                              code: ASWebAuthenticationSessionError.presentationContextInvalid.rawValue)
        XCTAssertThrowsError(try AuthSession.answer(callbackURL: nil, error: failure, scheme: "capybara").get())
        XCTAssertTrue(AuthSession.isScheme("capybara"))
        XCTAssertFalse(AuthSession.isScheme("Cap bara"))
    }

    func testAnAuthSessionRefusesABadRequest() async {
        let session = AuthSession(anchor: { ASPresentationAnchor() })
        let result: Result<AuthAnswer, AuthSessionError> = await withCheckedContinuation { c in
            session.start(url: URL(string: "file:///etc/passwd")!, scheme: "capybara") { c.resume(returning: $0) }
        }
        XCTAssertEqual(result, .failure(.invalidRequest))
    }
}
