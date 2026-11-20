// A profile WebView (mobile spec §5.3): a WKWebView with its own configuration, user content
// controller and data store, never Capacitor's `bridge.webView`, so no Capacitor script or handler
// exists in it. It injects the Shell environment script into the main frame at document start
// and owns the one gated endpoint (ShellMessageHandler). Accepted posts go to its `sink` (the
// ShellPlugin, which forwards them to the TypeScript runtime); replies return to the posting
// document only, and state and events go to the current document only.
//
// Navigation (Task 16, R14): every navigation passes `NavigationPolicy` (Navigation.swift) before
// WebKit starts it, server redirects included; another origin and every new window
// (`window.open`, `target=_blank`) go to `onSheet` (the browser sheet) and never load here, so
// popups never get a WebView. Main-frame load results go to the sink (`didFinish`,
// `didFailProvisional` before anything committed; a TLS failure never gets a proceed path), and
// so does every document's end. The back-forward swipe moves through the WebView's history.
//
// Sign-in (Task 17): the in-WebView sign-in routes are blocked by a content rule list compiled from
// the shell's `signInBlockRules(base)` (`installBlockRules`, before the first load) and by the
// navigation policy. The code exchange runs `ExchangeScript` with `callAsyncJavaScript` in the
// `.defaultClient` world (page scripts cannot patch its `fetch`), only while the top document is on
// the profile origin, so the session cookie lands in this WebView's data store only.

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

/// Receives what the gate let through and what the WebView's loads did. Held weakly.
protocol ShellCallSink: AnyObject {
    /// A new document of the profile origin is current (its script said hello).
    func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String)
    /// Answer with `webView.reply(callId:result:)`.
    func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall)
    /// The document that said hello ended (a main-frame commit, a new hello, the process died).
    func profileWebView(_ webView: ProfileWebView, didEndDocument docId: String)
    /// A main-frame load event (`LoadEvent` in src/runtime/host-port.ts, without profileId).
    func profileWebView(_ webView: ProfileWebView, load event: [String: Any])
}

extension ShellCallSink {
    func profileWebView(_ webView: ProfileWebView, didEndDocument docId: String) {}
    func profileWebView(_ webView: ProfileWebView, load event: [String: Any]) {}
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

/// The navigation policy, and the document and load lifecycle: ends the current document on
/// every main-frame commit and on a web process crash. The policy decision is final (a chained
/// delegate is not asked); the other callbacks are forwarded.
final class NavigationTracker: DelegateChain, WKNavigationDelegate {
    weak var owner: ProfileWebView?

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let owner, let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        // A nil target frame is a new window (`target=_blank`): it never gets one.
        let frame = navigationAction.targetFrame
        let allowed = owner.route(url, isMainFrame: frame?.isMainFrame ?? true, targetBlank: frame == nil)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        owner?.committed()
        owner?.documentEnded()
        (next as? WKNavigationDelegate)?.webView?(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        owner?.emitLoad(["type": "didFinish"])
        (next as? WKNavigationDelegate)?.webView?(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        owner?.provisionalFailure(error)
        (next as? WKNavigationDelegate)?.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        owner?.documentEnded()
        // The page went blank: load it again (iOS keeps the WebView; Android recreates it, R11).
        webView.reload()
        (next as? WKNavigationDelegate)?.webViewWebContentProcessDidTerminate?(webView)
    }
}

/// R14: never creates a WebView for a popup; the URL goes to the policy, which sends it to the
/// browser sheet.
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

/// How a failed provisional navigation is reported: cancellations (ours included) are not
/// failures; a certificate or TLS error is marked `tls` (there is no way past one).
enum LoadFailure {
    static let tlsCodes: Set<Int> = [
        NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate,
        NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot,
        NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected,
        NSURLErrorClientCertificateRequired, NSURLErrorAppTransportSecurityRequiresSecureConnection,
    ]

    /// Nil for a cancelled navigation (a policy cancel, a new navigation, a stop).
    static func event(_ error: Error) -> [String: Any]? {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorCancelled { return nil }
        // WebKitErrorFrameLoadInterruptedByPolicyChange: the policy cancelled it.
        if e.domain == "WebKitErrorDomain", e.code == 102 { return nil }
        let tls = e.domain == NSURLErrorDomain && tlsCodes.contains(e.code)
        return ["type": "didFailProvisional", "code": "\(e.domain):\(e.code)", "tls": tls]
    }
}

final class ProfileWebView: WKWebView {
    let profileId: String
    let profileOrigin: Origin
    weak var sink: ShellCallSink?
    weak var monitor: ShellGateMonitor?
    /// The deployment address (origin plus path prefix): the sign-in routes are under it.
    let base: String
    /// Where a navigation that leaves the profile goes: the browser sheet (BrowserSheet.swift).
    var onSheet: ((URL) -> Void)?
    /// A connector OAuth leave-and-return under way (NavigationPolicy).
    private var oauthReturn: OauthReturn?
    /// The origin of the main frame's last committed page (a redirect keeps it).
    private var committedOrigin: Origin?
    /// The sign-in block rules in force (`installBlockRules`).
    fileprivate var blockRuleList: WKContentRuleList?
    fileprivate var installedBlockRules: String?

