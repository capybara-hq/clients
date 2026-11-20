import Network
import XCTest
@testable import App

// Native HttpGet: no redirect is followed, the body is capped, a stalled server times out, and
// a refused connection is unreachable. Served by a loopback listener the test starts.
final class HttpGetTests: XCTestCase {
    private var listener: NWListener!
    private var port: UInt16 = 0
    private var requests = [String]()
    private let lock = NSLock()

    /// path -> raw HTTP response; a missing path never answers.
    private var routes: [String: String] = [:]

    override func setUp() async throws {
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, _ in
                guard let self, let data, let text = String(data: data, encoding: .utf8) else { return }
                let path = text.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                self.lock.lock()
                self.requests.append(path)
                let reply = self.routes[path]
                self.lock.unlock()
                guard let reply else { return }
                connection.send(content: reply.data(using: .utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
        let ready = expectation(description: "listening")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.start(queue: .global())
        await fulfillment(of: [ready], timeout: 10)
        port = listener.port!.rawValue
    }

    override func tearDown() { listener.cancel() }

    private func response(_ status: String, headers: [String] = [], body: String = "") -> String {
        let head = ["HTTP/1.1 \(status)", "Content-Length: \(body.utf8.count)", "Connection: close"] + headers
        return head.joined(separator: "\r\n") + "\r\n\r\n" + body
    }

    private func get(_ path: String, getter: HttpGetter = HttpGetter()) async -> Result<HttpGetResult, HttpGetError> {
        await withCheckedContinuation { continuation in
            getter.get("http://127.0.0.1:\(port)\(path)") { continuation.resume(returning: $0) }
        }
    }

    func testReturnsStatusAndBody() async {
        routes["/ok"] = response("200 OK", body: "{\"a\":1}")
        let result = await get("/ok")
        XCTAssertEqual(try result.get(), HttpGetResult(status: 200, body: "{\"a\":1}", truncated: false))
    }

    func testARedirectIsReportedNotFollowed() async throws {
        routes["/moved"] = response("302 Found", headers: ["Location: /target"])
        routes["/target"] = response("200 OK", body: "elsewhere")
        let result = try await get("/moved").get()
        XCTAssertEqual(result.status, 302)
        lock.lock()
        let seen = requests
        lock.unlock()
        XCTAssertEqual(seen, ["/moved"])
    }

    func testTheBodyIsCutAtTheCap() async throws {
        routes["/big"] = response("200 OK", body: String(repeating: "x", count: 5000))
        let result = try await get("/big", getter: HttpGetter(maxBytes: 1000)).get()
        XCTAssertTrue(result.truncated)
        XCTAssertLessThanOrEqual(result.body.utf8.count, 1000)
    }

    func testAStalledServerTimesOut() async {
        let result = await get("/never", getter: HttpGetter(timeout: 0.5))
        XCTAssertEqual(result, .failure(.unreachable))
    }

    func testARefusedConnectionIsUnreachable() async {
        listener.cancel()
        let result = await get("/ok")
        XCTAssertEqual(result, .failure(.unreachable))
    }

    func testANonHttpUrlIsRefused() async {
        let result: Result<HttpGetResult, HttpGetError> = await withCheckedContinuation { c in
            HttpGetter().get("file:///etc/passwd") { c.resume(returning: $0) }
        }
        XCTAssertEqual(result, .failure(.invalidUrl))
    }
}
