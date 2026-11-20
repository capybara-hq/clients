// The loopback server of the hostile-page test, started by the test itself (Network.framework, on
// the loopback interface only). Origin A is http://127.0.0.1:<port>, origin B http://localhost:<port>:
// one server, told apart by the Host header. It serves apps/mobile/testpages/hostile (or the
// directory it is given), records every GET with its host, answers /redirect-oauth with an
// OAuth-shaped redirect to origin B, answers
// /redirect with a redirect to origin B, serves the sandbox-CSP pages, and collects the pages'
// reports (POST /report) and the app's gate log (POST /native-log).

import Foundation
import Network

final class HostileServer {
    let pagesDir: URL
    private(set) var port: UInt16 = 0
    private let listener: NWListener
    private let queue = DispatchQueue(label: "hostile-server")
    private var reports: [[String: Any]] = []
    private var nativeLog: [[String: Any]] = []
    private var waiters: [(doc: String, fire: () -> Void)] = []
    private var nativeWaiters: [(match: ([String: Any]) -> Bool, fire: () -> Void)] = []
    private var requests: [String] = []

    init(pagesDir: URL) throws {
        self.pagesDir = pagesDir
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: queue)
        ready.wait()
        guard let port = listener.port?.rawValue else { throw URLError(.cannotConnectToHost) }
        self.port = port
    }

    deinit { listener.cancel() }

    var originA: String { "http://127.0.0.1:\(port)" }
    var originB: String { "http://localhost:\(port)" }

    func snapshot() -> (reports: [[String: Any]], nativeLog: [[String: Any]]) {
        queue.sync { (reports, nativeLog) }
    }

    /// Every GET so far, as "<host> <path with query>".
    func requestLog() -> [String] {
        queue.sync { requests }
    }

    /// Calls `fire` once a native log entry matches (at once if one already has).
    func onNative(_ match: @escaping ([String: Any]) -> Bool, fire: @escaping () -> Void) {
        queue.async {
            if self.nativeLog.contains(where: match) {
                fire()
            } else {
                self.nativeWaiters.append((match, fire))
            }
        }
    }

    /// Calls `fire` once a report for `doc` arrives (at once if one already has).
    func onReport(doc: String, fire: @escaping () -> Void) {
        queue.async {
            if self.reports.contains(where: { $0["doc"] as? String == doc }) {
                fire()
            } else {
                self.waiters.append((doc, fire))
            }
        }
    }

    // MARK: HTTP

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Request(buffer) {
                self.respond(connection, request)
            } else if done || error != nil {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private struct Request {
        let method: String
        let path: String
        let host: String
        let body: Data

        init?(_ data: Data) {
            guard let end = data.range(of: Data("\r\n\r\n".utf8)),
                  let head = String(data: data[..<end.lowerBound], encoding: .utf8)
            else { return nil }
            let lines = head.components(separatedBy: "\r\n")
            let parts = lines.first?.split(separator: " ") ?? []
            guard parts.count >= 2 else { return nil }
            var length = 0
            var host = "?"
            for line in lines.dropFirst() {
                let pair = line.split(separator: ":", maxSplits: 1)
                if pair.count == 2, pair[0].lowercased() == "content-length" {
                    length = Int(pair[1].trimmingCharacters(in: .whitespaces)) ?? 0
                }
                if pair.count == 2, pair[0].lowercased() == "host" {
                    host = pair[1].trimmingCharacters(in: .whitespaces)
                }
            }
            let body = data[end.upperBound...]
            guard body.count >= length else { return nil }
            method = String(parts[0])
            path = String(parts[1])
            self.host = host
            self.body = Data(body.prefix(length))
        }
    }

    private func respond(_ connection: NWConnection, _ request: Request) {
        let path = String(request.path.split(separator: "?", maxSplits: 1).first ?? "/")
        if request.method == "GET" { requests.append("\(request.host) \(request.path)") }
        var status = "200 OK"
        var headers = ["Cache-Control": "no-store", "Connection": "close",
                       "Access-Control-Allow-Origin": "*"]
        var body = Data()
        switch (request.method, path) {
        case ("POST", "/report"), ("POST", "/native-log"):
            let entry = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any]
                ?? ["unparsed": String(decoding: request.body, as: UTF8.self)]
            if path == "/report" {
                reports.append(entry)
                let doc = entry["doc"] as? String
                let due = waiters.filter { $0.doc == doc }
                waiters.removeAll { $0.doc == doc }
                due.forEach { $0.fire() }
            } else {
                nativeLog.append(entry)
                let due = nativeWaiters.filter { $0.match(entry) }
                nativeWaiters.removeAll { $0.match(entry) }
                due.forEach { $0.fire() }
            }
            status = "204 No Content"
        case ("OPTIONS", _):
            status = "204 No Content"
            headers["Access-Control-Allow-Headers"] = "content-type"
        case ("GET", "/redirect"):
            status = "302 Found"
            headers["Location"] = "\(originB)/redirected.html"
        case ("GET", "/redirect-oauth"):
            // A server redirect shaped as an OAuth authorization URL back to origin A: the policy
            // lets it leave the origin (a plain /redirect to origin B goes to the browser sheet).
            status = "302 Found"
            headers["Location"] = "\(originB)/redirected.html?response_type=code&redirect_uri=\(originA)%2Fcb"
        case ("GET", _):
            var name = path == "/" ? "top.html" : String(path.dropFirst())
            if path.hasPrefix("/plugin-ui/") {
                name = "plugin-ui.html"
            }
            if path.hasPrefix("/plugin-ui/") || path == "/csp-sandbox.html" {
                headers["Content-Security-Policy"] = "sandbox allow-scripts"
            }
            let allowed = name.range(of: "^[a-z0-9-]+\\.(html|js|json)$", options: .regularExpression) != nil
            if allowed, let text = try? String(contentsOf: pagesDir.appendingPathComponent(name), encoding: .utf8) {
                body = Data(text.replacingOccurrences(of: "__ORIGIN_A__", with: originA)
                    .replacingOccurrences(of: "__ORIGIN_B__", with: originB).utf8)
                headers["Content-Type"] = name.hasSuffix(".js") ? "text/javascript" : "text/html; charset=utf-8"
            } else {
                status = "404 Not Found"
            }
        default:
            status = "405 Method Not Allowed"
        }
        headers["Content-Length"] = String(body.count)
        var head = "HTTP/1.1 \(status)\r\n"
        for (key, value) in headers { head += "\(key): \(value)\r\n" }
        head += "\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