    /// The main frame's last committed page is on the profile origin.
    var committedProfileOrigin: Bool { committedOrigin == profileOrigin }

    var currentDocId: String? { pushes.docId }
    private let gateHandler: ShellMessageHandler
    private let tracker = NavigationTracker()
    private let popups = PopupBlocker()
    private let pending = PendingReplies()
    private let pushes = PushQueue()
    private static let log = Logger(subsystem: "com.capybarahq.shell", category: "gate")

    /// - Parameters:
    ///   - profileOrigin: the normalized origin (`normalizeAddress(...).origin`).
    ///   - dataStore: the profile's own store, never `.default()` (R8).
    ///   - state: the initial `insets`, `capabilities` and `events` (`registry.descriptors`).
    ///   - script: the Shell environment bundle (`ShellScript.bundled()`).
    static func make(profileId: String, profileOrigin: String, dataStore: WKWebsiteDataStore,
                     shellVersion: String, state: [String: Any], script: String,
                     base: String? = nil) throws -> ProfileWebView {
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
                              dataStore: dataStore, source: source, base: base ?? origin.serialized)
    }

    private init(profileId: String, origin: Origin, originURL: URL, dataStore: WKWebsiteDataStore,
                 source: String, base: String) {
        self.profileId = profileId
        self.profileOrigin = origin
        self.base = base
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
        allowsBackForwardNavigationGestures = true
        // The native background (chrome@1) shows until the page paints and under a transparent one.
        isOpaque = false
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
        // The queues are main-actor only; a WebView is released on the main queue (this traps
        // loudly if that ever stops being true).
        let pending = pending, pushes = pushes
        MainActor.assumeIsolated {
            pending.flush("gone")
            pushes.end()
        }
        configuration.userContentController.removeAllScriptMessageHandlers()
    }

