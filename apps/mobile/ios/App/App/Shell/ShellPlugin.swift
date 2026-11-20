// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView. It also carries the
// `ProfileHostPort` (Task 16): `open`, `showError`, `setAppearance`, and the `load` and
// `document` events (the document events let the runtime cancel a dead document's calls and
// push the current state to a new one).

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
        CAPPluginMethod(name: "setAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "launchOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
    ]

    private let http = HttpGetter()

    @MainActor private var host: ProfileHost?

    @MainActor private func profileHost() -> ProfileHost? {
        if let host { return host }
        guard let controller = bridge?.viewController as? CAPBridgeViewController else { return nil }
        let made = ProfileHost(controller: controller)
        made.sink = self
        #if DEBUG
        if let log = LoaderTestLog.current {
            made.monitor = log
            let present = made.sheet
            made.sheet = { url in
                log.log(["event": "sheet", "url": url.absoluteString])
                present(url)
            }
        }
        #endif
        host = made
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
              let state = call.getObject("state")
        else {
            call.reject("open needs profileId, origin, base, dataStoreId and state")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.profileHost() else { return call.reject("no profile host") }
            do {
                try host.open(ProfileHost.Spec(profileId: profileId, origin: origin, base: base,
                                               dataStoreId: dataStoreId, state: state))
                call.resolve()
            } catch {
                call.reject("\(error)")
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
