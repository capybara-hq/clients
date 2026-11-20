// Debug builds only: the app side of the loader UI tests (AppUITests/LoaderTests). Launched with
// `-loaderTestBase http://127.0.0.1:<p>/<page>`, the runtime opens that loopback address as its
// only profile (ShellPlugin.launchOptions), and every gate, navigation, commit, load, appearance
// and sheet event is posted to the test server's /native-log (an ephemeral session, loopback only).

#if DEBUG
import Foundation

final class LoaderTestLog: ShellGateMonitor {
    static let current: LoaderTestLog? = {
        guard let base = UserDefaults.standard.string(forKey: "loaderTestBase"),
              let url = URL(string: base), url.host == "127.0.0.1", url.scheme == "http", let port = url.port
        else { return nil }
        return LoaderTestLog(base: base, origin: "http://127.0.0.1:\(port)")
    }()

    let base: String
    let origin: String
    private let session = URLSession(configuration: .ephemeral)

    private init(base: String, origin: String) {
        self.base = base
        self.origin = origin
    }

    func profileWebView(_ webView: ProfileWebView, gate event: [String: Any]) {
        log(event)
    }

    func log(_ fields: [String: Any]) {
        var fields = fields
        fields["platform"] = "ios"
        guard JSONSerialization.isValidJSONObject(fields),
              let body = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let url = URL(string: "\(origin)/native-log")
        else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body
        session.dataTask(with: request).resume()
    }
}
#endif