    /// R7: the window's safe area, so `env(safe-area-inset-*)` never counts native chrome that a
    /// container adds around the WebView (the strip host, Task 31). On a phone today the WebView
    /// fills the window and both are the same.
    override var safeAreaInsets: UIEdgeInsets {
        window?.safeAreaInsets ?? super.safeAreaInsets
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
        guard let reply = pending.take(callId) else { return false }
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

    /// Queued for the current document and answered to its outstanding `listen` post only.
    private func push(_ message: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(message) else { return }
        pushes.push(message)
    }

    // MARK: Document lifecycle

    fileprivate func documentEnded() {
        let ended = pushes.docId
        pushes.end()
        pending.flush("gone")
        if let ended { sink?.profileWebView(self, didEndDocument: ended) }
    }

    fileprivate func committed() {
        committedOrigin = url.flatMap { NavURL($0.absoluteString)?.origin }
        report(["event": "commit", "url": url?.absoluteString ?? ""])
    }

    fileprivate func popupRequested(_ url: URL) {
        report(["event": "popup", "url": url.absoluteString])
        _ = route(url, isMainFrame: true, targetBlank: true)
    }

    // MARK: Navigation and loading

    /// Loads the deployment's base address.
    func loadBase() {
        guard let url = URL(string: base) else { return }
        load(URLRequest(url: url))
    }

    /// Applies the policy; true when the navigation may proceed here.
    func route(_ url: URL, isMainFrame: Bool, targetBlank: Bool) -> Bool {
        let now = Date()
        let text = url.absoluteString
        let decision = NavigationPolicy.decide(
            url: text, profileOrigin: profileOrigin.serialized, base: base, isMainFrame: isMainFrame,
            targetBlank: targetBlank, oauthReturnPending: OauthReturn.isPending(oauthReturn, now: now),
            fromProfileOrigin: committedOrigin == profileOrigin)
        if isMainFrame, !targetBlank {
            oauthReturn = OauthReturn.next(oauthReturn, url: text, decision: decision,
                                           profileOrigin: profileOrigin, now: now)
        }
        report(["event": "navigation", "url": text, "decision": decision.rawValue, "isMainFrame": isMainFrame,
                "targetBlank": targetBlank])
        switch decision {
        case .allow:
            return true
        case .sheet:
            onSheet?(url)
            return false
        case .block:
            return false
        }
    }

    fileprivate func emitLoad(_ event: [String: Any]) {
        report(["event": "load", "detail": event])
        sink?.profileWebView(self, load: event)
    }

    fileprivate func provisionalFailure(_ error: Error) {
        if let event = LoadFailure.event(error) { emitLoad(event) }
    }

    /// chrome@1: the color behind the page (before it paints, under a transparent one, overscroll).
    func setBackground(_ color: UIColor) {
        backgroundColor = color
        scrollView.backgroundColor = color
        underPageBackgroundColor = color
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
            if let previous = pushes.docId, previous != docId {
                sink?.profileWebView(self, didEndDocument: previous)
            }
            pending.flush("gone")
            pushes.open(docId: docId)
            reply(true, nil)
            sink?.profileWebView(self, didOpenDocument: docId)
        case let .listen(docId):
            pushes.listen(docId: docId, reply: reply)
        case let .call(docId, pageCallId, key, fn, args, activation):
            report(["event": "accept", "kind": "call", "id": pageCallId, "origin": origin.serialized])
            guard let sink else {
                reply(["ok": false, "code": "failed"], nil)
                return
            }
            let callId = pending.add(reply)
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

// MARK: Sign-in

extension ProfileWebView {
    /// The content rule list identifier of a profile (one list per profile, replaced on change).
    static func blockRulesIdentifier(_ profileId: String) -> String { "capybara-sign-in-\(profileId)" }

    /// M9: deletes a removed profile's compiled rule list from the store.
    static func removeBlockRules(_ profileId: String, store: WKContentRuleListStore = .default(),
                                 done: @escaping (Error?) -> Void) {
        store.removeContentRuleList(forIdentifier: blockRulesIdentifier(profileId)) { error in
            DispatchQueue.main.async { done(error) }
        }
    }

    /// Compiles `json` (`blockRulesFor(base)` from the runtime) and adds it to this WebView. A list
    /// already installed with the same text is kept. `done(nil)` once it is in force.
    func installBlockRules(_ json: String, store: WKContentRuleListStore = .default(),
                           done: @escaping (Error?) -> Void) {
        if installedBlockRules == json { return done(nil) }
        store.compileContentRuleList(forIdentifier: ProfileWebView.blockRulesIdentifier(profileId),
                                     encodedContentRuleList: json) { [weak self] list, error in
            DispatchQueue.main.async {
                guard let self else { return done(ProfileWebViewError.badInit) }
                guard let list else { return done(error ?? ProfileWebViewError.badInit) }
                let controller = self.configuration.userContentController
                if let old = self.blockRuleList { controller.remove(old) }
                controller.add(list)
                self.blockRuleList = list
                self.installedBlockRules = json
                done(nil)
            }
        }
    }

    /// The top document's origin when it is the profile origin (committed there and showing a URL
    /// there now), else nil.
    var currentProfileOrigin: String? {
        let now = url.flatMap { NavURL($0.absoluteString)?.origin }
        return committedProfileOrigin && now == profileOrigin ? profileOrigin.serialized : nil
    }

    /// After a sign-in: the page again when it is on the profile origin, else the base.
    func reloadAfterSignIn() {
        if currentProfileOrigin != nil { reload() } else { loadBase() }
    }

    /// The code exchange (decision 6), or with a nil `body` the logout of an unwanted session:
    /// POSTs `body` to `url` from the top document in the
    /// `.defaultClient` world. Refused unless the top document and `url` are on the profile
    /// origin; the script checks the origin again. `done` gets `{ ok, status, hasAccount }` once:
    /// the script's answer, a refusal or the total deadline (`ExchangeScript.deadline`).
    func exchange(url target: String, body: String?, done: @escaping ([String: Any]) -> Void) {
        let failed: [String: Any] = ["ok": false, "status": 0, "hasAccount": false]
        guard currentProfileOrigin != nil, NavURL(target)?.origin == profileOrigin else { return done(failed) }
        var finished = false
        let finish: ([String: Any]) -> Void = { result in
            if finished { return }
            finished = true
            done(result)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + ExchangeScript.deadline) { finish(failed) }
        callAsyncJavaScript(ExchangeScript.source,
                            arguments: ["url": target, "body": body ?? NSNull(), "origin": profileOrigin.serialized],
                            in: nil, in: .defaultClient) { result in
            switch result {
            case .success(let value):
                finish(ExchangeScript.result(value) ?? failed)
            case .failure:
                finish(failed)
            }
        }
    }
}

/// The code exchange script: a fixed function body for `callAsyncJavaScript`, whose only inputs are
/// its arguments (`url`, `body`, `origin`), never spliced into the text. It answers only
/// `{ ok, status, hasAccount }`: the response body never leaves the script.
enum ExchangeScript {
    /// The total deadline, a little past the script's own 30 s `AbortSignal.timeout`.
    static let deadline: TimeInterval = 31

    static let source = """
    if (location.origin !== origin) return { ok: false, status: 0, hasAccount: false };
    const init = {
      method: "POST",
      headers: body === null
        ? { "X-Capybara-Csrf": "1" }
        : { "Content-Type": "application/json", "X-Capybara-Csrf": "1" },
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    };
    if (body !== null) init.body = body;
    if (typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(30000);
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, hasAccount: false };
    }
    if (!res.ok) return { ok: false, status: res.status, hasAccount: false };
    let hasAccount = false;
    try {
      const data = await res.json();
      const account = data !== null && typeof data === "object" ? data.account : null;
      hasAccount = account !== null && typeof account === "object";
    } catch (e) {}
    return { ok: true, status: res.status, hasAccount };
    """

    /// The script's answer, reduced to the three fields; nil for anything else.
    static func result(_ value: Any?) -> [String: Any]? {
        guard let r = value as? [String: Any], let ok = r["ok"] as? Bool else { return nil }
        let status = (r["status"] as? NSNumber)?.intValue ?? 0
        return ["ok": ok, "status": status, "hasAccount": (r["hasAccount"] as? Bool) ?? false]
    }
}
