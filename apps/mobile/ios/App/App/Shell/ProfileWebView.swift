// A profile WebView (mobile spec §5.3): a WKWebView with its own configuration, user content
// controller and data store, never Capacitor's `bridge.webView`, so no Capacitor script or handler
// exists in it. It injects the Shell environment script into the main frame at document start
// and owns the one gated endpoint (ShellMessageHandler). Accepted posts go to its `sink` (the
// ShellPlugin, which forwards them to the TypeScript runtime); replies return to the posting
// document only, and state and events go to the current document only. Popups never get a
// WebView: `window.open` and `target=_blank` are handed to `onPopup` (the browser sheet, Task 16).

import os
import UIKit
import WebKit

/// One gated call, as the runtime receives it (`ShellCallMessage` in src/runtime/protocol.ts).
struct ShellCall {
    let profileId: String
    let origin: String
    let docId: String
    /// Assigned natively, unique per WebView, so a late reply never reaches a newer document.
    let callId: String
    let key: String
    let fn: String
    let args: [Any]
    let activation: Bool

    var message: [String: Any] {
        ["profileId": profileId, "origin": origin, "docId": docId, "callId": callId, "key": key,
         "fn": fn, "args": args, "activation": activation]
    }
}

/// Receives what the gate let through. Held weakly.
protocol ShellCallSink: AnyObject {
    /// A new document of the profile origin is current (its script said hello).
    func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String)
    /// Answer with `webView.reply(callId:result:)`.
    func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall)
}

/// Observes gate decisions (accept, drop, popup), for logs and the hostile-page harness.
protocol ShellGateMonitor: AnyObject {
    func profileWebView(_ webView: ProfileWebView, gate event: [String: Any])
}

enum ProfileWebViewError: Error {
    /// R8: profile WebViews never use `WKWebsiteDataStore.default()`, which Capacitor shares.
    case defaultDataStore
    /// The profile origin is not a normalized http(s) origin.
    case badOrigin
    case badInit
}

/// The Shell environment bundle (dist/local/inject, copied into the app's public folder).
enum ShellScript {
    static func bundled(in bundle: Bundle = .main) -> String? {
        guard let url = bundle.url(forResource: "shell-environment", withExtension: "js",
                                   subdirectory: "public/inject")
        else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    /// `(function (__capybaraShellInit) { <bundle> })(<init JSON>);`
    static func wrap(bundle: String, initValues: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(initValues),
              let data = try? JSONSerialization.data(withJSONObject: initValues),
              let json = String(data: data, encoding: .utf8)
        else { return nil }
        return "(function (__capybaraShellInit) {\n\(bundle)\n})(\(json));"
    }
}

/// Forwards every delegate method it does not implement to `next`, so other code can still set
/// the WebView's delegates while the profile WebView keeps the methods it must own.
class DelegateChain: NSObject {
    weak var next: AnyObject?

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (next?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let next, next.responds(to: aSelector) { return next }
        return super.forwardingTarget(for: aSelector)
    }
}

/// Ends the current document on every main-frame commit and on a web process crash.
final class NavigationTracker: DelegateChain, WKNavigationDelegate {
    weak var owner: ProfileWebView?

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        owner?.documentEnded()
        (next as? WKNavigationDelegate)?.webView?(webView, didCommit: navigation)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        owner?.documentEnded()
        (next as? WKNavigationDelegate)?.webViewWebContentProcessDidTerminate?(webView)
    }
}

/// R14: never creates a WebView for a popup; the URL goes to `onPopup`.
final class PopupBlocker: DelegateChain, WKUIDelegate {
    weak var owner: ProfileWebView?

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let owner, let url = navigationAction.request.url {
            owner.popupRequested(url)
        }
        return nil
    }
}

final class ProfileWebView: WKWebView {
    let profileId: String
    let profileOrigin: Origin
    weak var sink: ShellCallSink?
    weak var monitor: ShellGateMonitor?
    /// Where a popup's URL goes instead of a new WebView (Task 16: the browser sheet).
    var onPopup: ((URL) -> Void)?

    private(set) var currentDocId: String?
    private let gateHandler: ShellMessageHandler
    private let tracker = NavigationTracker()
    private let popups = PopupBlocker()
    private var pending: [String: (Any?, String?) -> Void] = [:]
    private var nextCall = 0
    private static let log = Logger(subsystem: "com.capybarahq.shell", category: "gate")

