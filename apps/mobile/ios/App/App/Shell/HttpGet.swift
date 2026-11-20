// Native `HttpGet` (src/runtime/discovery.ts): one GET for the address page, answered to
// `fetchMeta`'s rules. It never follows a redirect (the 3xx is reported as is, so `redirect:
// "error"` holds), gives up after `timeout`, cuts the body at `maxBytes` and keeps no cookies.

import Foundation

struct HttpGetResult: Equatable {
    var status: Int
    var body: String
    var truncated: Bool
}

enum HttpGetError: Error, Equatable {
    case invalidUrl
    /// A certificate failure; the plugin rejects with a message containing `CERT_INVALID`.
    case certInvalid
    case unreachable
}

final class HttpGetter: NSObject, URLSessionDataDelegate {
    static let timeout: TimeInterval = 10
    static let maxBytes = 64 * 1024

    private let timeout: TimeInterval
    private let maxBytes: Int
    private var session: URLSession!
    private var pending: [Int: Pending] = [:]
    private let lock = NSLock()

    private final class Pending {
        var data = Data()
        var truncated = false
        var response: HTTPURLResponse?
        let done: (Result<HttpGetResult, HttpGetError>) -> Void
        init(_ done: @escaping (Result<HttpGetResult, HttpGetError>) -> Void) { self.done = done }
    }

    init(timeout: TimeInterval = HttpGetter.timeout, maxBytes: Int = HttpGetter.maxBytes) {
        self.timeout = timeout
        self.maxBytes = maxBytes
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func get(_ urlString: String, done: @escaping (Result<HttpGetResult, HttpGetError>) -> Void) {
        guard let url = URL(string: urlString), ["https", "http"].contains(url.scheme?.lowercased()) else {
            done(.failure(.invalidUrl))
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: request)
        lock.lock()
        pending[task.taskIdentifier] = Pending(done)
        lock.unlock()
        task.resume()
    }

    private func take(_ task: URLSessionTask) -> Pending? {
        lock.lock()
        defer { lock.unlock() }
        return pending.removeValue(forKey: task.taskIdentifier)
    }

    private func peek(_ task: URLSessionTask) -> Pending? {
        lock.lock()
        defer { lock.unlock() }
        return pending[task.taskIdentifier]
    }

    // A redirect is not followed: the task completes with the 3xx response itself.
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        peek(dataTask)?.response = response as? HTTPURLResponse
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let p = peek(dataTask) else { return }
        let room = maxBytes - p.data.count
        if data.count > room {
            p.data.append(data.prefix(max(room, 0)))
            p.truncated = true
            dataTask.cancel()
        } else {
            p.data.append(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let p = take(task) else { return }
        if let status = p.response?.statusCode, error == nil || p.truncated {
            p.done(.success(HttpGetResult(
                status: status, body: String(decoding: p.data, as: UTF8.self), truncated: p.truncated)))
            return
        }
        if let urlError = error as? URLError, Self.certificateCodes.contains(urlError.code) {
            p.done(.failure(.certInvalid))
        } else {
            p.done(.failure(.unreachable))
        }
    }

    private static let certificateCodes: Set<URLError.Code> = [
        .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
        .serverCertificateNotYetValid, .clientCertificateRejected, .secureConnectionFailed,
    ]
}
