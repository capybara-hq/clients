// The strip's account avatar image (nav@1 `account.avatarUrl`, StripHost.swift). The runtime only
// passes an absolute https URL, or plain http on the profile's own origin. The image is fetched
// natively: with the profile's own cookies only when the URL is on the profile's origin (an
// avatar behind the deployment's session), with no cookies anywhere else; no redirects, a time
// limit and a size cap. Anything that fails leaves the initial.

import UIKit
import WebKit

enum StripAvatar {
    static let timeout: TimeInterval = 10
    static let maxBytes = 2 * 1024 * 1024

    /// Whether the profile's cookies may go with this URL: exactly the profile's origin.
    static func sendsCookies(_ url: URL, profileOrigin: String) -> Bool {
        guard let scheme = url.scheme, let host = url.host,
              let target = Origin(scheme: scheme, host: host, port: url.port ?? 0),
              let profile = Origin(string: profileOrigin)
        else { return false }
        return target == profile
    }

    /// Whether native may load this URL at all (the runtime's rule, checked again).
    static func allowed(_ url: URL, profileOrigin: String) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": return url.host?.isEmpty == false
        case "http": return sendsCookies(url, profileOrigin: profileOrigin)
        default: return false
        }
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()

    /// Loads the image; `done` gets nil on any failure. `cookies` is the profile's store, read only
    /// when the URL is on the profile's origin.
    @MainActor static func load(_ url: URL, profileOrigin: String, cookies: WKHTTPCookieStore?,
                                done: @escaping (UIImage?) -> Void) {
        guard allowed(url, profileOrigin: profileOrigin) else { return done(nil) }
        let fetch = { (headers: [String: String]) in
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
            request.httpShouldHandleCookies = false
            request.setValue("image/*", forHTTPHeaderField: "Accept")
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            session.dataTask(with: request) { data, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                      let data, data.count <= maxBytes, let image = UIImage(data: data)
                else { return done(nil) }
                done(image)
            }.resume()
        }
        guard sendsCookies(url, profileOrigin: profileOrigin), let cookies else { return fetch([:]) }
        cookies.getAllCookies { all in
            let matching = all.filter { cookie in
                guard let host = url.host?.lowercased() else { return false }
                let domain = cookie.domain.lowercased()
                let domainOK = domain.hasPrefix(".")
                    ? host == String(domain.dropFirst()) || host.hasSuffix(domain)
                    : host == domain
                let pathOK = url.path.isEmpty ? cookie.path == "/" : url.path.hasPrefix(cookie.path)
                let secureOK = !cookie.isSecure || url.scheme?.lowercased() == "https"
                let fresh = cookie.expiresDate.map { $0 > Date() } ?? true
                return domainOK && pathOK && secureOK && fresh
            }
            fetch(HTTPCookie.requestHeaderFields(with: matching))
        }
    }
}