    /// - Parameters:
    ///   - profileOrigin: the normalized origin (`normalizeAddress(...).origin`).
    ///   - dataStore: the profile's own store, never `.default()` (R8).
    ///   - state: the initial `insets`, `capabilities` and `events` (`registry.descriptors`).
    ///   - script: the Shell environment bundle (`ShellScript.bundled()`).
    static func make(profileId: String, profileOrigin: String, dataStore: WKWebsiteDataStore,
                     shellVersion: String, state: [String: Any], script: String) throws -> ProfileWebView {
        if dataStore === WKWebsiteDataStore.default() { throw ProfileWebViewError.defaultDataStore }
        guard let origin = Origin(string: profileOrigin), origin.serialized == profileOrigin,
              let originURL = URL(string: profileOrigin)
        else { throw ProfileWebViewError.badOrigin }
        var initValues = state
        initValues["origin"] = origin.serialized
        initValues["platform"] = "ios"
        initValues["shellVersion"] = shellVersion
        guard let source = ShellScript.wrap(bundle: script, initValues: initValues) else {
            throw ProfileWebViewError.badInit
        }
        return ProfileWebView(profileId: profileId, origin: origin, originURL: originURL,
                              dataStore: dataStore, source: source)
    }

    private init(profileId: String, origin: Origin, originURL: URL, dataStore: WKWebsiteDataStore,
                 source: String) {
        self.profileId = profileId
        self.profileOrigin = origin
        gateHandler = ShellMessageHandler(profileOrigin: originURL)
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true, in: .page))
        controller.addScriptMessageHandler(gateHandler, contentWorld: .page, name: ShellMessageHandler.name)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = dataStore
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        super.init(frame: .zero, configuration: configuration)
        gateHandler.delegate = self
        tracker.owner = self
        popups.owner = self
        super.navigationDelegate = tracker
        super.uiDelegate = popups
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("ProfileWebView is created in code")
    }

    deinit {
        for reply in pending.values { reply(nil, "gone") }
        configuration.userContentController.removeAllScriptMessageHandlers()
    }

    override var navigationDelegate: WKNavigationDelegate? {
        get { tracker.next as? WKNavigationDelegate }
        set {
            tracker.next = newValue
            // WebKit reads which methods a delegate implements when it is set.
            super.navigationDelegate = nil
            super.navigationDelegate = tracker
        }
    }

    override var uiDelegate: WKUIDelegate? {
        get { popups.next as? WKUIDelegate }
        set {
            popups.next = newValue
            super.uiDelegate = nil
            super.uiDelegate = popups
        }
    }

    // MARK: Runtime to page

    /// Answers one call of the current document; false when it is gone or unknown.
    @discardableResult
    func reply(callId: String, result: [String: Any]) -> Bool {
        guard let reply = pending.removeValue(forKey: callId) else { return false }
        reply(result, nil)
        return true
    }

    /// A `change` for the current document (insets, capabilities, events).
    func pushState(_ state: [String: Any]) {
        push(["type": "state", "state": state])
    }

    func pushEvent(key: String, event: String, payload: Any) {
        push(["type": "event", "key": key, "event": event, "payload": payload])
    }

    private func push(_ message: [String: Any]) {
        // Only a document that said hello through the gate; cleared on every main-frame commit.
        guard let docId = currentDocId, JSONSerialization.isValidJSONObject(message),
              let body = try? JSONSerialization.data(withJSONObject: message),
              let doc = try? JSONSerialization.data(withJSONObject: docId, options: .fragmentsAllowed)
        else { return }
        let js = "window.__capybaraShellReceive && window.__capybaraShellReceive("
            + "\(String(decoding: doc, as: UTF8.self)), \(String(decoding: body, as: UTF8.self)));"
        evaluateJavaScript(js, in: nil, in: .page, completionHandler: nil)
    }

    // MARK: Document lifecycle

    fileprivate func documentEnded() {
        currentDocId = nil
        let replies = pending
        pending.removeAll()
        for reply in replies.values { reply(nil, "gone") }
    }

    fileprivate func popupRequested(_ url: URL) {
        report(["event": "popup", "url": url.absoluteString])
        onPopup?(url)
    }

    private func report(_ event: [String: Any]) {
        if let monitor {
            monitor.profileWebView(self, gate: event)
        } else {
            ProfileWebView.log.info("gate \(String(describing: event), privacy: .public)")
        }
    }
}

extension ProfileWebView: ShellMessageHandlerDelegate {
    func shellMessageHandler(accepted post: ShellPost, origin: Origin, reply: @escaping (Any?, String?) -> Void) {
        switch post {
        case let .hello(docId):
            report(["event": "accept", "kind": "hello", "origin": origin.serialized])
            currentDocId = docId
            reply(true, nil)
            sink?.profileWebView(self, didOpenDocument: docId)
        case let .call(docId, pageCallId, key, fn, args, activation):
            report(["event": "accept", "kind": "call", "id": pageCallId, "origin": origin.serialized])
            guard let sink else {
                reply(["ok": false, "code": "failed"], nil)
                return
            }
            nextCall += 1
            let callId = "c\(nextCall)"
            pending[callId] = reply
            sink.profileWebView(self, didCall: ShellCall(
                profileId: profileId, origin: origin.serialized, docId: docId, callId: callId,
                key: key, fn: fn, args: args, activation: activation))
        }
    }

    func shellMessageHandler(dropped reason: String, callId: String?, isMainFrame: Bool, origin: String) {
        report(["event": "drop", "reason": reason, "id": callId ?? "", "isMainFrame": isMainFrame,
                "origin": origin])
    }
}
