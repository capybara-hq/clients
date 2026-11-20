// Debug builds only: the app side of the hostile-page UI test (AppUITests/HostilePageTests).
// Launched with `-hostilePort <p>`, the app opens a real ProfileWebView for the profile origin
// http://127.0.0.1:<p> (the test's loopback server) on its own identified data store, answers
// `test@1.ping` with "pong", pushes one state change when the profile document says hello, and
// reports every gate decision to the server's /native-log.

#if DEBUG
import UIKit
import WebKit

final class HostileHarness: NSObject, ShellCallSink, ShellGateMonitor {
    private static var current: HostileHarness?

    private let port: Int
    private let session = URLSession(configuration: .ephemeral)
    private var webView: ProfileWebView?

    private init(port: Int) {
        self.port = port
    }

    static func startIfRequested(in controller: UIViewController) {
        let port = UserDefaults.standard.integer(forKey: "hostilePort")
        guard port > 0, current == nil else { return }
        let harness = HostileHarness(port: port)
        current = harness
        harness.start(in: controller)
    }

    private func start(in controller: UIViewController) {
        let origin = "http://127.0.0.1:\(port)"
        guard let script = ShellScript.bundled() else {
            log(["event": "harness-error", "error": "no shell script in the bundle"])
            return
        }
        // A fixed, non-default store for the test profile (R8).
        let store = WKWebsiteDataStore(forIdentifier: UUID(uuidString: "6D0C6E2B-1F4A-4C1E-9B7E-0A11E5A7E513")!)
        do {
            let view = try ProfileWebView.make(
                profileId: "hostile", profileOrigin: origin, dataStore: store, shellVersion: "0.0.0-test",
                state: [
                    "insets": ["top": 0, "right": 0, "bottom": 0, "left": 0],
                    "capabilities": ["test@1": ["ping"]],
                    "events": [String: [String]](),
                ],
                script: script)
            view.sink = self
            view.monitor = self
            view.isInspectable = true
            view.frame = controller.view.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            controller.view.addSubview(view)
            webView = view
            log(["event": "harness-start", "os": UIDevice.current.systemVersion])
            view.load(URLRequest(url: URL(string: "\(origin)/top.html")!))
        } catch {
            log(["event": "harness-error", "error": String(describing: error)])
        }
    }

    func profileWebView(_ webView: ProfileWebView, didOpenDocument docId: String) {
        webView.pushState([
            "insets": ["top": 0, "right": 0, "bottom": 7, "left": 0],
            "capabilities": ["test@1": ["ping"]],
        ])
    }

    func profileWebView(_ webView: ProfileWebView, didCall call: ShellCall) {
        let result: [String: Any] = call.key == "test@1" && call.fn == "ping"
            ? ["ok": true, "value": "pong"] : ["ok": false, "code": "failed"]
        webView.reply(callId: call.callId, result: result)
    }

    func profileWebView(_ webView: ProfileWebView, gate event: [String: Any]) {
        log(event)
    }

    private func log(_ fields: [String: Any]) {
        var fields = fields
        fields["platform"] = "ios"
        guard let body = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let url = URL(string: "http://127.0.0.1:\(port)/native-log")
        else { return }
        print("GATE \(String(decoding: body, as: UTF8.self))")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        session.dataTask(with: request).resume()
    }
}
#endif
