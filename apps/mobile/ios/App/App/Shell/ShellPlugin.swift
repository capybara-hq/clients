// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView. It also carries the
// `ProfileHostPort` (Task 16): `open`, `showError`, `close`, `setAppearance`, and the `load` and
// `document` events (the document events let the runtime cancel a dead document's calls and
// push the current state to a new one). And the strip (Task 31): `stripState`, `navSet`, and the
// `stripChanged`, `sectionSelected` and `menuTapped` events (src/runtime/capabilities/nav.ts).

import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(ShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellPlugin"
    public let jsName = "CapybaraHost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "event", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showError", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInExchange", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentOrigin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInRevoke", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeBlockRules", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stripState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushDeleteRegistration", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentUrl", returnType: CAPPluginReturnPromise),
    ]

    private let http = HttpGetter()

    @MainActor private var host: ProfileHost?
    #if DEBUG
    /// The loader UI tests: whether the app's view takes touches (the launch splash turns them off
    /// until it is gone, and XCUITest still reports the page under it as hittable).
    private var touchable: NSKeyValueObservation?
    #endif
    @MainActor private var auth: AuthSession?

    @MainActor private func profileHost() -> ProfileHost? {
        if let host { return host }
        guard let controller = bridge?.viewController as? CAPBridgeViewController else { return nil }
        let made = ProfileHost(controller: controller)
        made.sink = self
        made.onStrip = { [weak self] visible in
            self?.notifyListeners("stripChanged", data: ["visible": visible])
        }
        made.onSection = { [weak self] id in self?.notifyListeners("sectionSelected", data: ["id": id]) }
        made.onMenu = { [weak self] in self?.notifyListeners("menuTapped", data: [:]) }
        #if DEBUG
        if let log = LoaderTestLog.current {
            #if targetEnvironment(simulator)
            DuoSwap.listen()
            #endif
            made.monitor = log
            let present = made.sheet
            made.sheet = { url in
                log.log(["event": "sheet", "url": url.absoluteString])
                present(url)
            }
            touchable = controller.view.observe(\.isUserInteractionEnabled, options: [.initial, .new]) { view, _ in
                log.log(["event": "touchable", "enabled": view.isUserInteractionEnabled])
            }
            BrowserSheet.Observer.current = BrowserSheet.Observer(log: log.log)
        }
        #endif
        host = made
        made.start()
        return made
    }

    private final class WeakView {
        weak var view: ProfileWebView?
        init(_ view: ProfileWebView) { self.view = view }
    }

    /// Profile id → its WebView, learned from the gated posts themselves.
    private var views: [String: WeakView] = [:]

    private func remember(_ webView: ProfileWebView) {
        views[webView.profileId] = WeakView(webView)
    }

    private func view(_ call: CAPPluginCall) -> ProfileWebView? {
        guard let profileId = call.getString("profileId") else { return nil }
        return views[profileId]?.view
    }

    @objc func reply(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId"), let result = call.getObject("result") else {
            call.reject("reply needs profileId, callId and result")
            return
        }
        DispatchQueue.main.async {
            self.view(call)?.reply(callId: callId, result: result)
            call.resolve()
        }
    }

    /// One GET for the address page: no redirects, a timeout and a body cap (HttpGet.swift).
    @objc func httpGet(_ call: CAPPluginCall) {
        guard let url = call.getString("url") else {
            call.reject("httpGet needs url")
            return
        }
        http.get(url) { result in
            switch result {
            case .success(let r):
                call.resolve(["status": r.status, "body": r.body, "truncated": r.truncated])
            case .failure(.certInvalid):
                call.reject("CERT_INVALID")
            case .failure(.invalidUrl):
                call.reject("invalid url")
            case .failure(.unreachable):
                call.reject("unreachable")
            }
        }
    }

    @objc func pushState(_ call: CAPPluginCall) {
        guard let state = call.getObject("state") else {
            call.reject("pushState needs profileId and state")
            return
        }
        DispatchQueue.main.async {
            self.view(call)?.pushState(state)
            call.resolve()
        }
    }

    @objc func event(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let name = call.getString("event") else {
            call.reject("event needs profileId, key and event")
            return
        }
        let payload: Any = call.getValue("payload") ?? NSNull()
        DispatchQueue.main.async {
            self.view(call)?.pushEvent(key: key, event: name, payload: payload)
            call.resolve()
        }
    }
}

