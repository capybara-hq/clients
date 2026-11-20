import Foundation
import Network

/// A loopback HTTP/1.1 server for tests: one request per connection (`Connection: close`), every
/// request logged before it is answered, so a page that saw the answer can rely on the log.
final class TestHttpServer {
    struct Request {
        let method: String
        /// The raw request target, as the client wrote it.
        let target: String
        /// Header names lower case.
        let headers: [String: String]
        let body: String
    }

    struct Response {
        var status = "200 OK"
        var headers: [String] = []
        var body = ""
    }

    private let listener: NWListener
    private let lock = NSLock()
    private var log: [Request] = []
    private let handler: (Request) -> Response
    private(set) var port: UInt16 = 0

    private init(listener: NWListener, handler: @escaping (Request) -> Response) {
        self.listener = listener
        self.handler = handler
    }

    static func start(handler: @escaping (Request) -> Response) async throws -> TestHttpServer {
        let server = TestHttpServer(listener: try NWListener(using: .tcp, on: .any), handler: handler)
        server.listener.newConnectionHandler = { [weak server] connection in
            connection.start(queue: .global())
            server?.read(connection, buffer: Data())
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            // The handler runs on one serial queue, so the flag needs no lock.
            let queue = DispatchQueue(label: "test-http-server")
            final class Once: @unchecked Sendable { var done = false }
            let once = Once()
            server.listener.stateUpdateHandler = { state in
                if case .ready = state, !once.done {
                    once.done = true
                    continuation.resume()
                }
            }
            server.listener.start(queue: queue)
        }
        server.port = server.listener.port?.rawValue ?? 0
        return server
    }

    func stop() { listener.cancel() }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    func clear() {
        lock.lock()
        log.removeAll()
        lock.unlock()
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = TestHttpServer.parse(buffer) {
                self.lock.lock()
                self.log.append(request)
                self.lock.unlock()
                let response = self.handler(request)
                let head = ["HTTP/1.1 \(response.status)", "Content-Length: \(response.body.utf8.count)",
                            "Connection: close"] + response.headers
                let text = head.joined(separator: "\r\n") + "\r\n\r\n" + response.body
                connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in connection.cancel() })
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.read(connection, buffer: buffer)
            }
        }
    }

    /// A whole request (head and a body of its Content-Length), or nil while it is incomplete.
    private static func parse(_ data: Data) -> Request? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ", maxSplits: 2).map(String.init)
        guard start.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = data[end.upperBound...]
        guard body.count >= length else { return nil }
        return Request(method: start[0], target: start[1], headers: headers,
                       body: String(data: body.prefix(length), encoding: .utf8) ?? "")
    }
}
