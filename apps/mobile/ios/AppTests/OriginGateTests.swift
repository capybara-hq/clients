import WebKit
import XCTest
@testable import App

// The origin gate: only the main frame on exactly the profile origin (scheme, host, effective port).
final class OriginGateTests: XCTestCase {
    private let profile = URL(string: "https://a.example")!

    private func accept(_ isMainFrame: Bool, _ scheme: String, _ host: String, _ port: Int,
                        profile: URL? = nil) -> Bool {
        OriginGate.accept(isMainFrame: isMainFrame, scheme: scheme, host: host, port: port,
                          profileOrigin: profile ?? self.profile)
    }

    func testAcceptsTheMainFrameOnTheProfileOrigin() {
        XCTAssertTrue(accept(true, "https", "a.example", 0))
    }

    func testTheDefaultPortIsNormalized() {
        XCTAssertTrue(accept(true, "https", "a.example", 443))
        XCTAssertTrue(accept(true, "https", "a.example", 0, profile: URL(string: "https://a.example:443")!))
        XCTAssertTrue(accept(true, "http", "127.0.0.1", 8765, profile: URL(string: "http://127.0.0.1:8765")!))
    }

    func testRejectsASubFrameOnTheSameOrigin() {
        XCTAssertFalse(accept(false, "https", "a.example", 0))
        XCTAssertFalse(accept(false, "https", "a.example", 443))
    }

    func testRejectsAnotherPort() {
        XCTAssertFalse(accept(true, "https", "a.example", 444))
        XCTAssertFalse(accept(true, "https", "a.example", 0, profile: URL(string: "https://a.example:444")!))
    }

    func testRejectsAnotherScheme() {
        XCTAssertFalse(accept(true, "http", "a.example", 0))
        XCTAssertFalse(accept(true, "http", "a.example", 443))
        XCTAssertFalse(accept(true, "file", "", 0))
    }

    func testRejectsAHostDifferingOnlyByATrailingDot() {
        XCTAssertFalse(accept(true, "https", "a.example.", 0))
        XCTAssertFalse(accept(true, "https", "a.example", 0, profile: URL(string: "https://a.example.")!))
    }

    func testAnIdnHostIsNotItsPunycode() {
        let punycode = URL(string: "https://xn--bcher-kva.example")!
        XCTAssertTrue(accept(true, "https", "xn--bcher-kva.example", 0, profile: punycode))
        // The gate compares the frame's host as given: no IDN mapping of its own.
        XCTAssertFalse(accept(true, "https", "bücher.example", 0, profile: punycode))
        XCTAssertFalse(accept(true, "https", "b%C3%BCcher.example", 0, profile: punycode))
        // Foundation (like WHATWG URL) stores a URL's IDN host as punycode: the same origin.
        XCTAssertEqual(Origin(url: URL(string: "https://bücher.example")!)?.serialized,
                       "https://xn--bcher-kva.example")
    }

    func testRejectsAnOpaqueOrigin() {
        // WebKit reports an opaque origin (a sandboxed frame or a sandbox CSP) as empty fields.
        XCTAssertFalse(accept(true, "", "", 0))
        XCTAssertFalse(accept(false, "", "", 0))
    }

    func testRejectsASubdomainAndASuperdomain() {
        XCTAssertFalse(accept(true, "https", "b.a.example", 0))
        XCTAssertFalse(accept(true, "https", "example", 0))
    }

    func testHostCaseDoesNotMatter() {
        XCTAssertTrue(accept(true, "HTTPS", "A.Example", 443))
    }

    func testAProfileOriginWithAPathOrCredentialsIsRefused() {
        XCTAssertFalse(accept(true, "https", "a.example", 0, profile: URL(string: "https://a.example/x")!))
        XCTAssertFalse(accept(true, "https", "a.example", 0, profile: URL(string: "https://u:p@a.example")!))
    }

    func testSerializesLikeTheWhatwgOrigin() {
        XCTAssertEqual(Origin(string: "https://A.Example:443")?.serialized, "https://a.example")
        XCTAssertEqual(Origin(string: "http://127.0.0.1:8765")?.serialized, "http://127.0.0.1:8765")
        XCTAssertEqual(Origin(string: "http://[::1]:80")?.serialized, "http://[::1]")
    }
}

// The payload shape native forwards (the patterns match src/runtime/protocol.ts).
final class ShellPostTests: XCTestCase {
    private func call(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var body: [String: Any] = [
            "type": "call", "docId": "doc-1234-5678", "callId": "1", "key": "nav@1", "fn": "set",
            "args": [["visible": true]], "activation": true,
        ]
        for (k, v) in overrides { body[k] = v }
        return body
    }

    func testAcceptsAWellFormedCallAndHello() {
        guard case let .call(_, callId, key, fn, args, activation)? = ShellPost.parse(call()) else {
            return XCTFail("not parsed")
        }
        XCTAssertEqual([callId, key, fn], ["1", "nav@1", "set"])
        XCTAssertEqual(args.count, 1)
        XCTAssertTrue(activation)
        guard case .hello? = ShellPost.parse(["type": "hello", "docId": "doc-1234-5678"]) else {
            return XCTFail("hello not parsed")
        }
    }

    func testRejectsMalformedPosts() {
        let bad: [Any] = [
            "string",
            ["type": "hello"],
            call(["type": "other"]),
            call(["docId": "x"]),
            call(["key": "nav"]),
            call(["key": "a.b@1"]),
            call(["fn": "__proto__"]),
            call(["args": "x"]),
            call(["activation": 1]),
            call(["activation": "true"]),
            call(["callId": String(repeating: "a", count: 200)]),
            call(["args": [String(repeating: "a", count: 70000)]]),
        ]
        for body in bad {
            XCTAssertNil(ShellPost.parse(body), "accepted \(body)")
        }
    }
}

// R8: a profile WebView never uses the default data store, and its origin must be normalized.
final class ProfileWebViewTests: XCTestCase {
    private func make(origin: String = "https://a.example", store: WKWebsiteDataStore) throws -> ProfileWebView {
        try ProfileWebView.make(profileId: "p", profileOrigin: origin, dataStore: store, shellVersion: "1",
                                state: ["insets": ["top": 0, "right": 0, "bottom": 0, "left": 0],
                                        "capabilities": [String: [String]]()],
                                script: "")
    }

    @MainActor
    func testRefusesTheDefaultDataStore() {
        XCTAssertThrowsError(try make(store: .default()))
    }

    @MainActor
    func testRefusesAnOriginThatIsNotNormalized() {
        let store = WKWebsiteDataStore.nonPersistent()
        XCTAssertThrowsError(try make(origin: "https://A.example", store: store))
        XCTAssertThrowsError(try make(origin: "https://a.example:443", store: store))
        XCTAssertThrowsError(try make(origin: "https://a.example/", store: store))
        XCTAssertNoThrow(try make(store: store))
    }

    @MainActor
    func testHasOnlyItsOwnScriptAndHandler() throws {
        let view = try make(store: WKWebsiteDataStore.nonPersistent())
        let scripts = view.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.count, 1)
        XCTAssertTrue(scripts[0].isForMainFrameOnly)
        XCTAssertEqual(scripts[0].injectionTime, .atDocumentStart)
        XCTAssertTrue(scripts[0].source.hasPrefix("(function (__capybaraShellInit) {"))
        XCTAssertFalse(view.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
    }
}