extension ShellPlugin {
    @objc func open(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"), let origin = call.getString("origin"),
              let base = call.getString("base"), let dataStoreId = call.getString("dataStoreId"),
              let state = call.getObject("state"), let blockRules = call.getString("blockRules")
        else {
            call.reject("open needs profileId, origin, base, dataStoreId, state and blockRules")
            return
        }
        // A tapped push's in-app path (optional); ProfileWebView.loadEntry checks it.
        let path = call.getString("path")
        DispatchQueue.main.async {
            guard let host = self.profileHost() else { return call.reject("no profile host") }
            host.open(ProfileHost.Spec(profileId: profileId, origin: origin, base: base,
                                       dataStoreId: dataStoreId, state: state, blockRules: blockRules,
                                       path: path)) { error in
                if let error { call.reject("\(error)") } else { call.resolve() }
            }
        }
    }

    @objc func showError(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("showError needs profileId") }
        DispatchQueue.main.async {
            self.profileHost()?.showError(profileId)
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("close needs profileId") }
        DispatchQueue.main.async {
            self.profileHost()?.close(profileId)
            call.resolve()
        }
    }

    @objc func setAppearance(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"), let hex = call.getString("background"),
              let color = UIColor(shellHex: hex),
              let statusBar = call.getString("statusBar"), statusBar == "light" || statusBar == "dark"
        else {
            call.reject("setAppearance needs profileId, background #rrggbb and statusBar light|dark")
            return
        }
        DispatchQueue.main.async {
            self.profileHost()?.setAppearance(profileId, background: color, lightContent: statusBar == "light")
            #if DEBUG
            LoaderTestLog.current?.log(["event": "appearance", "background": hex, "statusBar": statusBar])
            #endif
            call.resolve()
        }
    }

    /// Debug builds only: the loopback address a UI test asks the runtime to open (or, with
    /// `testAddress`, the server the test's address page discovers).
    @objc func launchOptions(_ call: CAPPluginCall) {
        var result: [String: Any] = [:]
        #if DEBUG
        if let log = LoaderTestLog.current {
            result["testOrigin"] = log.origin
            result["testBase"] = log.base
            // `-loaderTestAddress YES`: start on the address page with an empty in-memory list.
            if UserDefaults.standard.bool(forKey: "loaderTestAddress") { result["testAddress"] = true }
        }
        #endif
        call.resolve(result)
    }

    /// `openExternal@1`: an https URL, or http (the runtime already applied the origin rule).
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = ExternalURL.parse(raw) else {
            call.reject("openExternal needs an http(s) url")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("nothing can open this URL") }
            }
        }
    }
}

// MARK: The strip (Task 31, StripHost.swift)

extension ShellPlugin {
    /// Whether the window has a strip now (StripDetector); later changes come as `stripChanged`.
    @objc func stripState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["visible": self.profileHost()?.stripVisible ?? false])
        }
    }

    /// `nav@1.set`, validated by the runtime: the sections, their badge text and the menu button.
    @objc func navSet(_ call: CAPPluginCall) {
        guard let raw = call.getObject("state"), let state = StripState(json: raw) else {
            #if DEBUG
            LoaderTestLog.current?.log(["event": "navSet", "ok": false])
            #endif
            call.reject("navSet needs a state with items, current and menu")
            return
        }
        DispatchQueue.main.async {
            #if DEBUG
            LoaderTestLog.current?.log(["event": "navSet", "ok": true, "items": state.items.map(\.id)])
            #endif
            self.profileHost()?.setStrip(state)
            call.resolve()
        }
    }
}

extension UIColor {
    /// `#rrggbb` only (what the runtime sends).
    convenience init?(shellHex hex: String) {
        guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                  blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
}

/// What native opens in the system browser: absolute http(s) URLs of at most 2048 characters.
enum ExternalURL {
    static func parse(_ raw: String) -> URL? {
        guard raw.count <= 2048, let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}

extension ShellPlugin: ShellCallSink {
    func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String) {
        remember(webView)
        notifyListeners("document", data: ["profileId": webView.profileId, "docId": docId, "state": "opened"])
    }

    func profileWebView(_ webView: ProfileWebView, didEndDocument docId: String) {
        notifyListeners("document", data: ["profileId": webView.profileId, "docId": docId, "state": "ended"])
    }

    func profileWebView(_ webView: ProfileWebView, load event: [String: Any]) {
        var data = event
        data["profileId"] = webView.profileId
        notifyListeners("load", data: data)
    }

    func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall) {
        remember(webView)
        notifyListeners("call", data: call.message)
    }
}

