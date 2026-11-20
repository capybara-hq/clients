// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView.

import Capacitor
import Foundation

@objc(ShellPlugin)
public class ShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellPlugin"
    public let jsName = "CapybaraHost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "reply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "event", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpGet", returnType: CAPPluginReturnPromise),
    ]

    private let http = HttpGetter()

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

extension ShellPlugin: ShellCallSink {
    func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String) {
        remember(webView)
    }

    func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall) {
        remember(webView)
        notifyListeners("call", data: call.message)
    }
}