// MARK: Sign-in (Task 17, src/runtime/sign-in.ts)

extension ShellPlugin {
    /// The brand's URL scheme (Info.plist `CFBundleURLTypes`, from Brand.xcconfig).
    static var brandScheme: String? {
        let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
        return (types?.first?["CFBundleURLSchemes"] as? [String])?.first?.lowercased()
    }

    /// Shows `ASWebAuthenticationSession` on the authorize URL; resolves `{ callback }` or
    /// `{ cancelled: true }`.
    @objc func signInStart(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = ExternalURL.parse(raw), AuthSession.isAuthorizeURL(url),
              let scheme = call.getString("scheme"), scheme == ShellPlugin.brandScheme
        else {
            call.reject("signInStart needs an http(s) url and the app's scheme")
            return
        }
        DispatchQueue.main.async {
            let session = self.auth ?? AuthSession(anchor: { [weak self] in
                self?.bridge?.viewController?.view.window ?? ASPresentationAnchor()
            })
            self.auth = session
            session.start(url: url, scheme: scheme) { result in
                switch result {
                case .success(.callback(let link)): call.resolve(["callback": link])
                case .success(.cancelled): call.resolve(["cancelled": true])
                case .failure(let error): call.reject("sign-in could not start (\(error))")
                }
            }
        }
    }

    /// The code exchange in the profile WebView's top document (ProfileWebView.exchange).
    @objc func signInExchange(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"), let url = call.getString("url"),
              let body = call.getString("body")
        else {
            call.reject("signInExchange needs profileId, url and body")
            return
        }
        DispatchQueue.main.async {
            guard let view = self.profileHost()?.view(for: profileId) else { return call.reject("no profile WebView") }
            view.exchange(url: url, body: body) { call.resolve($0) }
        }
    }

    /// The logout of a session the app did not want, through the same path as the exchange.
    @objc func signInRevoke(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"), let url = call.getString("url") else {
            call.reject("signInRevoke needs profileId and url")
            return
        }
        DispatchQueue.main.async {
            guard let view = self.profileHost()?.view(for: profileId) else { return call.reject("no profile WebView") }
            view.exchange(url: url, body: nil) { _ in call.resolve() }
        }
    }

    /// M9: a removed profile's rule list goes with it (a list that is already gone is fine).
    @objc func removeBlockRules(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("removeBlockRules needs profileId") }
        DispatchQueue.main.async {
            ProfileWebView.removeBlockRules(profileId) { _ in call.resolve() }
        }
    }

    /// The profile WebView's top-level origin when it is the profile origin, else null.
    @objc func currentOrigin(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("currentOrigin needs profileId") }
        DispatchQueue.main.async {
            let origin = self.profileHost()?.view(for: profileId)?.currentProfileOrigin
            call.resolve(["origin": origin ?? NSNull()])
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("reload needs profileId") }
        DispatchQueue.main.async {
            self.profileHost()?.view(for: profileId)?.reloadAfterSignIn()
            call.resolve()
        }
    }

    /// Profile removal (src/push/connect.ts): DELETEs the profile's push registration from its page.
    /// Rejects when the profile has no WebView or `url` is not its registration URL
    /// (PushBridge.swift); `{ ok: false, status: 0 }` while its page is off the profile origin; else
    /// `{ ok, status }`.
    @objc func pushDeleteRegistration(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId"), let url = call.getString("url") else {
            return call.reject("pushDeleteRegistration needs profileId and url")
        }
        DispatchQueue.main.async {
            guard let view = self.profileHost()?.view(for: profileId) else { return call.reject("no profile WebView") }
            view.deleteRegistration(url: url) { result in
                if let result { call.resolve(result) } else { call.reject("not the profile's registration") }
            }
        }
    }

    /// `{ url }` of the profile WebView's top document while it is on the profile origin, else
    /// `{}` (a foreground push is shown unless its page is on screen).
    @objc func currentUrl(_ call: CAPPluginCall) {
        guard let profileId = call.getString("profileId") else { return call.reject("currentUrl needs profileId") }
        DispatchQueue.main.async {
            if let url = self.profileHost()?.view(for: profileId)?.currentProfileURL {
                call.resolve(["url": url])
            } else {
                call.resolve([:])
            }
        }
    }

    /// The device's name (shown on the consent page and in the session list) and the app version.
    @objc func appInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            call.resolve(["deviceName": UIDevice.current.name, "appVersion": version])
        }
    }
}
